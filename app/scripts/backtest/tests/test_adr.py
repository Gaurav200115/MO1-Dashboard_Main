"""The ADR variant of the retrace rules - A-ADR, B-ADR, C-ADR. Backtest only.

The live rules arm when price comes within 0.4% of the 21 EMA and enter on a
0.2% turn off the pullback's extreme. The ADR variant measures both in the
stock's own 14-session average daily range instead (0.15 ADR and 0.075 ADR).
What this file pins down:

  - the ADR arithmetic, and that it refuses to invent an ADR from short history
  - the calibration: a stock on the measured median ADR behaves like the live rule
  - the worked examples, live vs ADR, on the same price path:
      a wild stock's real pullback the live rule misses, and the ADR rule takes
      a wild stock's noise the live rule enters on, and the ADR rule waits out
      a calm stock the live rule arms on too early, and the ADR rule arms closer in
      the closed-bar kill line, and the short's mirror of all of it
  - whole sessions through `replay_session`, named A-ADR / B-ADR / C-ADR
  - that ADR legs are never mixed with the desk's own legs in one run
  - that a stored ADR trade carries its band, and a live one is unchanged
  - that the variant is frozen against the live rule it was copied from

    py -3.12 tests/test_adr.py
"""
import datetime as dt
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fake_archive import FakeArchive, Stock, at, flat_premium
from settings import GATE_FLOORS
from backtest import strategies as S
from backtest.adr import AdrRuler, adr_pct, daily_range_pct
from backtest.levels import ConfirmedLevel, SymbolPlan
from backtest.runner import replay_session
from backtest.signals import evaluate_symbol, initial_state
from backtest.strategies import selection

DAY = dt.date(2026, 10, 15)
LIVE_LONG, LIVE_SHORT = S.BREAKOUT_RETRACE_21EMA, S.BREAKDOWN_RETRACE_21EMA
ADR_LONG, ADR_SHORT = S.BREAKOUT_RETRACE_21EMA_ADR, S.BREAKDOWN_RETRACE_21EMA_ADR

passed, failed = 0, []


def check(name, got, want):
    global passed
    if got == want:
        passed += 1
    else:
        failed.append(f"{name}\n      got  {got}\n      want {want}")


def close_to(a, b, tol=1e-9):
    return a is not None and b is not None and abs(a - b) <= tol


# ---------------- the arithmetic ----------------

check("a day's range is a percent of its close", daily_range_pct(1030, 970, 1000), 6.0)
check("a row with high under low is not a range", daily_range_pct(970, 1030, 1000), None)
check("nor is one with no close", daily_range_pct(1030, 970, 0), None)

d0 = dt.date(2026, 9, 1)
flat = [(d0 + dt.timedelta(days=i), 1010.0, 990.0, 1000.0) for i in range(14)]
check("14 sessions of a 2% range is an ADR of 2%", close_to(adr_pct(flat, 14), 2.0), True)
check("13 sessions is no ADR at all", adr_pct(flat[:13], 14), None)

# Twenty sessions: six old wide ones, then fourteen narrow ones. Only the last
# fourteen count, and order in the input does not matter.
old = [(d0 - dt.timedelta(days=10 - i), 1100.0, 900.0, 1000.0) for i in range(6)]
check("only the last 14 sessions count", close_to(adr_pct(list(reversed(old + flat)), 14), 2.0), True)

# A bad row is skipped rather than averaged in - and if that leaves fewer than
# 14, there is no ADR.
bad = flat[:13] + [(d0 + dt.timedelta(days=13), 990.0, 1010.0, 1000.0)]
check("a bad row is not averaged in", adr_pct(bad, 14), None)


# ---------------- the calibration ----------------
# Measured 2026-11-13: the median 14-session ADR across the desk's 186 stocks is
# 2.716% of price. A stock sitting exactly there must behave like the live rule.

def plan_with(adr, close=1000.0, resistance=None, support=None, marked=None):
    return SymbolPlan(symbol="TEST", close=close, lot_size=250, strike_step=10.0,
                      major_resistance=resistance, major_support=support,
                      marked=marked if marked is not None else
                      [lv for lv in (resistance, support) if lv is not None],
                      adr_pct=adr)


median = AdrRuler(plan_with(2.716), ADR_LONG["params"])
check("the median stock's zone is the live 0.4%",
      abs(median.zone / 1000 * 100 - LIVE_LONG["params"]["emaZonePct"]) < 0.01, True)
check("and its turn the live 0.2%",
      abs(median.turn / 1000 * 100 - LIVE_LONG["params"]["entryReboundPct"]) < 0.005, True)

wild = AdrRuler(plan_with(3.5, close=1200.0), ADR_LONG["params"])
check("a wild stock (3.5% ADR at 1200) gets a 6.30 zone", round(wild.zone, 4), 6.3)
check("and a 3.15 turn", round(wild.turn, 4), 3.15)
calm = AdrRuler(plan_with(1.0, close=1200.0), ADR_LONG["params"])
check("a calm stock (1% ADR at 1200) gets a 1.80 zone", round(calm.zone, 4), 1.8)
check("and a 0.90 turn", round(calm.turn, 4), 0.9)


# ---------------- the worked examples, live vs ADR ----------------
# EMA held at 1200. The live rule's zone is 0.4% of it - 4.80 - for every stock.

def level(pivot, value, kind):
    return ConfirmedLevel(pivot, value, kind, value, 1000.0, 100.0, 0.1, 0.5)


RES = level("R1", 1205.0, "resistance")
SUP = level("S1", 1150.0, "support")


def drive(plan, params, path, setups, ema=1200.0):
    """Feeds a price path to one stock. Each step is a price, or (price, closed bar).

    Returns (signal, step it fired on, final state).
    """
    state = initial_state(plan)
    for i, step in enumerate(path):
        ltp, bar = step if isinstance(step, tuple) else (step, None)
        signal = evaluate_symbol(plan, state, params, ltp, ema, bar, at(DAY, 10, i),
                                 True, setups)
        if signal is not None:
            return signal, i, state
    return None, None, state


def long_plan(adr):
    # Closed below the resistance, so the first print above it is the break.
    return plan_with(adr, close=1200.0, resistance=RES, support=SUP)


LIVE, ADR = LIVE_LONG["params"], ADR_LONG["params"]

# Wild stock, a real pullback: breaks 1205, runs to 1240, comes back to 1205.50
# (5.50 off the EMA), then rallies.
path = [1210, 1240, 1205.5, 1212, 1230]
sig, _, state = drive(long_plan(None), LIVE, path, {"A"})
check("live: 5.50 off the EMA is outside 4.80, so the move is missed", sig, None)
check("live: still waiting for a retrace", state.note, "waiting for retrace")
sig, i, _ = drive(long_plan(3.5), ADR, path, {"A"})
check("ADR wild: 5.50 is inside its 6.30 zone, so it arms and enters", i, 3)
check("ADR wild: off the 1205.50 low", sig.retracement["extreme"] if sig else None, 1205.5)
check("ADR wild: the trade records its band",
      (round(sig.adr["zone"], 4), round(sig.adr["turn"], 4)) if sig else None, (6.3, 3.15))

# Wild stock, noise: pulls back to 1204, wiggles 2.50 up, then keeps falling.
path = [1210, 1240, 1204, 1206.5, 1203, 1201]
sig, i, _ = drive(long_plan(None), LIVE, path, {"A"})
check("live: enters on the 2.50 wiggle (needs 0.2% = 2.41)", (i, sig.spot if sig else None),
      (3, 1206.5))
sig, _, state = drive(long_plan(3.5), ADR, path, {"A"})
check("ADR wild: a 2.50 wiggle is not its 3.15 turn - no trade", sig, None)
check("ADR wild: still armed, off the deepening low", round(state.zone_low, 2), 1201.0)

# Calm stock: pulls back only to 1203.50, then turns.
path = [1210, 1240, 1203.5, 1206.5]
sig, i, _ = drive(long_plan(None), LIVE, path, {"A"})
check("live: 3.50 off the EMA arms it, entry 1206.50", (i, sig.spot if sig else None), (3, 1206.5))
sig, _, state = drive(long_plan(1.0), ADR, path, {"A"})
check("ADR calm: 3.50 is outside its 1.80 zone - not a retrace yet", sig, None)
sig, i, _ = drive(long_plan(1.0), ADR, path + [1201.5, 1202.5], {"A"})
check("ADR calm: arms at 1201.50 and enters 0.90 up, closer to the EMA",
      (i, sig.spot if sig else None, sig.retracement["extreme"] if sig else None),
      (5, 1202.5, 1201.5))

# The kill line: a 5-minute bar closes at 1194, 6.00 under the EMA.
path = [1210, 1240, (1196, 1194)]
_, _, state = drive(long_plan(None), LIVE, path, {"A"})
check("live: a close 6.00 under the EMA is past 4.80 - setup dead", state.phase_a, "below")
_, _, state = drive(long_plan(3.5), ADR, path, {"A"})
check("ADR wild: inside its 6.30 - the setup lives, and arms", state.phase_a, "retraced")

# No ADR history: the retrace leg cannot arm, and says why.
sig, _, state = drive(long_plan(None), ADR, [1210, 1240, 1205.5, 1212], {"A"})
check("no ADR: setup A cannot arm", sig, None)
check("no ADR: and the note says why", state.note, "no ADR history")
# ...but setup B has no retrace to measure, so it is unaffected.
b_plan = plan_with(None, close=1200.0, resistance=RES, support=SUP, marked=[RES, SUP])
sig, _, _ = drive(b_plan, ADR, [1210], {"B"})
check("no ADR: setup B still trades", sig.setup if sig else None, "B")


# --- the short, mirrored -------------------------------------------------
SHORT_SUP = level("S1", 1195.0, "support")


def short_plan(adr):
    # Closed above the support, so the first print below it is the break.
    return plan_with(adr, close=1200.0, support=SHORT_SUP, marked=[SHORT_SUP])


path = [1190, 1160, 1194.5, 1188]
sig, _, _ = drive(short_plan(None), LIVE_SHORT["params"], path, {"C"})
check("live short: a rally to 5.50 under the EMA is outside 4.80 - missed", sig, None)
sig, i, _ = drive(short_plan(3.5), ADR_SHORT["params"], path, {"C"})
check("ADR short: inside 6.30, arms off the 1194.50 high and rolls over",
      (i, sig.setup if sig else None, sig.retracement["extreme"] if sig else None),
      (3, "C", 1194.5))

# The short's kill line: a bar closing 6.00 back above the EMA.
_, _, state = drive(short_plan(None), LIVE_SHORT["params"], [1190, 1160, (1204, 1206)], {"C"})
check("live short: a close 6.00 over the EMA kills it", state.phase_c, "above")
_, _, state = drive(short_plan(3.5), ADR_SHORT["params"], [1190, 1160, (1204, 1206)], {"C"})
check("ADR short: inside 6.30 it survives and arms", state.phase_c, "retraced")


# ---------------- whole sessions, through replay_session ----------------
# The same fixtures as test_strategies.py. Previous session 1030 / 970 / 1000:
# R1 1022.92 (confirmed by the 1020 strike), S1 977.08 (by 980). Each stock's
# previous 14 sessions have a 2% range, so its ADR is 20.00 at a 1000 close:
# zone 3.00, turn 1.50. The live rule's zone is 0.4% of the EMA, about 4.01.

OHLC = (1030.0, 970.0, 1000.0)
CHAIN = {
    float(k): (1000.0, 100.0) if k == 1020 else (100.0, 1000.0) if k == 980 else (500.0, 500.0)
    for k in range(900, 1121, 10)
}
TWO_PCT = ((1010.0, 990.0, 1000.0),) * 14


def minute(h, m):
    return at(DAY, h, m)


def prices(spec):
    out = {}
    for first, last, price in spec:
        for m in range(first, last + 1):
            out[minute(9, m)] = float(price)
    return out


# 09:15-09:19  1000    below R1
# 09:20-09:24  1024    breaks R1; the 21 EMA is 1002.18 from 09:25
# 09:25        1005.5  3.32 off the EMA: inside the live 4.01, outside the ADR 3.00
# 09:26        1008    live enters here - 0.2% up off 1005.50
# 09:27        1004.5  2.32 off: inside the ADR zone - it arms
# 09:28-       1006.5  1.50 up off 1004.50 - ADR enters here
A_PRICES = prices([(15, 19, 1000), (20, 24, 1024), (25, 25, 1005.5), (26, 26, 1008),
                   (27, 27, 1004.5), (28, 59, 1006.5)])


def a_stock(symbol="ALPHA", history=TWO_PCT):
    return Stock(symbol=symbol, ohlc=OHLC, chain=CHAIN, prices=A_PRICES, seed=1000.0,
                 atm=1020.0, premium=flat_premium(DAY, 30.0), history=history)


SHORT_PRICES = prices([(15, 19, 978), (20, 20, 972), (21, 24, 970),
                       (25, 25, 974), (26, 59, 971)])


def short_stock(symbol="SHORTY"):
    return Stock(symbol=symbol, ohlc=OHLC, chain=CHAIN, prices=SHORT_PRICES, seed=975.0,
                 atm=970.0, premium=flat_premium(DAY, 25.0), history=TWO_PCT)


def run(stocks, setups):
    strategy_ids, chosen = selection(setups)
    return replay_session(FakeArchive(DAY, stocks), DAY,
                          [S.STRATEGIES[s] for s in strategy_ids], GATE_FLOORS,
                          setups=chosen)


live, _ = run([a_stock()], ["A"])
adr, notes = run([a_stock()], ["A-ADR"])

check("live A takes the 09:26 entry", [(p.setup, p.entry_at) for p in live],
      [("A", minute(9, 26))])
check("A-ADR waits for the closer pullback, 09:28", [(p.setup, p.entry_at) for p in adr],
      [("A-ADR", minute(9, 28))])
if adr:
    p = adr[0]
    check("A-ADR runs under its own strategy", (p.strategy_id, p.strategy_version),
          ("breakout-retrace-21ema-adr", 1))
    check("and buys a call", p.option_type, "CE")
    check("off the 1004.50 low", p.context["retracement"]["extreme"], 1004.5)
    check("with the stock's ADR on the trade",
          (round(p.context["adr"]["pct"], 6), round(p.context["adr"]["rupees"], 6),
           round(p.context["adr"]["zone"], 6), round(p.context["adr"]["turn"], 6)),
          (2.0, 20.0, 3.0, 1.5))
    check("and the same SL ladder as live: first move at 1:2 to +1R",
          (S.STRATEGIES[p.strategy_id]["risk"]["trailStartMultiple"],
           S.STRATEGIES[p.strategy_id]["risk"]["trailLockMultiple"]), (2, 1))
if live:
    check("a live trade carries no ADR", live[0].context["adr"], None)
check("an ADR run counts its signals under the ADR name", dict(notes["bySetup"]), {"A-ADR": 1})

# Without 14 sessions of history the retrace leg is skipped, and counted.
short_history = run([a_stock(history=TWO_PCT[:10])], ["A-ADR"])
check("a stock with 10 sessions of history takes no A-ADR trade", short_history[0], [])
check("and is counted as skipped",
      short_history[1]["skipped"].get("no 14-session ADR - retrace legs could not arm"), 1)

# All three ADR legs together: the same desk-wide cap, the same one-trade-per-
# stock rule, so ALPHA's 09:20 cross goes to B-ADR and A-ADR is shut out -
# exactly as A and B behave together live.
together, notes = run([a_stock(), short_stock()], ["A-ADR", "B-ADR", "C-ADR"])
check("all three ADR legs run together",
      sorted((p.setup, p.option_type, p.symbol) for p in together),
      [("B-ADR", "CE", "ALPHA"), ("C-ADR", "PE", "SHORTY")])
check("C-ADR buys a put under the short ADR rule",
      [(p.strategy_id, p.strategy_version) for p in together if p.setup == "C-ADR"],
      [("breakdown-retrace-21ema-adr", 1)])
check("C-ADR enters on the 09:26 roll-over",
      [p.entry_at for p in together if p.setup == "C-ADR"], [minute(9, 26)])


# ---------------- runs are one book or the other ----------------

def refused(setups):
    try:
        selection(setups)
    except SystemExit:
        return True
    return False


check("A and A-ADR cannot share a run", refused(["A", "A-ADR"]), True)
check("nor C and B-ADR", refused(["C", "B-ADR"]), True)
check("nor ORB and an ADR leg", refused(["ORB", "C-ADR"]), True)
check("the three ADR legs together are one run", refused(["A-ADR", "B-ADR", "C-ADR"]), False)
check("which spans both ADR strategies", selection(["A-ADR", "B-ADR", "C-ADR"])[0],
      ["breakdown-retrace-21ema-adr", "breakout-retrace-21ema-adr"])
check("the desk's own legs still run together", refused(["A", "B", "C"]), False)

import run as cli  # noqa: E402  (the CLI, for its default)
check("the CLI's default is still the desk's own legs", sorted(cli.DEFAULT_SETUPS),
      ["A", "B", "C"])


# ---------------- the tag ----------------

for strategy in (ADR_LONG, ADR_SHORT):
    check(f"{strategy['id']} is tagged ADR, SL 1:2->1", "ADR, SL 1:2->1" in strategy["name"], True)
    check(f"{strategy['id']} is backtest only", strategy.get("backtestOnly"), True)
    for setup, label in strategy["setupLabels"].items():
        check(f"{setup}'s label carries the tag", "ADR, SL 1:2->1" in label, True)


# ---------------- frozen against the live rule it was copied from ----------------
# The ADR variant is the live long v8 / short v4 with only the entry ruler
# changed. If the live rule moves on, these fail: decide whether the ADR variant
# follows (as a new version) rather than letting it drift silently.

ENTRY_KEYS_LIVE = {"emaZonePct", "entryReboundPct"}
ENTRY_KEYS_ADR = {"entryBasis", "adrPeriod", "adrZoneMultiple", "adrTurnMultiple"}
for live_rule, adr_rule in ((LIVE_LONG, ADR_LONG), (LIVE_SHORT, ADR_SHORT)):
    check(f"{adr_rule['id']} params match {live_rule['id']} v{live_rule['version']} "
          f"apart from the entry ruler",
          {k: v for k, v in adr_rule["params"].items() if k not in ENTRY_KEYS_ADR},
          {k: v for k, v in live_rule["params"].items() if k not in ENTRY_KEYS_LIVE})
    check(f"{adr_rule['id']} risk matches {live_rule['id']} v{live_rule['version']}",
          adr_rule["risk"], live_rule["risk"])


# ---------------- the stored trade ----------------
# results.py imports the Mongo driver at the top; nothing here talks to Mongo,
# so a stand-in lets the document be built on a machine without it.
if "pymongo" not in sys.modules:
    try:
        import pymongo  # noqa: F401
    except ImportError:
        stub = types.ModuleType("pymongo")
        stub.MongoClient = stub.UpdateOne = object
        stub.ReturnDocument = types.SimpleNamespace(AFTER=True)
        sys.modules["pymongo"] = stub
from backtest import results  # noqa: E402

if adr and live:
    doc = results.trade_document(adr[0], "run-adr")
    check("a stored ADR trade is named A-ADR", doc["setup"], "A-ADR")
    check("its label carries the tag", doc["setupLabel"], "Break & retrace [ADR, SL 1:2->1]")
    check("its strategy name carries the tag", doc["strategyName"],
          "Level Break -> 21 EMA Retrace [ADR, SL 1:2->1]")
    check("and its trigger carries the band",
          (doc["trigger"]["adr"]["zone"], doc["trigger"]["adr"]["turn"],
           doc["trigger"]["adr"]["period"]), (3.0, 1.5, 14))
    check("a stored live trade has exactly the old shape", "adr" in
          results.trade_document(live[0], "run-live")["trigger"], False)


# ---------------- the dashboard lists the same legs ----------------
# setups.ts describes these for the picker; the id, strategy and version must
# match what the worker will replay.
SETUPS_TS = (Path(__file__).resolve().parents[3] / "src" / "lib" / "backtest" / "setups.ts")
text = SETUPS_TS.read_text(encoding="utf-8")
for strategy in (ADR_LONG, ADR_SHORT):
    for setup in strategy["setups"]:
        block = text.split(f'setup: "{setup}"', 1)
        body = block[1].split("}", 1)[0] if len(block) == 2 else ""
        check(f"setups.ts lists {setup} under {strategy['id']} v{strategy['version']}",
              (f'strategy: "{strategy["id"]}"' in body, f"version: {strategy['version']}," in body),
              (True, True))


print(f"{passed} passed, {len(failed)} failed")
for f in failed:
    print("  FAIL  " + f)
sys.exit(1 if failed else 0)
