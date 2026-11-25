"""The ATR stop - A/B/C-ATR and A/B/C-ATR600. Backtest only.

The -SK legs with the stop sized by the stock's 5-minute ATR(14) / 3, applied
straight to the option premium in points. What this file pins down:

  - the definition: -SK v2 entries exactly; ATR/3 stop; no 550; the -ATR600
    ladder in fixed Rs 600 steps
  - the ATR itself: true range with the previous close, Wilder smoothing seeded
    by the plain mean of 14, closed 5-minute bars only
  - the stop and the ladder at his own example: premium 133, ATR 14.40 -> 128.20
  - whole sessions: the same entries as -SK, a different stop; the stop fills at
    its level for exactly ATR/3 x lot; no ATR -> no trade; the stored trade
  - that the variants never share a run, and the dashboard lists the same legs

    py -3.12 tests/test_atr_stop.py
"""
import datetime as dt
import math
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fake_archive import FakeArchive, Result, Stock, at, flat_premium, premium_falling_through
from settings import GATE_FLOORS
from backtest import atr_stop
from backtest import strategies as S
from backtest.position import apply_bar, open_position
from backtest.runner import replay_session
from backtest.strategies import selection

DAY = dt.date(2026, 10, 15)
ATR_LONG, ATR_SHORT = S.BREAKOUT_RETRACE_21EMA_ATR, S.BREAKDOWN_RETRACE_21EMA_ATR
FIX_LONG, FIX_SHORT = S.BREAKOUT_RETRACE_21EMA_ATR600, S.BREAKDOWN_RETRACE_21EMA_ATR600
SK_LONG = S.BREAKOUT_RETRACE_21EMA_SK

passed, failed = 0, []


def check(name, got, want):
    global passed
    if got == want:
        passed += 1
    else:
        failed.append(f"{name}\n      got  {got}\n      want {want}")


def close(name, got, want, tol=1e-9):
    """`check` for floats: equal within `tol`, and shows the real value when not."""
    ok = got is not None and math.isclose(got, want, abs_tol=tol)
    check(name, want if ok else got, want)


# ---------------- the definition ----------------

for rule in (ATR_LONG, ATR_SHORT, FIX_LONG, FIX_SHORT):
    check(f"{rule['id']}: entries are the -SK rule's exactly", rule["params"], SK_LONG["params"])
    check(f"{rule['id']}: backtest only, v1", (rule["backtestOnly"], rule["version"]), (True, 1))
    r = rule["risk"]
    check(f"{rule['id']}: 5-min ATR(14) / 3", (r["stopBasis"], r["atrPeriod"], r["atrIntervalMinutes"],
                                               r["atrStopDivisor"]), ("atr", 14, 5, 3))
    check(f"{rule['id']}: 1 lot ATM, 1:2 -> +1R ladder, cost at 1.5", (
        r["lots"], r["moneyness"], r["rewardMultiple"], r["trailStartMultiple"],
        r["trailLockMultiple"], r["trail"], r["breakevenAtR"]), (1, "ATM", 2, 2, 1, "ladder", 1.5))

check("-ATR has no 550 anywhere: R comes from the ATR", "rupeesPerTrade" in ATR_LONG["risk"], False)
check("-ATR steps its ladder in the trade's own R", ATR_LONG["risk"]["ladderBasis"], "own-r")
check("-ATR600 is -ATR with the ladder in a fixed Rs 600",
      {k: v for k, v in FIX_LONG["risk"].items() if k not in ("ladderBasis", "rupeesPerTrade")},
      {k: v for k, v in ATR_LONG["risk"].items() if k != "ladderBasis"})
check("-ATR600's unit", (FIX_LONG["risk"]["ladderBasis"], FIX_LONG["risk"]["rupeesPerTrade"]),
      ("fixed", 600))
check("books", (ATR_LONG["book"], ATR_SHORT["book"], FIX_LONG["book"], FIX_SHORT["book"]),
      ("atr-stop", "atr-stop", "atr-stop-600", "atr-stop-600"))
check("legs", (ATR_LONG["legs"], ATR_SHORT["legs"], FIX_LONG["legs"], FIX_SHORT["legs"]),
      ({"A-ATR": "A", "B-ATR": "B"}, {"C-ATR": "C"},
       {"A-ATR600": "A", "B-ATR600": "B"}, {"C-ATR600": "C"}))
check("the short buys a put", (ATR_SHORT["sides"], FIX_SHORT["sides"]),
      ({"C-ATR": "SHORT"}, {"C-ATR600": "SHORT"}))
check("-SK itself is untouched", (SK_LONG["version"], SK_LONG["risk"].get("stopBasis")), (2, None))


# ---------------- the ATR ----------------

def bar(h, m, high, low, close_, day=DAY):
    return {"at": at(day, h, m), "high": high, "low": low, "close": close_}


check("1-minute bars fold into 5-minute high / low / close",
      atr_stop.fold_ohlc([bar(9, 15, 101, 99, 100), bar(9, 17, 104, 100, 103),
                          bar(9, 19, 103, 98, 99), bar(9, 20, 100, 99, 100)], 5),
      [(at(DAY, 9, 15), 104, 98, 99), (at(DAY, 9, 20), 100, 99, 100)])

clock = atr_stop.AtrClock(3, 5)
check("no ATR before `period` closed bars", clock.value, None)
for minute_bar in (bar(9, 15, 102, 100, 101),     # TR 2 (the first bar: high - low)
                   bar(9, 20, 106, 105, 105),     # TR 5 (gap: 106 - 101)
                   bar(9, 25, 104, 97, 98)):      # TR 8 (104 - 97 > |97 - 105|)
    clock.push_minute(minute_bar)
check("a bar still forming is not counted", (clock.bars, clock.value), (2, None))
clock.push_minute(bar(9, 30, 99, 99, 99))         # closes 09:25
close("seeded with the plain mean of the first 3 true ranges", clock.value, (2 + 5 + 8) / 3)
clock.push_minute(bar(9, 35, 99, 99, 99))         # closes 09:30: TR = |99 - 98| = 1
close("then Wilder: (prev x (n-1) + TR) / n", clock.value, (5 * 2 + 1) / 3)
clock.push_minute(bar(9, 36, 120, 90, 99))
close("a wild minute in a forming bar changes nothing yet", clock.value, (5 * 2 + 1) / 3)

seeded = atr_stop.AtrClock(14, 5, [(None, 103.0, 97.0, 100.0)] * 30)
close("seed bars count as closed bars", seeded.value, 6.0)


# ---------------- his example: premium 133, ATR 14.40 ----------------

stop = atr_stop.plan(14.40, 500, ATR_LONG["risk"])
close("stop is ATR / 3 premium points", stop["points"], 4.8)
close("R is that x the lot", stop["rupees"], 2400.0)
check("the ladder steps in that R", math.isclose(stop["ladderRupees"], 2400.0), True)
check("no ATR, no stop", (atr_stop.plan(None, 500, ATR_LONG["risk"]),
                          atr_stop.plan(0.0, 500, ATR_LONG["risk"])), (None, None))
check("-ATR600: the same stop, a Rs 600 ladder",
      (atr_stop.plan(14.40, 500, FIX_LONG["risk"])["points"],
       atr_stop.plan(14.40, 500, FIX_LONG["risk"])["ladderRupees"]),
      (stop["points"], 600))


def opened(rule, atr, entry=133.0, lot=500):
    plan_ = atr_stop.plan(atr, lot, rule["risk"])
    signal = types.SimpleNamespace(
        symbol="X", setup=rule["setups"][0], at=at(DAY, 10, 0), spot=1000.0, ema=999.0,
        retracement=None,
        level=types.SimpleNamespace(pivot="R1", pivot_value=1000.0, strike=1000.0, kind="resistance",
                                    gap_pct=0.1, skew=lambda: 6.0))
    sized = dict(rule, risk=atr_stop.sized_risk(rule["risk"], plan_))
    position = open_position(signal, sized, {"price": entry}, lot, DAY, 1000.0, "CE", "clear",
                             DAY.isoformat())
    return atr_stop.arm(position, plan_, rule["risk"])


def walk(position, rule, highs):
    """Feeds minutes that only rise, each to the given high. Returns the locks made."""
    risk = atr_stop.ladder_risk(position, rule["risk"])
    for i, high in enumerate(highs):
        apply_bar(position, {"open": high, "high": high, "low": high, "close": high},
                  risk, at(DAY, 10, 1 + i))
    return [round(s["locked"], 2) for s in position.ladder]


p = opened(ATR_LONG, 14.40)
close("-ATR: stop 133 - 4.80 = 128.20", p.stop, 128.2)
close("riskPerUnit is the ATR stop", p.risk_per_unit, 4.8)
close("1:2 target = 133 + 2 x 4.80", p.target, 142.6)
walk(p, ATR_LONG, [140.19])
close("not at cost below +1.5R (140.20)", p.stop, 128.2)
walk(p, ATR_LONG, [140.2])
close("at +1.5R the stop goes to cost", p.stop, 133.0)
locks = walk(p, ATR_LONG, [142.6])
close("at +2R the stop goes to +1R (137.80)", p.stop, 137.8)
check("which locks +1R = Rs 2,400", locks, [2400.0])
locks = walk(p, ATR_LONG, [147.4])
close("then one rung behind: +3R -> +2R", p.stop, 142.6)
check("Rs 4,800 locked", locks, [2400.0, 4800.0])

q = opened(FIX_LONG, 14.40)
close("-ATR600: the same ATR stop", q.stop, 128.2)
close("riskPerUnit is still the ATR stop", q.risk_per_unit, 4.8)
close("first rung at +Rs 1,200 = 133 + 2.40", q.target, 135.4)
walk(q, FIX_LONG, [134.79])
close("not at cost below +Rs 900 (134.80)", q.stop, 128.2)
walk(q, FIX_LONG, [134.8])
close("at +Rs 900 the stop goes to cost", q.stop, 133.0)
locks = walk(q, FIX_LONG, [135.4])
close("at +Rs 1,200 the stop locks +Rs 600 (134.20)", q.stop, 134.2)
check("Rs 600 locked", locks, [600.0])
locks = walk(q, FIX_LONG, [136.6])
close("+Rs 1,800 -> +Rs 1,200 (135.40)", q.stop, 135.4)
check("then every +600", locks, [600.0, 1200.0])

wide = opened(FIX_LONG, 30.0, entry=8.0, lot=500)
check("an ATR stop past zero premium sits at the 5-paisa floor",
      (wide.stop, wide.risk_capped), (0.05, True))


# ---------------- whole sessions, through replay_session ----------------
# The fixtures of test_pivot_skew.py: ALPHA breaks R1 at 09:20, pulls back to
# 1004.50 at 09:27 and enters at 09:28 (setup B on the same stock fires first, at
# 09:20, on the level cross). SHORTY takes C at 09:26.

def chain_dict(r1_call):
    return {
        float(k): (r1_call, 100.0) if k == 1020 else (100.0, 1000.0) if k == 980 else (500.0, 500.0)
        for k in range(900, 1121, 10)
    }


OHLC = (1030.0, 970.0, 1000.0)
TWO_PCT = ((1010.0, 990.0, 1000.0),) * 14
SEED_RANGE = 6.0


def minute(h, m):
    return at(DAY, h, m)


def prices(spec):
    out = {}
    for first, last, price in spec:
        for m in range(first, last + 1):
            out[minute(9, m)] = float(price)
    return out


A_PRICES = prices([(15, 19, 1000), (20, 24, 1024), (25, 25, 1005.5), (26, 26, 1008),
                   (27, 27, 1004.5), (28, 59, 1006.5)])
SHORT_PRICES = prices([(15, 19, 978), (20, 20, 972), (21, 24, 970), (25, 25, 974), (26, 59, 971)])


def alpha(premium=None):
    return Stock(symbol="ALPHA", ohlc=OHLC, chain=chain_dict(1000.0), prices=A_PRICES, seed=1000.0,
                 atm=1020.0, premium=premium or flat_premium(DAY, 30.0), history=TWO_PCT,
                 seed_range=SEED_RANGE)


def shorty():
    return Stock(symbol="SHORTY", ohlc=OHLC, chain=chain_dict(1000.0), prices=SHORT_PRICES,
                 seed=975.0, atm=970.0, premium=flat_premium(DAY, 25.0), history=TWO_PCT,
                 seed_range=SEED_RANGE)


class NoAtrSeed(FakeArchive):
    """An archive with no earlier sessions to seed the ATR from."""

    def execute(self, sql, params=()):
        if atr_seed_query(sql):
            self.asked.append(sql)
            return Result([])
        return super().execute(sql, params)


def run(stocks, setups, archive=FakeArchive):
    strategy_ids, chosen = selection(setups)
    conn = archive(DAY, stocks)
    trades, notes = replay_session(conn, DAY, [S.STRATEGIES[s] for s in strategy_ids],
                                   GATE_FLOORS, setups=chosen)
    return trades, notes, conn


def entries(trades):
    return sorted((p.setup.split("-")[0], p.symbol, p.entry_at.strftime("%H:%M"), p.entry)
                  for p in trades)


def atr_seed_query(sql):
    return "FROM spot_1min" in sql and "high_paise" in sql and "ANY" not in sql


def wilder(trs, n=14, seed=None):
    value = seed
    for tr in trs:
        value = (value * (n - 1) + tr) / n
    return value


sk, _, sk_conn = run([alpha(), shorty()], ["A-SK", "B-SK", "C-SK"])
atr, notes, atr_conn = run([alpha(), shorty()], ["A-ATR", "B-ATR", "C-ATR"])
fix, _, _ = run([alpha(), shorty()], ["A-ATR600", "B-ATR600", "C-ATR600"])
check("-ATR takes exactly the -SK trades", entries(atr), entries(sk))
check("and so does -ATR600", entries(fix), entries(sk))
check("which is B on ALPHA at 09:20 and C on SHORTY at 09:26",
      [(s, sym, t) for s, sym, t, _ in entries(atr)], [("B", "ALPHA", "09:20"), ("C", "SHORTY", "09:26")])
check("the ATR seed is read only when a run has an ATR leg",
      (any(atr_seed_query(q) for q in sk_conn.asked),
       any(atr_seed_query(q) for q in atr_conn.asked)), (False, True))

# ALPHA's B at 09:20: the seed's bars are all 6 high to low around 1000, so the
# ATR is 6; 09:15-09:19 then closes flat at 1000 - TR 0 - and is the only bar of
# the day closed by 09:20.
b = next(p for p in atr if p.setup == "B-ATR")
close("B's ATR: the seed's 6, then one flat bar", b.context["atrStop"]["atr"], wilder([0.0], seed=6.0))
close("B's stop is the fill - ATR/3", b.stop, 30.0 - wilder([0.0], seed=6.0) / 3)
close("R = ATR/3 x the 250 lot", b.risk_per_unit * b.qty, wilder([0.0], seed=6.0) / 3 * 250)
sk_b = next(p for p in sk if p.setup == "B-SK")
close("-SK's stop on the same trade: 550 / 250 = 2.20 under", sk_b.stop, 30.0 - 2.2)

# SHORTY's C at 09:26: seed 975; 09:15-09:19 at 978 (TR 3, the gap off 975),
# 09:20-09:24 from 972 to 970 (TR 8, 978 down to 970).
c = next(p for p in atr if p.setup == "C-ATR")
close("C's ATR: two closed bars of the day after the seed", c.context["atrStop"]["atr"],
      wilder([3.0, 8.0], seed=6.0))
check("C buys the put", c.option_type, "PE")

f = next(p for p in fix if p.setup == "B-ATR600")
close("-ATR600: the same stop as -ATR", f.stop, b.stop)
close("but its first rung is +Rs 1,200 on the 250 lot", f.target, 30.0 + 2 * 600 / 250)

# Only A on ALPHA, with a premium that trades down through its stop at 09:40.
falling = premium_falling_through(DAY, 30.0, 20.0, 40)
a_only, _, _ = run([alpha(falling)], ["A-ATR"])
check("A alone on ALPHA enters at 09:28", [(p.setup, p.entry_at.strftime("%H:%M")) for p in a_only],
      [("A-ATR", "09:28")])
a = a_only[0]
# 09:15-09:19 flat at 1000 (TR 0); 09:20-09:24 at 1024 (TR 24). 09:25 still forming.
close("A's ATR at 09:28 counts only the bars closed by then", a.context["atrStop"]["atr"],
      wilder([0.0, 24.0], seed=6.0))
check("stopped out at 09:40 on its stop", (a.exit_reason, a.exit_at.strftime("%H:%M")), ("stop", "09:40"))
close("filled at the stop itself", a.exit_price, a.stop)
close("for a loss of exactly ATR/3 x lot", a.profit, -wilder([0.0, 24.0], seed=6.0) / 3 * 250, 1e-6)

none, none_notes, _ = run([alpha(), shorty()], ["A-ATR", "B-ATR", "C-ATR"], NoAtrSeed)
check("with no earlier sessions there are under 14 closed bars all morning, so no trade", none, [])
# B on ALPHA at 09:20, C on SHORTY at 09:26 - and A on ALPHA at 09:28, free to fire
# because the refused B never became ALPHA's trade of the day.
check("each counted as its own rejection", none_notes["rejected"].get("no 5-min ATR yet"), 3)


# ---------------- runs are one book or another ----------------

def refused(setups):
    try:
        selection(setups)
    except SystemExit:
        return True
    return False


check("A-SK and A-ATR cannot share a run", refused(["A-SK", "A-ATR"]), True)
check("nor -ATR and -ATR600", refused(["A-ATR", "C-ATR600"]), True)
check("the three -ATR legs are one run", refused(["A-ATR", "B-ATR", "C-ATR"]), False)
check("the three -ATR600 legs are one run", refused(["A-ATR600", "B-ATR600", "C-ATR600"]), False)


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

doc = results.trade_document(f, "run-atr600")
check("a stored -ATR600 trade carries its tag",
      (doc["setup"], doc["setupLabel"]), ("B-ATR600", "Support hold & level cross [ATR/3 SL, ladder Rs 600]"))
check("and its ATR stop", sorted(doc["trigger"]["atrStop"]),
      sorted(["atr", "period", "intervalMinutes", "divisor", "points", "rupees", "ladderBasis",
              "ladderRupees", "stop", "target"]))
check("the ladder unit it stepped in", (doc["trigger"]["atrStop"]["ladderBasis"],
                                       doc["trigger"]["atrStop"]["ladderRupees"]), ("fixed", 600))
close("riskPerUnit on the trade is the ATR stop, for the dashboard's R",
      doc["riskPerUnit"], doc["trigger"]["atrStop"]["points"])


# ---------------- the dashboard lists the same legs ----------------
SETUPS_TS = (Path(__file__).resolve().parents[3] / "src" / "lib" / "backtest" / "setups.ts")
text = SETUPS_TS.read_text(encoding="utf-8")
for strategy in (ATR_LONG, ATR_SHORT, FIX_LONG, FIX_SHORT):
    for setup in strategy["setups"]:
        block = text.split(f'setup: "{setup}"', 1)
        body = block[1].split("}", 1)[0] if len(block) == 2 else ""
        check(f"setups.ts lists {setup} under {strategy['id']} v{strategy['version']}",
              (f'strategy: "{strategy["id"]}"' in body, f"version: {strategy['version']}," in body,
               f'book: "{strategy["book"]}"' in body),
              (True, True, True))


print(f"{passed} passed, {len(failed)} failed")
for f_ in failed:
    print("  FAIL  " + f_)
sys.exit(1 if failed else 0)
