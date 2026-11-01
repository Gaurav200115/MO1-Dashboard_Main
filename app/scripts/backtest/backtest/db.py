"""Reading the archive, and writing results to Mongo.

Every price in PostgreSQL is integer paise and every timestamp is UTC. Both are
converted at this boundary and nowhere else, so the rest of the engine works in
rupees and IST and cannot get it half right.

The read order is section 6.9 of DATA/BACKTEST-PLAN.md. The two traps that live
in this file:

  - `option_1min.strike_offset` is a *label*, not a contract: Dhan recomputes
    what "ATM" means every minute. It is used once, to pick the strike at the
    entry minute, and never again. Everything after that reads `strike_paise`.
  - Prices are unadjusted. A split between the session the levels come from and
    the session being traded puts yesterday's prices on a different scale from
    today's, which would place every level far from the market.
"""
import datetime as dt
from collections import defaultdict

import psycopg

from .config import IST, need

PAISE = 100.0

# 7 strikes x CE/PE - a stock-day has complete option coverage only when all of
# them are marked done. See section 6.5.
OPTION_SERIES_PER_DAY = 14


def connect():
    return psycopg.connect(need("DATABASE_URL"))


def _rs(paise):
    return None if paise is None else paise / PAISE


def _ist(ts):
    return ts.astimezone(IST)


# ---------------- calendar and coverage ----------------

def trading_days(conn, start, end):
    return [r[0] for r in conn.execute(
        "SELECT d FROM trading_calendar WHERE trading_day AND d BETWEEN %s AND %s ORDER BY d",
        (start, end))]


def previous_trading_day(conn, day):
    row = conn.execute(
        "SELECT d FROM trading_calendar WHERE trading_day AND d < %s ORDER BY d DESC LIMIT 1",
        (day,)).fetchone()
    return row[0] if row else None


def option_coverage(conn, day, symbols):
    """{symbol: series_done} for `day`. A stock-day is complete at OPTION_SERIES_PER_DAY.

    Counted rather than assumed: a backtest that does not check this trades a
    thinner universe on some days and a fuller one on others, with nothing on
    the report to say so.
    """
    rows = conn.execute(
        "SELECT symbol, count(*) FROM done "
        "WHERE dataset = 'options_1min' AND d = %s AND symbol = ANY(%s) GROUP BY symbol",
        (day, list(symbols)))
    return {sym: n for sym, n in rows}


def day_gaps(conn, day, symbols):
    rows = conn.execute(
        "SELECT symbol, count(*) FROM gaps "
        "WHERE dataset = 'options_1min' AND d = %s AND symbol = ANY(%s) GROUP BY symbol",
        (day, list(symbols)))
    return {sym: n for sym, n in rows}


def option_universe(conn, day):
    """The stocks whose options were downloaded for `day`'s month (section 6.3).

    Read from `liquidity_rank`, never from a fixed list: the selection is made
    monthly on the 20 trading days before the month, so the tested universe
    changes under us if it is assumed.
    """
    month = day.replace(day=1)
    return [r[0] for r in conn.execute(
        "SELECT symbol FROM liquidity_rank WHERE selected AND month = %s ORDER BY rank",
        (month,))]


def lot_sizes(conn, symbols):
    rows = conn.execute(
        "SELECT symbol, lot_size, strike_step FROM stocks WHERE symbol = ANY(%s)",
        (list(symbols),))
    return {sym: {"lot_size": lot, "strike_step": float(step) if step else None}
            for sym, lot, step in rows}


# ---------------- corporate actions ----------------

def adjust_factors(conn, symbols, after, upto):
    """{symbol: factor} to multiply prices dated on or before `after` by.

    `corporate_actions.adjust_factor` is defined as "multiply prices BEFORE
    ex_date by this". The pivots and the EMA seed are built from sessions before
    the one being traded, so any action with an ex-date in (after, upto] puts
    those prices on the old scale. Several actions in the window compound.
    """
    rows = conn.execute(
        "SELECT symbol, adjust_factor FROM corporate_actions "
        "WHERE symbol = ANY(%s) AND ex_date > %s AND ex_date <= %s AND adjust_factor IS NOT NULL",
        (list(symbols), after, upto))
    out = defaultdict(lambda: 1.0)
    for sym, factor in rows:
        f = float(factor)
        if f > 0:
            out[sym] *= f
    return out


# ---------------- levels ----------------

def session_ohlc(conn, session, symbols):
    """{symbol: (high, low, close)} from the NSE equity bhavcopy, in rupees.

    `close_paise` is NSE's official close after the closing auction - the same
    number the live overnight scan uses.
    """
    rows = conn.execute(
        "SELECT symbol, high_paise, low_paise, close_paise FROM cm_bhavcopy "
        "WHERE trade_date = %s AND series = 'EQ' AND symbol = ANY(%s)",
        (session, list(symbols)))
    out = {}
    for sym, high, low, close in rows:
        if None in (high, low, close):
            continue
        out[sym] = (_rs(high), _rs(low), _rs(close))
    return out


def levels_expiry(conn, session, symbol):
    """The expiry the overnight scan reads: nearest **strictly after** the session.

    Strictly after, not on. lib/eod/chain.ts nearestExpiry says why: a scan
    running the evening of expiry day would otherwise read a chain that has
    already settled. This is a different question from which contract a trade
    buys - see `entry_expiry`, which is the nearest expiry on or after the
    trading day and so still includes the one expiring that day.
    """
    row = conn.execute(
        "SELECT min(expiry_date) FROM fo_bhavcopy "
        "WHERE trade_date = %s AND symbol = %s AND instrument = 'OPTSTK' AND expiry_date > %s",
        (session, symbol, session)).fetchone()
    return row[0] if row and row[0] else None


def option_chain(conn, session, symbol, expiry):
    """{strike_rs: {"CE": oi, "PE": oi}} for one expiry, from that session's F&O bhavcopy.

    `open_interest` is in shares. The confluence test compares call OI against
    put OI, so the unit cancels.
    """
    rows = conn.execute(
        "SELECT strike_paise, option_type, open_interest FROM fo_bhavcopy "
        "WHERE trade_date = %s AND symbol = %s AND instrument = 'OPTSTK' AND expiry_date = %s",
        (session, symbol, expiry))
    chain = defaultdict(dict)
    for strike, opt_type, oi in rows:
        if opt_type in ("CE", "PE"):
            chain[_rs(strike)][opt_type] = float(oi or 0)
    return dict(chain)


def chain_max_oi(conn, session, symbol, expiry, option_type):
    """The heaviest strike's open interest in the same chain, on the same side.

    The denominator of the live gate's `minStrikeOiShare` test - reproduced
    exactly, on the same numbers.
    """
    row = conn.execute(
        "SELECT max(open_interest) FROM fo_bhavcopy "
        "WHERE trade_date = %s AND symbol = %s AND instrument = 'OPTSTK' "
        "AND expiry_date = %s AND option_type = %s",
        (session, symbol, expiry, option_type)).fetchone()
    return float(row[0]) if row and row[0] else None


def strike_day_stats(conn, session, symbol, expiry, strike_rs, option_type):
    """That strike's own end-of-day open interest and contracts traded."""
    row = conn.execute(
        "SELECT open_interest, contracts FROM fo_bhavcopy "
        "WHERE trade_date = %s AND symbol = %s AND instrument = 'OPTSTK' "
        "AND expiry_date = %s AND strike_paise = %s AND option_type = %s",
        (session, symbol, expiry, round(strike_rs * PAISE), option_type)).fetchone()
    if not row:
        return {"open_interest": None, "contracts": None}
    return {"open_interest": float(row[0]) if row[0] is not None else None,
            "contracts": float(row[1]) if row[1] is not None else None}


def liquidity_row(conn, day, symbol):
    """The stock's own monthly liquidity, for the gate's weakest proxy."""
    row = conn.execute(
        "SELECT turnover_median, atm_oi_lots FROM liquidity_rank WHERE month = %s AND symbol = %s",
        (day.replace(day=1), symbol)).fetchone()
    if not row:
        return {"turnover_median": None, "atm_oi_lots": None}
    return {"turnover_median": float(row[0]) if row[0] is not None else None,
            "atm_oi_lots": float(row[1]) if row[1] is not None else None}


# ---------------- minute data ----------------

def spot_bars(conn, day, symbols):
    """{symbol: [bar]} for one session, in rupees and IST, ordered by time.

    Minute tables hold 09:15-15:29 IST only, so a full day is at most 375 bars.
    """
    start = dt.datetime.combine(day, dt.time(0, 0), tzinfo=IST)
    end = start + dt.timedelta(days=1)
    rows = conn.execute(
        "SELECT symbol, ts, open_paise, high_paise, low_paise, close_paise, volume "
        "FROM spot_1min WHERE ts >= %s AND ts < %s AND symbol = ANY(%s) ORDER BY symbol, ts",
        (start, end, list(symbols)))
    out = defaultdict(list)
    for sym, ts, o, h, l, c, vol in rows:
        if None in (o, h, l, c):
            continue
        out[sym].append({"at": _ist(ts), "open": _rs(o), "high": _rs(h),
                         "low": _rs(l), "close": _rs(c), "volume": vol or 0})
    return dict(out)


def spot_closes(conn, days, symbol):
    """Closing prices of each session in `days`, for seeding the EMA.

    bars.ts re-seeds the EMA every morning from the last 84 settled 5-minute
    bars, which is four sessions' worth at 21 periods. Read whole sessions and
    fold them the same way the live engine does.
    """
    if not days:
        return {}
    start = dt.datetime.combine(min(days), dt.time(0, 0), tzinfo=IST)
    end = dt.datetime.combine(max(days), dt.time(0, 0), tzinfo=IST) + dt.timedelta(days=1)
    rows = conn.execute(
        "SELECT ts, close_paise FROM spot_1min "
        "WHERE symbol = %s AND ts >= %s AND ts < %s AND close_paise IS NOT NULL ORDER BY ts",
        (symbol, start, end))
    out = defaultdict(list)
    for ts, close in rows:
        at = _ist(ts)
        out[at.date()].append({"at": at, "close": _rs(close)})
    return dict(out)


def entry_expiry(conn, day, symbol):
    """The expiry a trade taken on `day` buys: nearest **on or after** the trading day.

    On or after, so the contract expiring that day still counts - which is what
    the downloader stored (EXPIRY_FLAG=MONTH, EXPIRY_CODE=1) and what the live
    desk trades. Deliberately not the same test as `levels_expiry`.
    """
    row = conn.execute(
        "SELECT min(expiry_date) FROM option_1min WHERE symbol = %s AND expiry_date >= %s",
        (symbol, day)).fetchone()
    return row[0] if row and row[0] else None


def option_day(conn, day, symbol, expiry, option_type):
    """Every minute of every strike of one contract series for one session.

    Returns (by_strike, band), where

      by_strike  {strike_rs: {minute: bar}}   the real contracts, keyed on strike_paise
      band       {minute: (low_strike, high_strike)}

    The band is read from the data itself rather than assumed to be ATM+-3 of a
    computed at-the-money. That is what lets a held position tell "this contract
    did not trade this minute" (our strike is inside the band) from "this
    contract has left the downloaded band" (outside it) - section 6.2.
    """
    start = dt.datetime.combine(day, dt.time(0, 0), tzinfo=IST)
    end = start + dt.timedelta(days=1)
    rows = conn.execute(
        "SELECT ts, strike_paise, strike_offset, open_paise, high_paise, low_paise, "
        "       close_paise, volume, spot_paise "
        "FROM option_1min WHERE symbol = %s AND expiry_date = %s AND option_type = %s "
        "AND ts >= %s AND ts < %s ORDER BY ts, strike_paise",
        (symbol, expiry, option_type, start, end))

    by_strike = defaultdict(dict)
    band = {}
    for ts, strike, offset, o, h, l, c, vol, spot in rows:
        at = _ist(ts)
        strike_rs = _rs(strike)
        if None not in (o, h, l, c):
            by_strike[strike_rs][at] = {
                "at": at, "strike": strike_rs, "offset": offset,
                "open": _rs(o), "high": _rs(h), "low": _rs(l), "close": _rs(c),
                "volume": vol or 0, "spot": _rs(spot)}
        low, high = band.get(at, (strike_rs, strike_rs))
        band[at] = (min(low, strike_rs), max(high, strike_rs))

    return dict(by_strike), band


def atm_strike_at(by_strike, band, minute):
    """The strike to buy at the entry minute: offset 0, the at-the-money one *that* minute.

    The only place `strike_offset` is allowed to be read. After this the trade is
    locked onto its `strike_paise` - reading the offset again would follow a
    series that jumps contracts every time spot crosses a strike boundary, and
    produce a plausible-looking P&L that is meaningless.
    """
    candidates = [(strike, bars[minute]) for strike, bars in by_strike.items() if minute in bars]
    if not candidates:
        return None
    for strike, bar in candidates:
        if bar["offset"] == 0:
            return strike, bar
    # No offset-0 row this minute: fall back to the strike nearest the underlying
    # that minute, which is the same question the offset answers.
    spot = next((b["spot"] for _, b in candidates if b["spot"]), None)
    if spot is None:
        return None
    strike, bar = min(candidates, key=lambda kv: abs(kv[0] - spot))
    return strike, bar


def archive_coverage(conn):
    """What the archive holds, for the dashboard to show beside the date pickers.

    The dashboard has no reach into PostgreSQL, so it cannot answer this for
    itself - the worker publishes it to Mongo instead. Without it a range can be
    picked that the archive simply does not cover, and the run comes back empty
    with nothing on screen to say why.

    Option minute data is the binding constraint: spot and the NSE files cover
    all ~200 stocks, options only the ~100 most liquid, chosen afresh each month.
    """
    out = {"options": None, "spot": None, "months": []}

    row = conn.execute(
        "SELECT count(DISTINCT symbol), min(ts)::date, max(ts)::date FROM option_1min").fetchone()
    if row and row[0]:
        out["options"] = {"stocks": row[0], "from": str(row[1]), "to": str(row[2])}

    row = conn.execute(
        "SELECT count(DISTINCT symbol), min(ts)::date, max(ts)::date FROM spot_1min").fetchone()
    if row and row[0]:
        out["spot"] = {"symbols": row[0], "from": str(row[1]), "to": str(row[2])}

    for month, days, symbols in conn.execute(
            "SELECT date_trunc('month', d)::date, count(*), count(DISTINCT symbol) FROM ("
            "  SELECT symbol, d FROM done WHERE dataset = 'options_1min' "
            "  GROUP BY symbol, d HAVING count(*) >= %s) x "
            "GROUP BY 1 ORDER BY 1", (OPTION_SERIES_PER_DAY,)):
        out["months"].append({"month": str(month), "stockDays": days, "stocks": symbols})

    return out
