"""The pullback-stop variant - A-PB, B-PB, C-PB. Backtest only.

The desk stops every trade 550 rupees of premium under the fill. This variant
stops A and C where the setup is proven wrong - the stock back at the
pullback's low (A) or the rally's high (C) - sizes R from that distance at an
assumed ATM delta of 0.5, raises R under 550 to 550, and does not take a trade
whose R is over 800. What this file pins down:

  - the arithmetic: R, the floor, the cap, the stop level, long and short
  - whole sessions through `replay_session`:
      R in band: the stop is the real pullback low; the stock touching it ends
      the trade at the option's low for that minute
      R floored: the stop moves out to the 550 distance, and a dip that would
      have hit the pullback low does not end the trade
      R over the cap: no trade, counted as rejected
      a stock crossing on a minute the option did not print exits on its next print
      the 1.5R premium backstop, named as such
      the ladder in the trade's own R, and the stock stop disarmed after it moves
      the short's mirror, and B unchanged on the fixed 550
  - that the pullback-stop legs never share a run with A/B/C or the ADR legs
  - that a stored trade carries its stop, and the dashboard lists the same legs

    py -3.12 tests/test_pullback.py
"""
import datetime as dt
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fake_archive import FakeArchive, Stock, at, flat_premium, premium_falling_through
from settings import GATE_FLOORS
from backtest import strategies as S
from backtest.pullback_stop import over_cap, plan_stop, stock_crossed, true_extreme
from backtest.runner import replay_session
from backtest.strategies import selection

DAY = dt.date(2026, 10, 15)
PB_LONG, PB_SHORT = S.BREAKOUT_RETRACE_21EMA_PB, S.BREAKDOWN_RETRACE_21EMA_PB
RISK = PB_LONG["risk"]

passed, failed = 0, []


def check(name, got, want):
    global passed
    if got == want:
        passed += 1
    else:
        failed.append(f"{name}\n      got  {got}\n      want {want}")


def near(a, b, tol=1e-9):
    return a is not None and b is not None and abs(a - b) <= tol


# ---------------- the definition ----------------

check("the entry is the live ADR rule, unchanged", PB_LONG["params"], S.ADR_PARAMS)
check("and the short's too", PB_SHORT["params"], S.ADR_PARAMS)
check("floor 550, cap 800, delta 0.5, backstop 1.5R",
      (RISK["minRiskRupees"], RISK["maxRiskRupees"], RISK["assumedDelta"], RISK["backstopMultiple"]),
      (550, 800, 0.5, 1.5))
check("the ladder is the desk's 1:2 -> +1R",
      (RISK["rewardMultiple"], RISK["trailStartMultiple"], RISK["trailLockMultiple"], RISK["trail"]),
      (2, 2, 1, "ladder"))
check("its own book", (PB_LONG["book"], PB_SHORT["book"]), ("pullback-stop", "pullback-stop"))


# ---------------- the arithmetic ----------------
# The worked example from the question: spot 2,900, low 2,893, lot 175.

stop = plan_stop("LONG", 2900.0, 2893.0, 175, RISK)
check("7 points x 0.5 x 175 = R of 612.50", near(stop.rupees, 612.5), True)
check("in band, so not floored", stop.floored, False)
check("and the stop is the low itself", near(stop.level, 2893.0), True)
check("612.50 is under the 800 cap", over_cap(stop, RISK), False)

small = plan_stop("LONG", 2900.0, 2898.0, 175, RISK)
check("2 points is R 175, raised to 550", (near(small.raw_rupees, 175.0), small.rupees, small.floored),
      (True, 550, True))
check("so the stop moves out to 550 / (0.5 x 175) = 6.29 under", near(small.level, 2900 - 550 / 87.5),
      True)

big = plan_stop("LONG", 1200.0, 1194.0, 400, RISK)
check("6 points x 0.5 x 400 = 1,200 is over the cap", (near(big.rupees, 1200.0), over_cap(big, RISK)),
      (True, True))
check("exactly 800 is not over it", over_cap(plan_stop("LONG", 1000.0, 996.0, 400, RISK), RISK), False)

short = plan_stop("SHORT", 971.0, 974.0, 400, RISK)
check("short: 3 points over the spot x 0.5 x 400 = 600, stop at the rally high",
      (near(short.rupees, 600.0), near(short.level, 974.0)), (True, True))

check("a long's stop is touched by a bar low at the level",
      stock_crossed(stop, {"low": 2893.0, "high": 2899.0}), True)
check("not by one a paise above it", stock_crossed(stop, {"low": 2893.01, "high": 2899.0}), False)
check("a short's by a bar high at the level", stock_crossed(short, {"low": 970.0, "high": 974.0}), True)

t0 = at(DAY, 9, 27)
bars = {t0: {"low": 1003.9, "high": 1006.0}, at(DAY, 9, 28): {"low": 1005.0, "high": 1007.0},
        at(DAY, 9, 26): {"low": 1001.0, "high": 1009.0}}
check("the pullback low is the lowest bar low from the zone to the entry - not before it",
      true_extreme("LONG", bars, t0, at(DAY, 9, 28), 1004.5), 1003.9)
check("never further in than the close-based extreme",
      true_extreme("LONG", {}, t0, at(DAY, 9, 28), 1004.5), 1004.5)
check("the rally high for a short",
      true_extreme("SHORT", bars, t0, at(DAY, 9, 28), 1005.0), 1007.0)


# ---------------- whole sessions, through replay_session ----------------
# The fixtures of test_adr.py. Previous session 1030 / 970 / 1000: R1 1022.92,
# S1 977.08. A 2% ADR at a 1000 close: zone 3.00, turn 1.50. The long breaks
# R1 at 09:20, pulls back to 1004.50 at 09:27 and enters on the turn at 09:28,
# spot 1006.50 - 2.00 above the low.

OHLC = (1030.0, 970.0, 1000.0)
CHAIN = {
    float(k): (1000.0, 100.0) if k == 1020 else (100.0, 1000.0) if k == 980 else (500.0, 500.0)
    for k in range(900, 1121, 10)
}
TWO_PCT = ((1010.0, 990.0, 1000.0),) * 14
STRIKES = tuple(range(900, 1121, 10))


def minute(h, m):
    return at(DAY, h, m)


def prices(spec):
    out = {}
    for first, last, price in spec:
        for m in range(first, last + 1):
            out[minute(9, m)] = float(price)
    return out


ENTRY = [(15, 19, 1000), (20, 24, 1024), (25, 25, 1005.5), (26, 26, 1008), (27, 27, 1004.5)]


def held(spot, wanted, option="CE", strike=1010):
    """Premium bars that put `strike` at `wanted` each minute, whatever the spot.

    The fake archive prices every strike off the minute's at-the-money one, so a
    stock that moves shifts the held strike by 4 per strike step. Undoing that
    here lets a test state the held contract's own price.
    """
    out = {}
    for t, bar in wanted.items():
        centre = min(STRIKES, key=lambda k: abs(k - spot[t])) if t in spot else 1010
        offset = (strike - centre) / 10
        shift = offset * 4.0 * (1 if option == "CE" else -1)
        out[t] = tuple(v + shift for v in bar)
    return out


def flat(value, minutes):
    return {minute(9, m): (value, value, value, value) for m in minutes}


def stock(spot, premium, lot, symbol="ALPHA"):
    return Stock(symbol=symbol, ohlc=OHLC, chain=CHAIN, prices=spot, seed=1000.0, atm=1020.0,
                 premium=premium, lot=lot, history=TWO_PCT)


def run(stocks, setups):
    strategy_ids, chosen = selection(setups)
    return replay_session(FakeArchive(DAY, stocks), DAY,
                          [S.STRATEGIES[s] for s in strategy_ids], GATE_FLOORS, setups=chosen)


# --- R in band: lot 600, R = 2.00 x 0.5 x 600 = 600; stop at the 1004.50 low ---
spot = prices(ENTRY + [(28, 34, 1006.5), (35, 59, 1004.4)])
wanted = {**flat(30.0, range(15, 35)), minute(9, 35): (29.0, 29.0, 28.6, 28.8),
          **flat(28.8, range(36, 60))}
trades, notes = run([stock(spot, held(spot, wanted), lot=600)], ["A-PB"])
check("in band: one trade, entered at 09:28 as the ADR rule does",
      [(p.setup, p.entry_at, p.entry) for p in trades], [("A-PB", minute(9, 28), 30.0)])
if trades:
    p = trades[0]
    pb = p.context["pullbackStop"]
    check("under its own strategy", (p.strategy_id, p.strategy_version),
          ("breakout-retrace-21ema-pbsl", 1))
    check("R is 600, not floored, the stop at the 1004.50 low",
          (near(pb["rupees"], 600.0), pb["floored"], near(pb["level"], 1004.5)), (True, False, True))
    check("so a premium R of 1.00 a unit and a 1:2 target at 32.00",
          (near(p.risk_per_unit, 1.0), near(p.target, 32.0)), (True, True))
    check("with the 1.5R backstop at 28.50 under the 30.00 fill", near(p.stop, 28.5), True)
    check("the stock at 1004.40 ends it at 09:35, at the option's low",
          (p.exit_at, p.exit_price, p.exit_reason), (minute(9, 35), 28.6, "stop"))
    check("a loss of 840: more than R, because the fill is the minute's worst",
          round(p.profit, 2), -840.0)

# --- the stock crosses on a minute the option did not print ---
gap = {t: v for t, v in wanted.items() if t != minute(9, 35)}
gap[minute(9, 36)] = (28.8, 28.9, 28.7, 28.8)
trades, _ = run([stock(spot, held(spot, gap), lot=600)], ["A-PB"])
check("crossed at 09:35 with no option print: exits on the 09:36 print, at its low",
      [(p.exit_at, p.exit_price, p.exit_reason) for p in trades], [(minute(9, 36), 28.7, "stop")])

# --- R floored: lot 250, R = 2.00 x 0.5 x 250 = 250 -> 550; stop 4.40 under, at 1002.10 ---
spot = prices(ENTRY + [(28, 34, 1006.5), (35, 44, 1004.4), (45, 59, 1002.0)])
wanted = {**flat(30.0, range(15, 45)), minute(9, 45): (30.0, 30.0, 29.0, 29.2),
          **flat(29.2, range(46, 60))}
trades, _ = run([stock(spot, held(spot, wanted), lot=250)], ["A-PB"])
if trades:
    p = trades[0]
    pb = p.context["pullbackStop"]
    check("floored: raw R 250 raised to 550",
          (near(pb["rawRupees"], 250.0), pb["rupees"], pb["floored"]), (True, 550, True))
    check("the stop moves out to 1002.10", near(pb["level"], 1002.1), True)
    check("the 1004.40 dip that the pullback low would have stopped does not; 1002.00 does",
          (p.exit_at, p.exit_price, p.exit_reason), (minute(9, 45), 29.0, "stop"))
    check("the floored trade's premium R is 550 / 250 = 2.20", near(p.risk_per_unit, 2.2), True)
else:
    check("floored: a trade is taken", trades, ["one trade"])

# --- R over the cap: lot 1000, R = 2.00 x 0.5 x 1000 = 1,000 ---
spot = prices(ENTRY + [(28, 59, 1006.5)])
trades, notes = run([stock(spot, flat_premium(DAY, 30.0), lot=1000)], ["A-PB"])
check("over the cap: no trade", trades, [])
check("counted as rejected for it", notes["rejected"].get("stop risk over Rs 800"), 1)
adr_trades, _ = run([stock(spot, flat_premium(DAY, 30.0), lot=1000)], ["A-ADR"])
check("where the ADR rule's fixed 550 stop takes the same signal",
      [(p.setup, p.entry_at) for p in adr_trades], [("A-ADR", minute(9, 28))])

# --- the 1.5R backstop: the stock holds, the option falls through 28.50 ---
trades, _ = run([stock(spot, premium_falling_through(DAY, 30.0, 28.0, 40), lot=600)], ["A-PB"])
check("the premium backstop at 1.5R ends it, named backstop",
      [(p.exit_at, p.exit_price, p.exit_reason) for p in trades], [(minute(9, 40), 28.5, "backstop")])
check("a loss of exactly 1.5R", [round(p.profit, 2) for p in trades], [-900.0])

# --- the ladder in the trade's own R; the stock stop disarmed once it moves ---
spot = prices(ENTRY + [(28, 37, 1006.5), (38, 39, 1004.4), (40, 59, 1006.5)])
wanted = {**flat(30.0, range(15, 35)), minute(9, 35): (30.0, 32.0, 30.0, 31.8),
          **flat(31.8, range(36, 40)), minute(9, 40): (31.5, 31.5, 30.5, 30.6),
          **flat(30.6, range(41, 60))}
trades, _ = run([stock(spot, held(spot, wanted), lot=600)], ["A-PB"])
if trades:
    p = trades[0]
    check("+2R (32.00) moves the stop to +1R, 31.00, locking 600 - this trade's R, not 550",
          [(s["step"], near(s["stop"], 31.0), round(s["locked"], 6)) for s in p.ladder],
          [(2, True, 600.0)])
    check("the stock back at 1004.40 after that does not end it - the premium trail does",
          (p.exit_at, p.exit_price, p.exit_reason), (minute(9, 40), 31.0, "trail-stop"))
    check("for +1R", round(p.profit, 2), 600.0)
else:
    check("ladder: a trade is taken", trades, ["one trade"])

# --- the short's mirror: C-PB, lot 400 ---
# Breaks S1 at 09:20, rallies to 974.00 at 09:25, rolls over to 971.00 at 09:26.
# 3.00 x 0.5 x 400 = 600: stop at the 974.00 high.
SHORT = [(15, 19, 978), (20, 20, 972), (21, 24, 970), (25, 25, 974), (26, 39, 971), (40, 59, 974.5)]
spot = prices(SHORT)
wanted = {**flat(25.0, range(15, 40)), minute(9, 40): (25.0, 25.0, 23.9, 24.2),
          **flat(24.2, range(41, 60))}
short_stock = Stock(symbol="SHORTY", ohlc=OHLC, chain=CHAIN, prices=spot, seed=975.0, atm=970.0,
                    premium=held(spot, wanted, option="PE", strike=970), lot=400, history=TWO_PCT)
trades, _ = run([short_stock], ["C-PB"])
if trades:
    p = trades[0]
    pb = p.context["pullbackStop"]
    check("C-PB buys a put under its own strategy",
          (p.setup, p.option_type, p.strategy_id), ("C-PB", "PE", "breakdown-retrace-21ema-pbsl"))
    check("R 600 off the 974.00 rally high, stop at it",
          (pb["side"], near(pb["rupees"], 600.0), near(pb["level"], 974.0)), ("SHORT", True, True))
    check("the stock back up at 974.50 ends it at 09:40, at the put's low",
          (p.exit_at, p.exit_price, p.exit_reason), (minute(9, 40), 23.9, "stop"))
else:
    check("short: a trade is taken", trades, ["one trade"])

# --- all three legs together: B-PB is B, on the fixed 550 ---
A_SPOT = prices(ENTRY + [(28, 59, 1006.5)])
together, notes = run([stock(A_SPOT, flat_premium(DAY, 30.0), lot=250),
                       Stock(symbol="SHORTY", ohlc=OHLC, chain=CHAIN, prices=prices(SHORT[:5] + [(26, 59, 971)]),
                             seed=975.0, atm=970.0, premium=flat_premium(DAY, 25.0), history=TWO_PCT)],
                      ["A-PB", "B-PB", "C-PB"])
check("all three legs run together, as the ADR legs do",
      sorted((p.setup, p.option_type, p.symbol) for p in together),
      [("B-PB", "CE", "ALPHA"), ("C-PB", "PE", "SHORTY")])
b = [p for p in together if p.setup == "B-PB"]
if b:
    check("B-PB has no stock stop and the desk's fixed 550: 2.20 a unit on a 250 lot",
          (b[0].stock_stop, near(b[0].risk_per_unit, 2.2), "pullbackStop" in b[0].context),
          (None, True, False))
c = [p for p in together if p.setup == "C-PB"]
if c:
    check("C-PB's 3.00 off the rally at lot 250 is R 375, floored to 550",
          (c[0].context["pullbackStop"]["floored"], c[0].context["pullbackStop"]["rupees"]),
          (True, 550))


# ---------------- runs are one book or another ----------------

def refused(setups):
    try:
        selection(setups)
    except SystemExit:
        return True
    return False


check("A and A-PB cannot share a run", refused(["A", "A-PB"]), True)
check("nor A-ADR and C-PB", refused(["A-ADR", "C-PB"]), True)
check("nor ORB and a pullback-stop leg", refused(["ORB", "B-PB"]), True)
check("the three pullback-stop legs are one run", refused(["A-PB", "B-PB", "C-PB"]), False)
check("spanning both pullback-stop strategies", selection(["A-PB", "B-PB", "C-PB"])[0],
      ["breakdown-retrace-21ema-pbsl", "breakout-retrace-21ema-pbsl"])


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

if c and b:
    doc = results.trade_document(c[0], "run-pb")
    check("a stored C-PB trade is named for it, with the tag",
          (doc["setup"], doc["setupLabel"]), ("C-PB", "Breakdown & retrace [ADR, SL pullback 550-800]"))
    check("its trigger carries the stop",
          (doc["trigger"]["pullbackStop"]["rupees"], doc["trigger"]["pullbackStop"]["floored"]),
          (550, True))
    check("and its riskPerUnit is that trade's R per unit", near(doc["riskPerUnit"], 2.2), True)
    check("a stored B-PB trade carries no stop of its own",
          "pullbackStop" in results.trade_document(b[0], "run-pb")["trigger"], False)


# ---------------- the dashboard lists the same legs ----------------
SETUPS_TS = (Path(__file__).resolve().parents[3] / "src" / "lib" / "backtest" / "setups.ts")
text = SETUPS_TS.read_text(encoding="utf-8")
for strategy in (PB_LONG, PB_SHORT):
    for setup in strategy["setups"]:
        block = text.split(f'setup: "{setup}"', 1)
        body = block[1].split("}", 1)[0] if len(block) == 2 else ""
        check(f"setups.ts lists {setup} under {strategy['id']} v{strategy['version']}",
              (f'strategy: "{strategy["id"]}"' in body, f"version: {strategy['version']}," in body,
               'book: "pullback-stop"' in body),
              (True, True, True))


print(f"{passed} passed, {len(failed)} failed")
for f in failed:
    print("  FAIL  " + f)
sys.exit(1 if failed else 0)
