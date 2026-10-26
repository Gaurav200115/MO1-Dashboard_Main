"""Which stocks get options each month: the OPTION_STOCKS most liquid, ranked point-in-time.

For month M, the ranking uses the RANK_DAYS trading days before M's first trading day (about the
previous month), so it only knows what was known at the time - no look-ahead. Per stock and day:
  turnover = NSE's turnover of the nearest monthly expiry, the 7 strikes nearest the price
  ATM OI   = open interest on those strikes, calls + puts, in lots
Score = median daily turnover; a stock needs median ATM OI >= MIN_ATM_OI_LOTS to be ranked.
Stored in liquidity_rank; a month already ranked with the same settings is not recomputed, so the
choice for a month never changes under data that is already downloaded.
"""
import datetime as dt
import statistics

import pandas as pd

from .. import db
from ..config import S
from ..context import say

BAND = 3          # ATM-3..ATM+3 - the strikes that are actually traded


def _months(days):
    return sorted({d.replace(day=1) for d in days})


def _day_scores(b):
    """One trading day's bhavcopy rows (OPTSTK, one stock) -> (turnover, atm_oi_shares) or None."""
    b = b[b.expiry_date >= b.trade_date.iloc[0]]
    if b.empty:
        return None
    b = b[b.expiry_date == b.expiry_date.min()]                     # nearest expiry (monthly for stocks)
    spot = b.underlying_paise.dropna()
    if spot.empty:
        return None
    sides = b.groupby("strike_paise").option_type.nunique()
    ladder = sorted(sides[sides == 2].index)                       # strikes listing both a call and a put
    if not ladder:
        return None
    s = spot.iloc[0]
    atm = min(range(len(ladder)), key=lambda i: abs(ladder[i] - s))
    near = set(ladder[max(0, atm - BAND): atm + BAND + 1])
    nb = b[b.strike_paise.isin(near)]
    return float(nb.turnover_rs.fillna(0).sum()), float(nb.open_interest.fillna(0).sum())


def run(ctx):
    """Fills ctx.option_days {symbol: [trading days in the range whose month selected it]}."""
    conn = ctx.conn
    params = f"{S.OPTION_STOCKS}|{S.MIN_ATM_OI_LOTS}|{S.RANK_DAYS}|{BAND}"
    if db.get_meta(conn, "liquidity_params") != params:
        conn.execute("DELETE FROM liquidity_rank")
        db.set_meta(conn, "liquidity_params", params)
        conn.commit()
    ranked = {m for (m,) in conn.execute("SELECT DISTINCT month FROM liquidity_rank")}
    allday = ctx.all_sessions
    candidates = sorted(ctx.fno)
    lot = dict(conn.execute("SELECT symbol, lot_size FROM stocks WHERE lot_size IS NOT NULL"))

    for month in _months(ctx.sessions):
        if month in ranked:
            continue
        first = min(d for d in allday if d >= month)
        before = [d for d in allday if d < first][-S.RANK_DAYS:]
        if len(before) < 5:
            say(f"liquidity: {month:%Y-%m} has only {len(before)} trading days before it on file - not ranked")
            continue
        rows = conn.execute(
            "SELECT trade_date, symbol, expiry_date, strike_paise, option_type, open_interest, turnover_rs, "
            "underlying_paise, lot_size FROM fo_bhavcopy WHERE instrument = 'OPTSTK' AND symbol = ANY(%s) "
            "AND trade_date BETWEEN %s AND %s", (candidates, before[0], before[-1])).fetchall()
        df = pd.DataFrame(rows, columns=["trade_date", "symbol", "expiry_date", "strike_paise", "option_type",
                                         "open_interest", "turnover_rs", "underlying_paise", "lot_size"])
        out = []
        for sym in candidates:
            g = df[df.symbol == sym]
            turn, oi_lots = [], []
            for _, day in g.groupby("trade_date"):
                sc = _day_scores(day)
                if sc is None:
                    continue
                size = day.lot_size.dropna()
                lots = int(size.iloc[0]) if not size.empty else lot.get(sym)
                turn.append(sc[0])
                oi_lots.append(sc[1] / lots if lots else 0.0)
            if not turn:
                out.append([month, sym, before[0], before[-1], 0, None, None, None, False, "no option data"])
                continue
            out.append([month, sym, before[0], before[-1], len(turn), round(statistics.median(turn), 2),
                        round(statistics.median(oi_lots), 1), None, False, ""])
        ok = sorted((r for r in out if r[6] is not None and r[6] >= S.MIN_ATM_OI_LOTS), key=lambda r: -r[5])
        for i, r in enumerate(ok, 1):
            r[7], r[8] = i, i <= S.OPTION_STOCKS
            r[9] = "" if r[8] else f"rank {i}, outside the top {S.OPTION_STOCKS}"
        for r in out:
            if r[6] is not None and r[6] < S.MIN_ATM_OI_LOTS:
                r[9] = f"ATM open interest {r[6]:,.0f} lots, under {S.MIN_ATM_OI_LOTS}"
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO liquidity_rank (month, symbol, ranked_from, ranked_to, days, turnover_median, "
                "atm_oi_lots, rank, selected, note) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
                "ON CONFLICT (month, symbol) DO NOTHING", out)
        conn.commit()
        sel = sum(r[8] for r in out)
        low = sum(1 for r in out if r[6] is not None and r[6] < S.MIN_ATM_OI_LOTS)
        say(f"liquidity: {month:%Y-%m} ranked on {before[0]} -> {before[-1]}: {sel} stocks selected "
            f"of {len(candidates)}, {low} under the OI floor")

    chosen = {}
    for month, sym in conn.execute("SELECT month, symbol FROM liquidity_rank WHERE selected AND month = ANY(%s)",
                                   (_months(ctx.sessions),)):
        chosen.setdefault(sym, set()).add(month)
    ctx.option_days = {sym: [d for d in ctx.sessions if d.replace(day=1) in months]
                       for sym, months in chosen.items()}
    this_month = max(_months(ctx.sessions))
    ctx.option_stocks_now = sum(1 for m in chosen.values() if this_month in m)
    say(f"liquidity: options for {len(ctx.option_days)} different stocks across the range, "
        f"{ctx.option_stocks_now} in {this_month:%Y-%m}")
