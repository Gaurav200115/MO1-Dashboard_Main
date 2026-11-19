"""Weekly pivots, 1-hour EMA, top 3 by OI + skew, held overnight - A-WK, B-WK, C-WK.

Backtest only (weekly.py). What this file pins down:

  - the definition: live long v11 / short v7 plus the stated changes, nothing else
  - 1-hour bars from 09:15, closing across the night; the EMA carried across days
  - the week's high / low / close, a holiday week skipped back over
  - the ranking: skew rank + OI rank, a stock's better level, ties, the cut at 3
  - Black-Scholes: parity, the implied-vol round trip, a put's high from the stock's low
  - a held minute: real print, inside the band, past it (estimated), expiry, no IV
  - whole weeks through run_range: entered Monday, stopped Tuesday; only the top 3
    enter; nothing near expiry; a day with no option data priced from the stock
  - one book, its own run; the dashboard lists the same legs

    py -3.12 tests/test_weekly.py
"""
import datetime as dt
import math
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fake_archive import IST, Result, default_history
from settings import GATE_FLOORS
from backtest import strategies as S
from backtest import weekly as W
from backtest.levels import ConfirmedLevel
from backtest.position import Position
from backtest.runner import replay_session, run_range
from backtest.strategies import selection

LONG, SHORT = S.BREAKOUT_RETRACE_1H_WEEKLY, S.BREAKDOWN_RETRACE_1H_WEEKLY
MON, TUE = dt.date(2026, 10, 12), dt.date(2026, 10, 13)

passed, failed = 0, []


def check(name, got, want):
    global passed
    if got == want:
        passed += 1
    else:
        failed.append(f"{name}\n      got  {got}\n      want {want}")


def close(name, got, want, tol=1e-6):
    check(name, got is not None and abs(got - want) <= tol, True)


def at(day, h, m):
    return dt.datetime.combine(day, dt.time(h, m), tzinfo=IST)


# ---------------- the definition ----------------

live = S.BREAKOUT_RETRACE_21EMA
check("base is live long v11 / short v7",
      (S.BREAKOUT_RETRACE_21EMA["version"], S.BREAKDOWN_RETRACE_21EMA["version"]), (11, 7))
changed = {"emaIntervalMinutes": 60, "pivotPeriod": "week", "rankTop": 3,
           "rankBy": "skewRank+oiLotsRank, better major level", "holdOvernight": True,
           "noEntrySessionsBeforeExpiry": 3, "expiryFlattenIst": "15:15",
           "outOfBand": "black-scholes at last real IV"}
check("everything not changed is the live rule",
      {k: v for k, v in LONG["params"].items() if k not in changed},
      {k: v for k, v in live["params"].items() if k != "flattenIst" and k not in changed})
check("the changes", {k: LONG["params"][k] for k in changed}, changed)
check("no daily 15:15 flatten", "flattenIst" in LONG["params"], False)
check("the short reads the same params", SHORT["params"], LONG["params"])
check("the live stop and ladder", (LONG["risk"], SHORT["risk"]), (live["risk"], live["risk"]))
check("the live per-pivot skew and 13:00 cutoff",
      (LONG["params"]["pivotMinSkew"], LONG["params"]["entryCutoffIst"],
       LONG["params"]["maxOpenTrades"], LONG["params"]["maxStepCostOfRiskPct"]),
      (S.PIVOT_MIN_SKEW, "13:00", 3, 20))
check("its own book", (LONG["book"], SHORT["book"], W.BOOK), ("weekly-1h-top3",) * 3)
check("legs", (LONG["legs"], SHORT["legs"]), ({"A-WK": "A", "B-WK": "B"}, {"C-WK": "C"}))


def refused(setups):
    try:
        selection(setups)
    except SystemExit:
        return True
    return False


check("A and A-WK cannot share a run", refused(["A", "A-WK"]), True)
check("nor C-SK and A-WK", refused(["C-SK", "A-WK"]), True)
check("the three -WK legs are one run", refused(["A-WK", "B-WK", "C-WK"]), False)


# ---------------- 1-hour bars ----------------

check("09:15 opens bar 0", W.hour_bucket(at(MON, 9, 15)), (MON, 0))
check("10:14 is still bar 0", W.hour_bucket(at(MON, 10, 14)), (MON, 0))
check("10:15 opens bar 1", W.hour_bucket(at(MON, 10, 15)), (MON, 1))
check("15:29 is bar 6 (the short 15:15 bar)", W.hour_bucket(at(MON, 15, 29)), (MON, 6))
check("the date is in the key", W.hour_bucket(at(TUE, 9, 15)) != W.hour_bucket(at(MON, 9, 15)), True)

minutes = [{"at": at(MON, 9, 15) + dt.timedelta(minutes=i), "close": 100.0 + i} for i in range(375)]
folded = W.fold_hour_bars(minutes)
check("a session folds to 7 hourly bars", len(folded), 7)
check("each closes on its last minute", [c for _, c in folded],
      [159.0, 219.0, 279.0, 339.0, 399.0, 459.0, 474.0])

clock = W.HourClock(3, 60, [10.0, 10.0, 10.0])
check("seeded EMA", clock.value, 10.0)
clock.push_minute({"at": at(MON, 9, 15), "close": 20.0})
clock.push_minute({"at": at(MON, 10, 14), "close": 20.0})
check("no bar closed inside the hour", clock.value, 10.0)
clock.push_minute({"at": at(MON, 10, 15), "close": 20.0})
check("10:15 closes the 09:15 bar", (clock.value, clock.last_bar_close), (15.0, 20.0))
clock.push_minute({"at": at(MON, 15, 29), "close": 30.0})
clock.push_minute({"at": at(TUE, 9, 15), "close": 30.0})
check("the 15:15 bar closes on the next morning's first minute",
      (clock.last_bar_close, clock.day), (30.0, TUE))


# ---------------- the week's levels ----------------

days = {dt.date(2026, 10, 5): (110.0, 100.0, 105.0),
        dt.date(2026, 10, 7): (120.0, 95.0, 118.0),
        dt.date(2026, 10, 9): (119.0, 101.0, 112.0)}
check("week high, low, and the last session's close", W.weekly_ohlc(days, {}), (120.0, 95.0, 112.0))
check("each session adjusted by its own factor",
      W.weekly_ohlc(days, {dt.date(2026, 10, 5): 0.5, dt.date(2026, 10, 7): 0.5}),
      (119.0, 47.5, 112.0))
check("Monday's week", W.week_start(dt.date(2026, 10, 15)), MON)


class Calendar:
    def __init__(self, days):
        self.days = sorted(days)

    def execute(self, sql, params=()):
        a, b = params
        return Result([(d,) for d in self.days if a <= d <= b])


cal = Calendar([dt.date(2026, 9, 28) + dt.timedelta(days=i) for i in range(5)] + [MON])
check("a holiday week is skipped back over", W.previous_week_sessions(cal, MON),
      [dt.date(2026, 9, 28) + dt.timedelta(days=i) for i in range(5)])


# ---------------- the ranking ----------------

check("competition rank, largest first", W.competition_rank([5, 9, 9, 1]), [3, 1, 1, 4])
check("infinite skew ranks first", W.competition_rank([math.inf, 9.0]), [1, 2])

cands = [("AAA", "R1", 20.0, 10.0),     # skew 1st, OI 4th -> 5
         ("BBB", "S1", 6.0, 100.0),     # skew 3rd, OI 1st -> 4
         ("BBB", "R2", 2.0, 5.0),       # BBB's weaker level, ignored
         ("CCC", "S2", 8.0, 50.0),      # skew 2nd, OI 2nd -> 4, but less OI than BBB
         ("DDD", "P", 2.0, 20.0)]       # skew 4th, OI 3rd -> 7... (2.0 ties with R2)
top, detail = W.rank_stocks(cands, 3)
check("lowest skew rank + OI rank wins; tie to the larger OI", top, ["BBB", "CCC", "AAA"])
check("a stock scores with its better level", (detail["BBB"]["pivot"], detail["BBB"]["score"]), ("S1", 4))
check("the fourth is cut", ("DDD" in top, detail["DDD"]["rank"]), (False, 4))
check("nothing to rank", W.rank_stocks([], 3), ([], {}))

sup = ConfirmedLevel("S1", 980.0, "support", 980.0, 100.0, 900.0, 0.1, 2.0)
res = ConfirmedLevel("R1", 1020.0, "resistance", 1020.0, 0.0, 0.0, 0.1, 2.0)
chain = {980.0: {"CE": 200.0, "PE": 2000.0}, 1020.0: {"CE": 3000.0, "PE": 0.0}}
check("a support: puts over calls, OI of the puts in lots", W.level_strength(sup, chain, 250), (10.0, 8.0))
check("a one-sided resistance is infinite skew", W.level_strength(res, chain, 250), (math.inf, 12.0))
check("a strike missing from the chain scores nothing", W.level_strength(sup, {}, 250), (0.0, 0.0))


# ---------------- Black-Scholes ----------------

T = 20 / 365
c = W.bs_price("CE", 1000.0, 1010.0, T, 0.3)
p = W.bs_price("PE", 1000.0, 1010.0, T, 0.3)
close("put-call parity", c - p, 1000.0 - 1010.0 * math.exp(-W.RISK_FREE * T), 1e-9)
close("implied vol recovers the vol", W.implied_vol("CE", c, 1000.0, 1010.0, T), 0.3, 1e-6)
close("for a put too", W.implied_vol("PE", p, 1000.0, 1010.0, T), 0.3, 1e-6)
check("a price under intrinsic pins to the floor", W.implied_vol("CE", 50.0, 1000.0, 900.0, T), W.IV_MIN)
check("no price, no vol", W.implied_vol("CE", 0.0, 1000.0, 1010.0, T), None)
check("expired: intrinsic", W.bs_price("PE", 990.0, 1000.0, 0.0, 0.3), 10.0)


def position(option_type="CE", entry=30.0, strike=1010.0, expiry=dt.date(2026, 10, 27)):
    return Position(symbol="ALPHA", setup="A-WK", trading_date=MON.isoformat(),
                    strategy_id=LONG["id"], strategy_version=1, option_type=option_type,
                    expiry=expiry, strike=strike, qty=250, entry=entry,
                    entry_at=at(MON, 9, 28), risk_per_unit=2.2, risk_capped=False,
                    stop=entry - 2.2, target=entry + 4.4)


pos = position("PE")
spot = {"open": 1000.0, "high": 1010.0, "low": 990.0, "close": 1000.0}
est = W.estimate_bar(pos, spot, at(TUE, 9, 30), 0.3)
check("a put's high comes from the stock's low",
      est["high"] == W._tick(W.bs_price("PE", 990.0, 1010.0, W.years_to_expiry(at(TUE, 9, 30), pos.expiry), 0.3)),
      True)
check("estimated prices sit on the 5-paise grid", all(round(est[k] * 100) % 5 == 0
                                                      for k in ("open", "high", "low", "close")), True)


# ---------------- a held minute ----------------

risk = LONG["risk"]
M = at(TUE, 9, 30)


def real(price, low=None):
    return {1010.0: {M: {"open": price, "high": price, "low": low if low is not None else price,
                         "close": price, "spot": 1000.0}}}


pos = position()
check("a real print above the stop holds",
      W.step_carried(pos, real(31.0), {M: (980.0, 1040.0)}, True, None, M, None, risk), None)
check("and is remembered for the next estimate", pos._real[0:2], (31.0, 1000.0))

pos = position()
done = W.step_carried(pos, real(31.0, low=27.0), {M: (980.0, 1040.0)}, True, None, M, None, risk)
check("a real print through the stop exits at the stop", (done.exit_reason, round(done.exit_price, 2)),
      ("stop", 27.8))

pos = position()
check("inside the band, no print: hold",
      W.step_carried(pos, {}, {M: (980.0, 1040.0)}, True, spot, M, None, risk), None)
check("and nothing was estimated", "weekly" in pos.context, False)

pos = position()
W.remember_print(pos, 30.0, 1000.0, at(MON, 15, 29))
check("outside the band: priced from the stock",
      W.step_carried(pos, {}, {M: (1050.0, 1110.0)}, True,
                     {"open": 1001.0, "high": 1002.0, "low": 1000.0, "close": 1001.0},
                     M, None, risk), None)
check("and marked estimated", (pos.context["weekly"]["estimated"], pos.context["weekly"]["estimatedMinutes"]),
      (True, 1))
check("near the last real price", abs(pos.last_price - 30.5) < 1.5, True)

pos = position()
W.remember_print(pos, 30.0, 1000.0, at(MON, 15, 29))
done = W.step_carried(pos, {}, {}, False, {"open": 960.0, "high": 960.0, "low": 955.0, "close": 958.0},
                      M, None, risk)
check("a day with no option data, stock collapsing: stopped on the estimate",
      (done.exit_reason, done.context["weekly"]["estimatedExit"]), ("stop", True))
check("filled at the estimated open, under the stop", done.exit_price < 27.8, True)

pos = position()
pos.last_price, pos.last_at = 33.0, at(MON, 15, 29)
done = W.step_carried(pos, {}, {}, False, spot, at(TUE, 15, 15), dt.time(15, 15), risk)
check("15:15 on expiry day closes at the last price",
      (done.exit_reason, done.exit_price), ("expiry", 33.0))

pos = position()
pos._real = None
done = W.step_carried(pos, {}, {}, False, spot, M, None, risk)
check("no real print to fit an IV to: closed out-of-band", done.exit_reason, "out-of-band")


# ---------------- whole weeks, through run_range ----------------

PREV_WEEK = [dt.date(2026, 10, 5) + dt.timedelta(days=i) for i in range(5)]
CALENDAR = [d for d in (dt.date(2026, 8, 31) + dt.timedelta(days=i) for i in range(60))
            if d.weekday() < 5]


class Stock:
    def __init__(self, symbol, chain, prices, premium, seed=1000.0, lot=250):
        self.symbol, self.chain, self.prices, self.premium = symbol, chain, prices, premium
        self.seed, self.lot, self.step = seed, lot, 10.0
        self.strikes = tuple(float(k) for k in range(900, 1121, 10))
        self.ohlc = (1030.0, 970.0, 1000.0)


class WeekArchive:
    """db.py's queries over several sessions. Every session before MON is the
    previous week's (1030 / 970 / 1000); MON and TUE carry the prices."""

    def __init__(self, stocks, expiry=dt.date(2026, 10, 27), last=TUE):
        self.stocks = {s.symbol: s for s in stocks}
        self.expiry = expiry
        self.calendar = [d for d in CALENDAR if d <= last]

    def _p(self, v):
        return int(round(v * 100))

    def execute(self, sql, params=()):
        q = " ".join(sql.split())
        if "FROM trading_calendar" in q and "BETWEEN" in q:
            a, b = params
            return Result([(d,) for d in self.calendar if a <= d <= b])
        if "FROM trading_calendar" in q:
            before = [d for d in self.calendar if d < params[0]]
            return Result([(before[-1],)] if before else [])
        if "FROM liquidity_rank WHERE selected" in q:
            return Result([(s,) for s in self.stocks])
        if "FROM liquidity_rank WHERE month" in q:
            return Result([(100_000_000, 5_000)])
        if "FROM done" in q:
            return Result([(s, 14) for s in self.stocks])
        if "FROM stocks" in q:
            return Result([(s.symbol, s.lot, s.step) for s in self.stocks.values()])
        if "FROM corporate_actions" in q:
            return Result([])
        if "FROM cm_bhavcopy" in q and "trade_date = ANY" in q:
            days, symbols = params
            return Result([(sym, d, *(self._p(v) for v in self.stocks[sym].ohlc))
                           for sym in symbols for d in days])
        if "FROM cm_bhavcopy" in q and "ORDER BY symbol, trade_date" in q:
            symbols, _, upto = params
            rows = []
            for sym in symbols:
                for back, hlc in enumerate(reversed(default_history(1000.0))):
                    rows.append((sym, upto - dt.timedelta(days=back), *(self._p(v) for v in hlc)))
            return Result(sorted(rows))
        if "FROM cm_bhavcopy" in q:
            return Result([(s.symbol, *(self._p(v) for v in s.ohlc)) for s in self.stocks.values()])
        if "min(expiry_date) FROM fo_bhavcopy" in q or "min(expiry_date) FROM option_1min" in q:
            return Result([(self.expiry,)])
        if "strike_paise, option_type, open_interest FROM fo_bhavcopy" in q:
            rows = []
            for strike, (call, put) in self.stocks[params[1]].chain.items():
                rows += [(self._p(strike), "CE", call), (self._p(strike), "PE", put)]
            return Result(rows)
        if "max(open_interest) FROM fo_bhavcopy" in q:
            return Result([(1_000_000.0,)])
        if "open_interest, contracts FROM fo_bhavcopy" in q:
            return Result([(500_000.0, 2_000)])
        if "FROM option_1min" in q:
            symbol, _, option_type, start, _ = params
            return Result(self._options(self.stocks[symbol], option_type, start.date()))
        if "FROM spot_1min" in q and "symbol = ANY" in q:
            start, _, symbols = params
            rows = []
            for sym in symbols:
                for minute, price in sorted(self.stocks[sym].prices.get(start.date(), {}).items()):
                    rows.append((sym, minute, *(self._p(price),) * 4, 10_000))
            return Result(rows)
        if "FROM spot_1min" in q:
            symbol, start, end = params
            rows = []
            for d in self.calendar:
                if start.date() <= d < end.date():
                    for i in range(375):
                        rows.append((at(d, 9, 15) + dt.timedelta(minutes=i),
                                     self._p(self.stocks[symbol].seed)))
            return Result(rows)
        raise AssertionError("unexpected query: " + q[:140])

    def _options(self, stock, option_type, day):
        rows = []
        for minute, (o, h, l, c) in sorted(stock.premium.get(day, {}).items()):
            spot = stock.prices.get(day, {}).get(minute, 1000.0)
            centre = min(stock.strikes, key=lambda k: abs(k - spot))
            for strike in stock.strikes:
                offset = int(round((strike - centre) / stock.step))
                shift = offset * 4.0 * (1 if option_type == "CE" else -1)
                rows.append((minute, self._p(strike), offset,
                             *(self._p(max(0.05, v - shift)) for v in (o, h, l, c)),
                             5000, self._p(spot)))
        return rows


def path(day, spec):
    out = {}
    for first, last, price in spec:
        for m in range(first, last + 1):
            out[at(day, 9, m)] = float(price)
    return out


def flat(day, value, first=15, last=59):
    return {at(day, 9, m): (value,) * 4 for m in range(first, last + 1)}


def falling(day, held, fallen, at_minute):
    out = {}
    for m in range(15, 60):
        v = held if m < at_minute else fallen
        out[at(day, 9, m)] = (held, held, fallen, fallen) if m == at_minute else (v,) * 4
    return out


# Monday: breaks R1 (1022.92) at 09:20, back to 1003.50 at 09:27 by the 1-hour
# EMA (1000; zone 0.15 ADR = 4.0), turns at 09:28 - A fires. Tuesday: drifts.
A_MON = path(MON, [(15, 19, 1000), (20, 24, 1024), (25, 25, 1005.5), (26, 26, 1008),
                   (27, 27, 1003.5), (28, 59, 1006.5)])
TUE_FLAT = path(TUE, [(15, 59, 1006.5)])


def chain(r1_call=1000.0, s1_put=1000.0):
    return {float(k): ((r1_call, 100.0) if k == 1020 else (100.0, s1_put) if k == 980
                       else (500.0, 500.0)) for k in range(900, 1121, 10)}


def runs(stocks, setups=("A-WK",), last=TUE, expiry=dt.date(2026, 10, 27)):
    return run_range(WeekArchive(stocks, expiry=expiry, last=last), list(setups), MON, last, GATE_FLOORS)


alpha = Stock("ALPHA", chain(), {MON: A_MON, TUE: TUE_FLAT},
              {MON: flat(MON, 30.0), TUE: falling(TUE, 30.0, 20.0, 40)})
trades, report = runs([alpha])
check("one trade: entered Monday 09:28 and carried overnight",
      [(p.setup, p.entry_at, p.trading_date) for p in trades], [("A-WK", at(MON, 9, 28), MON.isoformat())])
check("stopped on Tuesday at 09:40, not flattened Monday",
      [(p.exit_reason, p.exit_at, round(p.profit)) for p in trades], [("stop", at(TUE, 9, 40), -550)])
check("the trade records the rank that let it in",
      {k: trades[0].context["weekly"][k] for k in ("rank", "weekOf", "estimated")},
      {"rank": 1, "weekOf": MON.isoformat(), "estimated": False})
check("pivots from the previous week", trades[0].context["weekly"]["pivotWeek"],
      [PREV_WEEK[0].isoformat(), PREV_WEEK[-1].isoformat()])
check("the report carries the estimate split", (report["estimatedTrades"],
                                                report["summaryExEstimated"]["trades"]), (0, 1))

held, _ = runs([Stock("ALPHA", chain(), {MON: A_MON}, {MON: flat(MON, 30.0)})], last=MON)
check("a run ending with a trade open closes it at its last price",
      [(p.exit_reason, p.exit_price) for p in held], [("run-end", 30.0)])

single, _ = replay_session(WeekArchive([alpha]), MON, [LONG], GATE_FLOORS,
                           setups={LONG["id"]: {"A-WK"}})
check("run.py session: one day alone", [p.exit_reason for p in single], ["run-end"])

# A day the stock's options were not downloaded: priced from the stock. It falls
# to 990 at 09:40 Tuesday; the estimated call drops through the stop.
drop = path(TUE, [(15, 39, 1006.5), (40, 59, 990)])
est_alpha = Stock("ALPHA", chain(), {MON: A_MON, TUE: drop}, {MON: flat(MON, 30.0)})
trades, report = runs([est_alpha])
check("no option data Tuesday: stopped on the Black-Scholes price at 09:40",
      [(p.exit_reason, p.exit_at, p.context["weekly"]["estimated"], p.context["weekly"]["estimatedExit"])
       for p in trades], [("stop", at(TUE, 9, 40), True, True)])
check("and counted as estimated", (report["estimatedTrades"], report["summaryExEstimated"]["trades"]), (1, 0))

# Only the top 3 may enter. AAA's levels are 6x with less OI; the other three
# are 10x. All four signal at 09:28 - AAA first alphabetically - and the book
# holds 3, so AAA would take a slot if it were not ranked out.
weak = chain(r1_call=600.0, s1_put=600.0)
four = [Stock(sym, weak if sym == "AAA" else chain(), {MON: A_MON}, {MON: flat(MON, 30.0)})
        for sym in ("AAA", "BBB", "CCC", "DDD")]
trades, report = runs(four, last=MON)
check("the day's top 3 trade, the fourth never signals",
      sorted(p.symbol for p in trades), ["BBB", "CCC", "DDD"])
check("its signal was not even raised", report["signals"], 3)

trades, _ = runs(four[:3], last=MON)
check("with only three stocks, AAA is in the top 3 and trades",
      sorted(p.symbol for p in trades), ["AAA", "BBB", "CCC"])

trades, report = runs([alpha], expiry=TUE)
check("expiry within 3 sessions: no new trade", trades, [])
check("and said so", report["skipped"].get("top-3 stock-days in the last 3 sessions before expiry"), 2)

# Setup memory carries across days: the break on Monday afternoon (after
# 13:00, no entries), the pullback and turn on Tuesday morning. Monday's 13:15
# bar (1024) closes into the EMA on Tuesday's first minute (-> 1002.18), so the
# 09:16 dip to 1005.50 is already in the zone and the 09:17 turn fires.
late_break = {**path(MON, [(15, 59, 1000)]),
              **{at(MON, 13, m): 1024.0 for m in range(0, 30)}}
tue_pull = path(TUE, [(15, 15, 1024), (16, 16, 1005.5), (17, 17, 1008), (18, 18, 1003.5),
                      (19, 59, 1006.5)])
carried = Stock("ALPHA", chain(), {MON: late_break, TUE: tue_pull},
                {MON: flat(MON, 30.0), TUE: flat(TUE, 30.0)})
trades, _ = runs([carried])
check("a Monday break and a Tuesday pullback are one setup",
      [(p.setup, p.entry_at) for p in trades], [("A-WK", at(TUE, 9, 17))])


# ---------------- the stored trade ----------------
if "pymongo" not in sys.modules:
    try:
        import pymongo  # noqa: F401
    except ImportError:
        stub = types.ModuleType("pymongo")
        stub.MongoClient = stub.UpdateOne = object
        stub.ReturnDocument = types.SimpleNamespace(AFTER=True)
        sys.modules["pymongo"] = stub
from backtest import results  # noqa: E402

trades, _ = runs([alpha])
doc = results.trade_document(trades[0], "run-wk")
check("a stored trade carries its tag and weekly record",
      (doc["setupLabel"], doc["trigger"]["weekly"]["rank"], doc["sell"]["reason"]),
      ("Break & retrace [1h EMA, weekly pivots, top 3 OI+skew, overnight]", 1, "stop"))
check("tradingDate is the entry day, closedAt the exit", (doc["tradingDate"], doc["closedAt"].date()),
      (MON.isoformat(), TUE))


# ---------------- the dashboard lists the same legs ----------------
ROOT = Path(__file__).resolve().parents[3]
text = (ROOT / "src" / "lib" / "backtest" / "setups.ts").read_text(encoding="utf-8")
for strategy in (LONG, SHORT):
    for setup in strategy["setups"]:
        block = text.split(f'setup: "{setup}"', 1)
        body = block[1].split("}", 1)[0] if len(block) == 2 else ""
        check(f"setups.ts lists {setup} under {strategy['id']} v{strategy['version']}",
              (f'strategy: "{strategy["id"]}"' in body, f"version: {strategy['version']}," in body,
               'book: "weekly-1h-top3"' in body), (True, True, True))
types_ts = (ROOT / "src" / "lib" / "strategy" / "types.ts").read_text(encoding="utf-8")
check("the exit reasons exist on the dashboard", ('| "expiry"' in types_ts, '| "run-end"' in types_ts),
      (True, True))


print(f"{passed} passed, {len(failed)} failed")
for f in failed:
    print("  FAIL  " + f)
sys.exit(1 if failed else 0)
