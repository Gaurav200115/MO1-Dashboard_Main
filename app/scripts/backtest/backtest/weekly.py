"""The weekly-pivot, 1-hour rule that holds overnight - A-WK, B-WK, C-WK. Backtest only.

As Gaurav specified it on 2026-11-19. The live rule (long v11 / short v7) with
five changes, and nothing else moved:

  1. **Weekly pivots.** Fibonacci pivots from the *previous week's* high, low
     and close (the highest high and lowest low of its sessions, the close of
     its last one), confirmed against the option chain of that last session -
     the same 1.8x skew, ATM+-8, 0.8% band and per-pivot major pick as live.
     Built once and held for the whole week.
  2. **The 21 EMA is on 1-hour bars**, anchored at 09:15 as Kite's 60-minute
     candles are (09:15, 10:15 ... 15:15). The rule is still watched minute by
     minute; only the EMA's bars are an hour long.
  3. **Only each day's top 3 stocks may enter.** Every morning each stock's
     major levels are scored on the *previous* session's option chain: the skew
     at the level's strike (dominant side over the other) and the dominant
     side's open interest in lots. Both are ranked across all levels (1 =
     strongest), the two ranks are added, and a stock scores with its better
     level. The three lowest totals may take any of A, B and C that day.
  4. **Positions are held overnight.** No 15:15 flatten; a trade runs on its
     stop and ladder across days. It is closed at 15:15 on its contract's
     expiry day (`expiry`), and no new trade is opened in the last 3 sessions
     before expiry - the archive holds only the nearest month, so next month's
     contract cannot be priced from real prints. Still at most 3 open, shared
     by all three legs; a held stock that drops out of the top 3 keeps running
     and keeps its slot.
  5. **Past the archive's ATM+-3 the option is estimated, not closed.** A held
     contract that leaves the downloaded band (or a day the stock's options
     were not downloaded at all) is priced each minute by Black-Scholes from
     the stock's own 1-minute bar, at the implied volatility of the contract's
     last real print. Stop and ladder keep working on that price. Such trades
     are marked `estimated`, and the run reports its headline with and without
     them.

Setup memory carries across the week: a break on Monday and a pullback to the
1-hour EMA on Tuesday is one setup. A setup that fires is spent for that day and
re-arms the next morning (it then needs a fresh break). Everything resets each
Monday with the new pivots.
"""
import datetime as dt
import math
from collections import defaultdict
from dataclasses import dataclass, field

from . import db
from .adr import adr_pct
from .config import IST, ist_time
from .fills import minute_band_state
from .levels import chain_window, plan_for_stock
from .position import PREMIUM_FLOOR, apply_bar, close_position
from .signals import Ema, evaluate_symbol, initial_state
from .strategies import leg_of, setup_for_leg

BOOK = "weekly-1h-top3"

# Kite's 60-minute candles start at the open, not on the clock hour.
SESSION_OPEN_MINUTE = 9 * 60 + 15
# NSE equity options settle at the close on expiry day.
EXPIRY_CLOSE = dt.time(15, 30)
# The EMA seed: emaPeriod * 4 settled bars, as bars.ts does. Seven 1-hour bars a
# session, so 84 bars is twelve sessions; eighteen leaves room for gaps.
SEED_BAR_MULTIPLE = 4
SEED_SESSIONS = 18
# For the Black-Scholes estimate. Rate: roughly the Indian 91-day T-bill.
RISK_FREE = 0.065
IV_MIN, IV_MAX = 0.01, 5.0
YEAR_SECONDS = 365.0 * 86400


def is_weekly(strategies):
    return any(s.get("book") == BOOK for s in strategies)


# ---------------- 1-hour bars ----------------

def hour_bucket(at, interval=60):
    """(date, n): the n-th `interval`-minute bar of that session, counted from 09:15.

    The date is part of the key, so the last bar of one session closes on the
    first minute of the next instead of merging with it.
    """
    minutes = at.hour * 60 + at.minute - SESSION_OPEN_MINUTE
    return at.date(), minutes // interval


def fold_hour_bars(bars, interval=60):
    """1-minute bars into closed `interval` bars: [(bucket, close)], in order."""
    out = []
    current, close = None, None
    for bar in bars:
        key = hour_bucket(bar["at"], interval)
        if current is not None and key != current:
            out.append((current, close))
        current, close = key, bar["close"]
    if current is not None:
        out.append((current, close))
    return out


class HourClock:
    """One stock's 1-hour EMA, carried across sessions.

    Unlike the 5-minute clock it is not re-seeded each morning: it runs on
    through the week, so Tuesday's EMA is Monday's carried forward - the 15:15
    bar closes on Tuesday's first minute. It is re-seeded only when a session
    was missed (the stock was out of the universe), because then its bars have
    a hole in them.
    """

    def __init__(self, period, interval, seed_closes):
        self.interval = interval
        self.ema = Ema(period)
        self.ema.seed_from(seed_closes)
        self.last_bar_close = seed_closes[-1] if seed_closes else None
        self.day = None
        self._bucket = None
        self._close = None

    @property
    def value(self):
        return self.ema.value

    def push_minute(self, bar):
        key = hour_bucket(bar["at"], self.interval)
        if self._bucket is not None and key != self._bucket:
            self.ema.push(self._close)
            self.last_bar_close = self._close
        self._bucket, self._close = key, bar["close"]
        self.day = bar["at"].date()


def _seed_closes(conn, day, prev, symbols, period, interval):
    need = period * SEED_BAR_MULTIPLE
    days = db.trading_days(conn, prev - dt.timedelta(days=40), prev)[-SEED_SESSIONS:]
    if not days:
        return {}
    factors = db.adjust_factors(conn, symbols, min(days), day)
    out = {}
    for symbol in symbols:
        by_day = db.spot_closes(conn, days, symbol)
        bars = []
        for d in sorted(by_day):
            bars.extend(fold_hour_bars(by_day[d], interval))
        factor = factors.get(symbol, 1.0)
        out[symbol] = [close * factor for _, close in bars[-need:]]
    return out


# ---------------- weekly levels ----------------

def week_start(day):
    return day - dt.timedelta(days=day.weekday())


def previous_week_sessions(conn, day):
    """The sessions of the last week before `day`'s week that had any.

    A whole week of holidays is skipped back over rather than leaving the
    following week without levels.
    """
    monday = week_start(day)
    for back in range(1, 4):
        days = db.trading_days(conn, monday - dt.timedelta(days=7 * back),
                               monday - dt.timedelta(days=7 * back - 6))
        if days:
            return days
    return []


def weekly_ohlc(by_day, factors_by_day):
    """{day: (h, l, c)} for one stock -> the week's (high, low, close), adjusted.

    None unless the week's last session is present: the close is that session's
    and nothing else stands in for it.
    """
    if not by_day:
        return None
    last = max(by_day)
    highs, lows = [], []
    for d, (h, l, c) in by_day.items():
        f = factors_by_day.get(d, 1.0)
        highs.append(h * f)
        lows.append(l * f)
    close = by_day[last][2] * factors_by_day.get(last, 1.0)
    return max(highs), min(lows), close


@dataclass
class Week:
    monday: dt.date
    sessions: list
    plans: dict = field(default_factory=lambda: defaultdict(dict))   # sid -> sym -> plan
    states: dict = field(default_factory=dict)                       # (sid, sym) -> state
    built: set = field(default_factory=set)
    built_on: dict = field(default_factory=dict)
    dropped: set = field(default_factory=set)

    @property
    def last_session(self):
        return self.sessions[-1] if self.sessions else None

    def ensure(self, conn, day, symbols, strategies):
        """Builds the week's plan for any of `symbols` not seen yet this week.

        Lazily, because the option universe is chosen per calendar month and a
        week can straddle two of them.
        """
        todo = [s for s in symbols if s not in self.built and s not in self.dropped]
        if not todo or not self.sessions:
            self.built.update(todo)
            return
        meta = db.lot_sizes(conn, todo)
        rows = db.sessions_ohlc(conn, self.sessions, todo)
        # Each session's prices onto the scale of the day being traded.
        factors = {d: db.adjust_factors(conn, todo, d, day) for d in self.sessions}
        for symbol in todo:
            self.built.add(symbol)
            self.built_on[symbol] = day
            info = meta.get(symbol)
            if not info or not info.get("lot_size"):
                continue
            ohlc = weekly_ohlc(rows.get(symbol, {}),
                               {d: factors[d].get(symbol, 1.0) for d in self.sessions})
            if ohlc is None or self.last_session not in rows.get(symbol, {}):
                continue
            expiry = db.levels_expiry(conn, self.last_session, symbol)
            if expiry is None:
                continue
            chain = chain_window(db.option_chain(conn, self.last_session, symbol, expiry), ohlc[2])
            if not chain:
                continue
            for strategy in strategies:
                plan = plan_for_stock(symbol, ohlc, chain, info["lot_size"],
                                      info.get("strike_step"), strategy["params"])
                if plan is not None:
                    self.plans[strategy["id"]][symbol] = plan
                    self.states[(strategy["id"], symbol)] = initial_state(plan)

    def drop(self, symbol):
        self.dropped.add(symbol)
        for by_symbol in self.plans.values():
            by_symbol.pop(symbol, None)
        for key in [k for k in self.states if k[1] == symbol]:
            del self.states[key]

    def planned(self, sid, symbol):
        return self.plans[sid].get(symbol)

    def next_morning(self):
        """A setup spent today re-arms tomorrow - it then needs a fresh break."""
        for state in self.states.values():
            state.trades_today = 0
            if state.phase_a == "spent":
                state.phase_a = "idle"
            if state.phase_b == "spent":
                state.phase_b = "watching"
            if state.phase_c == "spent":
                state.phase_c = "idle"


# ---------------- the daily top 3 ----------------

def level_strength(level, chain, lot_size):
    """(skew, dominant-side OI in lots) of a level's strike in one session's chain.

    A strike missing from the chain scores (0, 0): no evidence is the weakest
    evidence, not a reason to drop the stock from the ranking.
    """
    row = chain.get(level.strike) or {}
    call, put = float(row.get("CE", 0.0)), float(row.get("PE", 0.0))
    dom, other = (put, call) if level.kind == "support" else (call, put)
    skew = (math.inf if dom > 0 else 0.0) if other <= 0 else dom / other
    return skew, (dom / lot_size if lot_size else 0.0)


def competition_rank(values):
    """1 for the largest; ties share the better rank (1, 2, 2, 4)."""
    order = sorted(values, reverse=True)
    first = {}
    for i, v in enumerate(order, 1):
        first.setdefault(v, i)
    return [first[v] for v in values]


def rank_stocks(candidates, top):
    """candidates: [(symbol, pivot, skew, oi_lots)] - one row per major level.

    Returns ([symbol] best first, cut at `top`; {symbol: detail}). A stock's
    score is the lowest skew-rank + OI-rank among its levels. Ties go to the
    larger open interest, then the symbol, so the order is reproducible.
    """
    if not candidates:
        return [], {}
    skew_ranks = competition_rank([c[2] for c in candidates])
    oi_ranks = competition_rank([c[3] for c in candidates])
    best = {}
    for (symbol, pivot, skew, oi), sr, orr in zip(candidates, skew_ranks, oi_ranks):
        row = {"score": sr + orr, "skewRank": sr, "oiRank": orr, "pivot": pivot,
               "skew": None if skew == math.inf else skew, "oiLots": oi}
        current = best.get(symbol)
        if current is None or (row["score"], -row["oiLots"]) < (current["score"], -current["oiLots"]):
            best[symbol] = row
    order = sorted(best, key=lambda s: (best[s]["score"], -best[s]["oiLots"], s))
    for i, symbol in enumerate(order, 1):
        best[symbol]["rank"] = i
    return order[:top], best


def daily_ranking(conn, prev, week, sid_for_plans, symbols, top):
    """Scores every planned stock on `prev`'s chain and returns the top `top`."""
    candidates = []
    for symbol in symbols:
        plan = week.planned(sid_for_plans, symbol)
        if plan is None:
            continue
        expiry = db.levels_expiry(conn, prev, symbol)
        chain = db.option_chain(conn, prev, symbol, expiry) if expiry else {}
        for level in (plan.major_resistance, plan.major_support):
            if level is None:
                continue
            skew, oi = level_strength(level, chain, plan.lot_size)
            candidates.append((symbol, level.pivot, skew, oi))
    return rank_stocks(candidates, top)


def sessions_to_expiry(conn, day, expiry):
    """Trading sessions from `day` to `expiry`, both counted (expiry day itself is 1)."""
    if expiry is None or expiry < day:
        return 0
    days = db.trading_days(conn, day, expiry)
    # An expiry is always a trading day, so a calendar that stops short of it
    # simply has not been filled that far yet (the archive's last days). The
    # rest is counted in weekdays rather than read as "expiry is near".
    last = days[-1] if days else day - dt.timedelta(days=1)
    extra = sum(1 for i in range(1, (expiry - last).days + 1)
                if (last + dt.timedelta(days=i)).weekday() < 5)
    return len(days) + extra


# ---------------- Black-Scholes, for contracts past the archive ----------------

def _norm_cdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def bs_price(option_type, spot, strike, years, vol, rate=RISK_FREE):
    intrinsic = max(0.0, spot - strike) if option_type == "CE" else max(0.0, strike - spot)
    if years <= 0 or vol <= 0 or spot <= 0 or strike <= 0:
        return intrinsic
    sd = vol * math.sqrt(years)
    d1 = (math.log(spot / strike) + (rate + vol * vol / 2) * years) / sd
    d2 = d1 - sd
    disc = strike * math.exp(-rate * years)
    if option_type == "CE":
        return spot * _norm_cdf(d1) - disc * _norm_cdf(d2)
    return disc * _norm_cdf(-d2) - spot * _norm_cdf(-d1)


def implied_vol(option_type, price, spot, strike, years, rate=RISK_FREE):
    """Bisection on [1%, 500%]. A price under the 1% value pins to 1%, over the 500% value to 500%."""
    if not all(isinstance(v, (int, float)) and math.isfinite(v) and v > 0
               for v in (price, spot, strike, years)):
        return None
    lo, hi = IV_MIN, IV_MAX
    if price <= bs_price(option_type, spot, strike, years, lo, rate):
        return lo
    if price >= bs_price(option_type, spot, strike, years, hi, rate):
        return hi
    for _ in range(80):
        mid = (lo + hi) / 2
        if bs_price(option_type, spot, strike, years, mid, rate) < price:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def years_to_expiry(at, expiry):
    end = dt.datetime.combine(expiry, EXPIRY_CLOSE, tzinfo=IST)
    return max(60.0, (end - at).total_seconds()) / YEAR_SECONDS


def _tick(price):
    return max(PREMIUM_FLOOR, round(price / 0.05) * 0.05)


def estimate_bar(position, spot_bar, minute, vol):
    """The option's 1-minute bar, priced from the stock's. A call's high comes from
    the stock's high, a put's from the stock's low."""
    years = years_to_expiry(minute, position.expiry)
    price = {k: _tick(bs_price(position.option_type, spot_bar[k], position.strike, years, vol))
             for k in ("open", "high", "low", "close")}
    if position.option_type == "PE":
        price["high"], price["low"] = price["low"], price["high"]
    return {"at": minute, "open": price["open"], "high": max(price.values()),
            "low": min(price.values()), "close": price["close"], "estimated": True}


# ---------------- a held position, one minute ----------------

def mark(position):
    return position.context.setdefault("weekly", {})


def remember_print(position, price, spot, at):
    """The last real print and the stock price beside it - what the next estimate is fitted to."""
    if spot:
        position._real = (price, spot, at)
        position._iv = None


def step_carried(position, by_strike, band, has_data, spot_bar, minute, flatten_at, risk):
    """Advances a held position by a minute. Returns it if it closed.

    `flatten_at` is set only on the contract's expiry day. Real prints always
    win; an estimate is used only when the contract has left the downloaded band
    or the day has no option data for it at all.
    """
    if minute <= position.entry_at:
        return None

    if flatten_at is not None and minute.time() >= flatten_at:
        return close_position(position, position.last_price, position.last_at, "expiry")

    bar = by_strike.get(position.strike, {}).get(minute)
    if bar is not None:
        position.last_price, position.last_at = bar["close"], minute
        remember_print(position, bar["close"], bar.get("spot") or (spot_bar or {}).get("close"),
                       minute)
        verdict = apply_bar(position, bar, risk, minute)
        if verdict["action"] == "exit":
            return close_position(position, verdict["price"], minute, verdict["reason"])
        return None

    if has_data and minute_band_state(band, minute, position.strike) != "outside":
        return None            # inside the band but no print, or a gap: nothing to react to
    if spot_bar is None:
        return None

    vol = getattr(position, "_iv", None)
    if vol is None:
        real = getattr(position, "_real", None)
        if real is None:
            return close_position(position, position.last_price, position.last_at, "out-of-band")
        price, spot, at = real
        vol = implied_vol(position.option_type, price, spot, position.strike,
                          years_to_expiry(at, position.expiry))
        if vol is None:
            return close_position(position, position.last_price, position.last_at, "out-of-band")
        position._iv = vol

    est = estimate_bar(position, spot_bar, minute, vol)
    m = mark(position)
    m["estimated"] = True
    m["estimatedMinutes"] = m.get("estimatedMinutes", 0) + 1
    m["iv"] = round(vol, 4)
    position.last_price, position.last_at = est["close"], minute
    verdict = apply_bar(position, est, risk, minute)
    if verdict["action"] == "exit":
        m["estimatedExit"] = True
        return close_position(position, verdict["price"], minute, verdict["reason"])
    return None


# ---------------- a session ----------------

@dataclass
class Carry:
    """Everything that outlives one session: the week, the EMAs, the open book."""
    week: Week | None = None
    clocks: dict = field(default_factory=dict)
    open: list = field(default_factory=list)


def new_notes():
    return {"signals": 0, "rejected": defaultdict(int), "skipped": defaultdict(int),
            "bySetup": defaultdict(int), "symbols": 0, "incomplete": 0}


def replay_day(conn, day, strategies, floors, carry, log=None, setups=None):
    """One session of the weekly rule. Returns (positions closed today, notes).

    Positions still open at the close stay in `carry.open` for tomorrow.
    """
    from .runner import _try_fill        # runner imports this module

    notes = new_notes()
    prev = db.previous_trading_day(conn, day)
    if prev is None:
        return [], notes

    params = strategies[0]["params"]
    monday = week_start(day)
    if carry.week is None or carry.week.monday != monday:
        carry.week = Week(monday, previous_week_sessions(conn, day))
        if not carry.week.sessions:
            notes["skipped"]["no previous week to build pivots from"] += 1
    week = carry.week

    universe = db.option_universe(conn, day) or []
    if not universe:
        notes["skipped"]["no option universe for the month"] += 1
    week.ensure(conn, day, universe, strategies)

    # An ex-date inside the week puts the week's pivots on the old scale. The
    # stock sits the rest of the week out; it returns with Monday's new pivots.
    later = [s for s in universe if week.built_on.get(s) and week.built_on[s] < day
             and s not in week.dropped and any(s in p for p in week.plans.values())]
    if later:
        for symbol, factor in db.adjust_factors(conn, later, prev, day).items():
            if factor != 1.0:
                week.drop(symbol)
                notes["skipped"]["corporate action inside the week - stock sat out"] += 1

    sids = [st["id"] for st in strategies]
    symbols = sorted(s for s in universe if any(week.planned(sid, s) for sid in sids))
    notes["symbols"] = len(symbols)

    coverage = db.option_coverage(conn, day, symbols) if symbols else {}
    notes["incomplete"] = sum(1 for s in symbols if coverage.get(s, 0) < db.OPTION_SERIES_PER_DAY)

    # The day's ADR, from the 14 sessions ending on `prev`, in rupees of `prev`'s close.
    prev_close = {s: hlc[2] for s, hlc in db.session_ohlc(conn, prev, symbols).items()} if symbols else {}
    for strategy in strategies:
        p = strategy["params"]
        if p.get("entryBasis") != "adr":
            continue
        mine = [s for s in symbols if week.planned(strategy["id"], s)]
        history = db.daily_history(conn, prev, mine, p["adrPeriod"]) if mine else {}
        missing = 0
        for s in mine:
            plan = week.planned(strategy["id"], s)
            plan.adr_pct = adr_pct(history.get(s, []), p["adrPeriod"])
            plan.adr_close = prev_close.get(s)
            missing += plan.adr_pct is None
        if missing:
            notes["skipped"]["no 14-session ADR - retrace legs could not arm"] += missing

    # The top 3, scored before the open on `prev`'s chain. Both strategies share
    # one set of plans' majors (same params), so the long strategy's are read.
    top, detail = daily_ranking(conn, prev, week, sids[0], symbols, params["rankTop"])
    if not top and symbols:
        notes["skipped"]["no stock could be ranked"] += 1

    # No new trade in the last N sessions before the contract's expiry.
    expiry_of = {s: db.entry_expiry(conn, day, s) for s in top}
    window = params["noEntrySessionsBeforeExpiry"]
    near_expiry = {s for s in top if expiry_of[s] is None
                   or sessions_to_expiry(conn, day, expiry_of[s]) <= window}
    if near_expiry:
        notes["skipped"][f"top-3 stock-days in the last {window} sessions before expiry"] += len(near_expiry)
    may_enter = set(top) - near_expiry

    held = {p.symbol for p in carry.open}
    bars = db.spot_bars(conn, day, sorted(set(symbols) | held))
    bar_at = {s: {b["at"]: b for b in rows} for s, rows in bars.items()}

    period, interval = params["emaPeriod"], params["emaIntervalMinutes"]
    stale = [s for s in symbols if bars.get(s) and
             (s not in carry.clocks or carry.clocks[s].day != prev)]
    if stale:
        seeds = _seed_closes(conn, day, prev, stale, period, interval)
        for s in stale:
            carry.clocks[s] = HourClock(period, interval, seeds.get(s, []))
    live = [s for s in symbols if bars.get(s)]

    # Option data: the held contracts, then whatever a signal asks for.
    option_cache = {}
    expiry_cache = {}
    gate_cache = {}

    def option_data(symbol, side):
        key = (symbol, side)
        if key not in option_cache:
            if symbol not in expiry_cache:
                expiry_cache[symbol] = db.entry_expiry(conn, day, symbol)
            expiry = expiry_cache[symbol]
            option_cache[key] = ((None, None, None) if expiry is None
                                 else (expiry,) + db.option_day(conn, day, symbol, expiry, side))
        return option_cache[key]

    held_data = {}

    def held_series(position):
        key = (position.symbol, position.expiry, position.option_type)
        if key not in held_data:
            by_strike, band = db.option_day(conn, day, position.symbol, position.expiry,
                                            position.option_type)
            held_data[key] = (by_strike, band, bool(band))
        return held_data[key]

    cutoff = ist_time(params["entryCutoffIst"])
    expiry_flatten = ist_time(params["expiryFlattenIst"])
    max_open = max(st["params"]["maxOpenTrades"] for st in strategies)
    taken = defaultdict(int)
    closed = []

    # A contract whose expiry passed on a day with no minutes at all (a gap in
    # the archive) is closed at its last price rather than carried past expiry.
    for position in [p for p in carry.open if p.expiry < day]:
        carry.open.remove(position)
        closed.append(close_position(position, position.last_price, position.last_at, "expiry"))

    minutes = sorted({m for s in set(live) | held for m in bar_at.get(s, {})})
    for minute in minutes:
        still_open = []
        for position in carry.open:
            if position.entry_at >= minute:
                still_open.append(position)
                continue
            by_strike, band, has_data = held_series(position)
            flatten = expiry_flatten if position.expiry == day else None
            done = step_carried(position, by_strike, band, has_data,
                                bar_at.get(position.symbol, {}).get(minute), minute, flatten,
                                position_risk(position, strategies))
            (closed if done is not None else still_open).append(done or position)
        carry.open = still_open

        for symbol in live:
            bar = bar_at[symbol].get(minute)
            if bar is not None:
                carry.clocks[symbol].push_minute(bar)

        entries_open = minute.time() < cutoff
        for strategy in strategies:
            sid = strategy["id"]
            allowed = {leg_of(strategy, s) for s in (setups[sid] if setups else strategy["setups"])}
            for symbol in live:
                state = week.states.get((sid, symbol))
                bar = bar_at[symbol].get(minute)
                if state is None or bar is None:
                    continue
                clock = carry.clocks[symbol]
                signal = evaluate_symbol(
                    week.planned(sid, symbol), state, strategy["params"], bar["close"],
                    clock.value, clock.last_bar_close, minute,
                    entries_open and symbol in may_enter, allowed)
                if signal is None:
                    continue
                signal.setup = setup_for_leg(strategy, signal.setup)
                notes["signals"] += 1
                notes["bySetup"][signal.setup] += 1

                if len(carry.open) >= max_open:
                    notes["rejected"]["book full"] += 1
                    continue
                if taken[sid] >= strategy["params"]["maxTradesPerDay"]:
                    notes["rejected"]["daily cap"] += 1
                    continue

                position = _try_fill(conn, day, prev, strategy, signal, week.planned(sid, symbol),
                                     minute, floors, option_data, gate_cache, notes,
                                     bar_at[symbol])
                if position is None:
                    continue
                remember_print(position, position.entry, signal.spot, minute)
                m = mark(position)
                m.update({"weekOf": week.monday.isoformat(),
                          "pivotWeek": [week.sessions[0].isoformat(), week.last_session.isoformat()],
                          "estimated": False, "estimatedMinutes": 0, "estimatedExit": False,
                          **{k: v for k, v in detail.get(symbol, {}).items()
                             if k in ("rank", "score", "skewRank", "oiRank", "skew", "oiLots")},
                          "rankPivot": detail.get(symbol, {}).get("pivot")})
                state.trades_today += 1
                taken[sid] += 1
                carry.open.append(position)

    week.next_morning()
    if log:
        log(f"{day}  {len(live)} stocks, top {','.join(top) or '-'}, {notes['signals']} signals, "
            f"{len(closed)} closed, {len(carry.open)} held overnight")
    return closed, notes


def position_risk(position, strategies):
    for strategy in strategies:
        if strategy["id"] == position.strategy_id:
            return strategy["risk"]
    raise KeyError(position.strategy_id)


def finish(carry):
    """Whatever is still open when the run's dates end, closed at its last price."""
    out = []
    for position in carry.open:
        out.append(close_position(position, position.last_price, position.last_at, "run-end"))
    carry.open = []
    return out


def replay_single(conn, day, strategies, floors, log=None, setups=None):
    """One day on its own (`run.py session`): a fresh week, and nothing carried in."""
    carry = Carry()
    closed, notes = replay_day(conn, day, strategies, floors, carry, log=log, setups=setups)
    return closed + finish(carry), notes


def is_estimated(position):
    return bool(position.context.get("weekly", {}).get("estimated"))
