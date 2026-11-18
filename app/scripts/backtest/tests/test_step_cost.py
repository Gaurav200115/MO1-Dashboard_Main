"""The step-cost gate - long v11 / short v7.

A contract is skipped when one price step across the lot costs more than 20%
of the risk: 110 of the 550. On ETERNAL (lot 2,425) at a five-paisa tick one
step is 121 - a single tick of slippage is a fifth of the risk before anything
has gone wrong. The same lot on a one-paisa contract is 24 a step, and trades.

The archive stores no tick sizes, so the backtest reads a contract's step from
its own prices (gate.contract_tick). What this file pins down:

  - contract_tick: off the five-paisa grid anywhere in the day -> one paisa
  - the threshold arithmetic, at and just past 110
  - whole sessions: a big lot on five paise is skipped by live v11 and taken by
    A-SK (the v10 rule, no gate); the same lot on one paisa is taken by both;
    a normal lot is untouched

    py -3.12 tests/test_step_cost.py
"""
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fake_archive import FakeArchive, Stock, at, flat_premium
from settings import GATE_FLOORS
from backtest import strategies as S
from backtest.gate import contract_tick, step_too_costly
from backtest.runner import replay_session
from backtest.strategies import selection

DAY = dt.date(2026, 10, 15)

passed, failed = 0, []


def check(name, got, want):
    global passed
    if got == want:
        passed += 1
    else:
        failed.append(f"{name}\n      got  {got}\n      want {want}")


# ---------------- the definition ----------------

check("live long v11 and short v7 carry the gate at 20%",
      [(S.BREAKOUT_RETRACE_21EMA["version"], S.BREAKOUT_RETRACE_21EMA["params"]["maxStepCostOfRiskPct"]),
       (S.BREAKDOWN_RETRACE_21EMA["version"], S.BREAKDOWN_RETRACE_21EMA["params"]["maxStepCostOfRiskPct"])],
      [(11, 20), (7, 20)])
check("the frozen backtest variants do not", "maxStepCostOfRiskPct" in S.BREAKOUT_RETRACE_21EMA_SK["params"], False)


# ---------------- the tick and the threshold ----------------

bar = lambda o, h, l, c: {"open": o, "high": h, "low": l, "close": c}
check("all on the five-paisa grid -> 0.05", contract_tick([bar(3.9, 3.95, 3.85, 3.9)]), 0.05)
check("one price off it anywhere in the day -> 0.01",
      contract_tick([bar(3.9, 3.95, 3.85, 3.9), bar(3.9, 3.93, 3.9, 3.91)]), 0.01)
check("no bars -> the five-paisa default", contract_tick([]), 0.05)
check("ETERNAL: 0.05 x 2,425 = 121 > 110 -> skip", step_too_costly(0.05, 2425, 550, 20), True)
check("exactly 110 (0.05 x 2,200) is not over", step_too_costly(0.05, 2200, 550, 20), False)
check("the same lot on one paisa: 24 -> trade", step_too_costly(0.01, 2425, 550, 20), False)
check("IDFCFIRSTB on one paisa: 0.01 x 9,275 = 93 -> trade", step_too_costly(0.01, 9275, 550, 20), False)


# ---------------- whole sessions ----------------
# The fixtures of test_adr.py: ALPHA breaks R1 at 09:20, pulls back to 1004.50
# at 09:27 and enters at 09:28. Only the lot and the premium's grid change.

OHLC = (1030.0, 970.0, 1000.0)
CHAIN = {
    float(k): (1000.0, 100.0) if k == 1020 else (100.0, 1000.0) if k == 980 else (500.0, 500.0)
    for k in range(900, 1121, 10)
}
TWO_PCT = ((1010.0, 990.0, 1000.0),) * 14


def prices(spec):
    out = {}
    for first, last, price in spec:
        for m in range(first, last + 1):
            out[at(DAY, 9, m)] = float(price)
    return out


A_PRICES = prices([(15, 19, 1000), (20, 24, 1024), (25, 25, 1005.5), (26, 26, 1008),
                   (27, 27, 1004.5), (28, 59, 1006.5)])


def alpha(lot, premium):
    # strikes nine apart keep every other strike's price off the held one, so
    # the held contract's grid is exactly the premium's.
    return Stock(symbol="ALPHA", ohlc=OHLC, chain=CHAIN, prices=A_PRICES, seed=1000.0, atm=1020.0,
                 premium=flat_premium(DAY, premium), lot=lot, history=TWO_PCT, skew_per_strike=0.0)


def run(stock, setups):
    strategy_ids, chosen = selection(setups)
    return replay_session(FakeArchive(DAY, [stock]), DAY,
                          [S.STRATEGIES[s] for s in strategy_ids], GATE_FLOORS, setups=chosen)


trades, notes = run(alpha(2425, 3.90), ["A"])
check("lot 2,425 on a five-paisa contract: live v11 skips it", trades, [])
check("counted as step-too-costly", notes["rejected"].get("step-too-costly"), 1)
sk, _ = run(alpha(2425, 3.90), ["A-SK"])
check("A-SK (v10, no gate) takes the same signal", [(p.setup, p.entry_at.strftime("%H:%M")) for p in sk],
      [("A-SK", "09:28")])

trades, notes = run(alpha(2425, 3.91), ["A"])
check("the same lot on a one-paisa contract: taken", [(p.setup, p.strategy_version) for p in trades], [("A", 11)])
check("nothing counted against the gate", notes["rejected"].get("step-too-costly"), None)

trades, _ = run(alpha(250, 30.0), ["A"])
check("a normal lot (250 x 0.05 = 12.50) is untouched", [p.entry_at.strftime("%H:%M") for p in trades], ["09:28"])


print(f"{passed} passed, {len(failed)} failed")
for f in failed:
    print("  FAIL  " + f)
sys.exit(1 if failed else 0)
