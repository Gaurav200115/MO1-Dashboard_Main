"""Checks the ported rule against the numbers registry.ts and position.ts state.

No database and no network: these are the pure parts of the engine, and they are
the parts a silent typo would corrupt invisibly. A sign flipped in setup C or a
rung off by one does not crash - it produces a plausible-looking P&L that is
wrong, which is the worst failure a backtest has.

    py -3.12 tests/test_core.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backtest import strategies as S
from backtest.levels import (ConfirmedLevel, SymbolPlan, chain_window, confirm_levels,
                             fib_pivots, oi_levels, pick_major, pivot_levels)
from backtest.position import evaluate, rung_levels, size_trade
from backtest.signals import Ema, evaluate_symbol, initial_state

RISK = S.SHARED_RISK
PARAMS = dict(S.SHARED_PARAMS, resistanceSkew=4, supportSkew=5)

passed, failed = 0, []


def check(name, got, want):
    global passed
    if got == want:
        passed += 1
    else:
        failed.append(f"{name}\n      got  {got}\n      want {want}")


def close_to(name, got, want, tol=1e-9):
    check(name, round(got, 6) if abs(got - want) > tol else want, want)


# ---------------- the mirror ----------------

check("registry mirror matches registry.ts", S.check_against_registry(), [])
check("long rule buys a call", S.option_type(S.BREAKOUT_RETRACE_21EMA, "A"), "CE")
check("short rule buys a put", S.option_type(S.BREAKDOWN_RETRACE_21EMA, "C"), "PE")


# ---------------- the ladder ----------------
# The spec, verbatim from registry.ts:
#   +1100 (1:2)  stop stays at -550
#   +1650 (1:3)  stop -> +550
#   +2200 (1:4)  stop -> +1650
#   +2750 (1:5)  stop -> +2200

R = RISK["rupeesPerTrade"]
check("rung 1 opens at -1R, target 2R", rung_levels(1, RISK), (-1, 2))
check("1:2 reached - stop does not move", rung_levels(2, RISK), (-1, 3))
check("1:3 reached - stop to +1R", rung_levels(3, RISK), (1, 4))
check("1:4 reached - stop to +3R", rung_levels(4, RISK), (3, 5))
check("1:5 reached - stop to +4R", rung_levels(5, RISK), (4, 6))
check("locked rupees at 1:3", rung_levels(3, RISK)[0] * R, 550)
check("locked rupees at 1:4", rung_levels(4, RISK)[0] * R, 1650)
check("locked rupees at 1:5", rung_levels(5, RISK)[0] * R, 2200)

# Sizing: 550 on a 250-unit lot is 2.20 of premium.
sz = size_trade(100.0, 250, RISK)
check("qty is lot x lots", sz.qty, 250)
close_to("risk per unit", sz.risk_per_unit, 2.2)
close_to("stop one R below the fill", sz.stop, 97.8)
close_to("target at 2R", sz.target, 104.4)
check("a 100-rupee premium is not risk-capped", sz.risk_capped, False)

# A cheap premium cannot absorb a full R.
cheap = size_trade(4.0, 100, RISK)
check("cheap premium is risk-capped", cheap.risk_capped, True)
close_to("capped stop sits at the premium floor", cheap.stop, 0.05)


class P:
    """The slice of a Position that `evaluate` reads."""
    def __init__(self, entry, unit):
        self.entry, self.risk_per_unit = entry, unit
        self.step, self.stop, self.target = 1, entry - unit, entry + 2 * unit


pos = P(100.0, 2.2)
check("holds below the first target", evaluate(pos, 104.0, RISK, 0)["action"], "hold")

v = evaluate(pos, 104.4, RISK, 0)                       # 1:2 touched
check("1:2 ratchets the rung", v["action"], "trail")
check("1:2 leaves the stop alone", round(v["advance"]["stop"], 2), 97.80)
pos.step, pos.stop, pos.target = v["advance"]["step"], v["advance"]["stop"], v["advance"]["target"]

check("stopped at the original stop is a stop, not a trail-stop",
      evaluate(P(100.0, 2.2).__class__(100.0, 2.2), 97.8, RISK, 0)["reason"], "stop")

v = evaluate(pos, 106.6, RISK, 0)                       # 1:3 touched
check("1:3 ratchets", v["action"], "trail")
close_to("1:3 moves the stop to +1R", v["advance"]["stop"], 102.2)
pos.step, pos.stop, pos.target = v["advance"]["step"], v["advance"]["stop"], v["advance"]["target"]
check("a trade stopped above its entry is a trail-stop",
      evaluate(pos, 102.2, RISK, 0)["reason"], "trail-stop")

# A gap can clear more than one rung between two reads.
fast = P(100.0, 2.2)
v = evaluate(fast, 111.0, RISK, 0)
check("a gap walks every rung it cleared", v["advance"]["step"], 5)
close_to("and leaves the stop where that rung says", v["advance"]["stop"], 108.8)


# ---------------- the EMA ----------------

ema = Ema(21)
check("warming returns nothing", ema.push(100.0), None)
for _ in range(19):
    ema.push(100.0)
check("still warming on the 20th", ema.value, None)
check("seeds on the 21st with the SMA", ema.push(100.0), 100.0)
nxt = ema.push(110.0)
close_to("then runs as an EMA", nxt, 110.0 * (2 / 22) + 100.0 * (1 - 2 / 22))


# ---------------- levels ----------------

piv = fib_pivots(110.0, 90.0, 100.0)
close_to("P is the average of high, low and close", piv["P"], 100.0)
close_to("R1 is P + 0.382 of the range", piv["R1"], 100 + 0.382 * 20)
close_to("R3 is P + the range", piv["R3"], 120.0)
check("a session with no range has no pivots", fib_pivots(100.0, 100.0, 100.0), None)

kinds = dict((lab, kind) for lab, _, kind in pivot_levels(piv, 105.0))
check("above P, P acts as support", kinds["P"], "support")
kinds = dict((lab, kind) for lab, _, kind in pivot_levels(piv, 95.0))
check("below P, P acts as resistance", kinds["P"], "resistance")

# ATM +- 8 of a 21-strike ladder centred on 100.
chain = chain_window({float(k): {"CE": 10.0, "PE": 10.0} for k in range(90, 111)}, 100.0)
check("the chain window is 17 strikes", len(chain), 17)
check("centred on the ATM", (chain[0][0], chain[-1][0]), (92.0, 108.0))

# A strike listing only one side is dropped - the OI test needs both.
half = chain_window({100.0: {"CE": 5.0}, 101.0: {"CE": 5.0, "PE": 5.0}}, 100.0)
check("a one-sided strike is not in the chain", [k for k, _, _ in half], [101.0])

lv = oi_levels([(100.0, 100.0, 10.0), (101.0, 10.0, 100.0), (102.0, 10.0, 10.0)])
check("call-heavy is a resistance, put-heavy a support, balanced neither",
      [(k, kind) for k, kind, _, _ in lv], [(100.0, "resistance"), (101.0, "support")])

# One strike in band of two pivots may only confirm the tighter one.
pivots = [("R1", 100.0, "resistance"), ("R2", 100.5, "resistance")]
confirmed = confirm_levels(pivots, [(100.4, "resistance", 100.0, 10.0)], 95.0)
check("a strike confirms one pivot only", [c.pivot for c in confirmed], ["R2"])

# Least gap wins; skew is the gate, not the ranking.
wide_strong = ConfirmedLevel("R1", 100.0, "resistance", 100.7, 1000.0, 10.0, 0.70, 5.0)
tight_ok = ConfirmedLevel("R2", 110.0, "resistance", 110.1, 500.0, 100.0, 0.09, 15.0)
tight_weak = ConfirmedLevel("R3", 120.0, "resistance", 120.0, 100.0, 90.0, 0.00, 25.0)
check("least gap among those clearing the skew gate",
      pick_major([wide_strong, tight_ok, tight_weak], "resistance", 4).pivot, "R2")
check("a one-sided strike skews to infinity",
      ConfirmedLevel("R1", 100.0, "resistance", 100.0, 50.0, 0.0, 0, 0).skew(), float("inf"))
check("a support's skew is puts over calls",
      ConfirmedLevel("S1", 100.0, "support", 100.0, 10.0, 60.0, 0, 0).skew(), 6.0)


# ---------------- the setups ----------------

def plan_with(resistance=None, support=None, marked=None, close=990.0):
    return SymbolPlan(symbol="TEST", close=close, lot_size=250, strike_step=10.0,
                      major_resistance=resistance, major_support=support,
                      marked=marked if marked is not None else
                      [x for x in (resistance, support) if x is not None])


RES = ConfirmedLevel("R1", 1000.0, "resistance", 1000.0, 500.0, 100.0, 0.0, 1.0)
SUP = ConfirmedLevel("S1", 1000.0, "support", 1000.0, 100.0, 600.0, 0.0, 1.0)


def run_a(prices, ema_value=1000.0, entries_open=True):
    """Feeds setup A a price sequence and returns the signal, if any."""
    plan = plan_with(resistance=RES)
    state = initial_state(plan)
    for i, price in enumerate(prices):
        sig = evaluate_symbol(plan, state, PARAMS, price, ema_value, ema_value, i,
                              entries_open, {"A"})
        if sig:
            return sig, state
    return None, state


check("seeded below the level from the close", initial_state(plan_with(resistance=RES)).phase_a, "below")
check("a close above the level seeds idle",
      initial_state(plan_with(resistance=RES, close=1010.0)).phase_a, "below" if False else "idle")

# The full sequence: cross, run up, pull back into the zone, turn up off it.
sig, _ = run_a([1005, 1010, 1003, 1006])
check("setup A fires on the rebound", sig.setup if sig else None, "A")
close_to("off the retracement low", sig.retracement["extreme"], 1003.0)

# Each leg removed in turn must stop it firing.
check("no cross, no trade", run_a([995, 996, 997])[0], None)
check("no retrace into the zone, no trade", run_a([1005, 1010, 1011, 1012])[0], None)
check("reaching the zone is not the trigger", run_a([1005, 1010, 1003])[0], None)
check("a rebound under the EMA is not an entry",
      run_a([1005, 1010, 996.5, 998.5], ema_value=1000.0)[0], None)
check("entries closed, no trade", run_a([1005, 1010, 1003, 1006], entries_open=False)[0], None)

# The EMA rising into a stalled price is not a pullback.
check("EMA caught up, no pullback", run_a([1005, 1004, 1004, 1004])[0], None)

# A bar closing decisively under the EMA ends the setup and requires a fresh break.
plan = plan_with(resistance=RES)
state = initial_state(plan)
for i, px in enumerate([1005, 1010]):
    evaluate_symbol(plan, state, PARAMS, px, 1000.0, 1000.0, i, True, {"A"})
evaluate_symbol(plan, state, PARAMS, 994.0, 1000.0, 994.0, 2, True, {"A"})
check("a close under the EMA resets the setup", state.phase_a, "below")

# One trade per stock per day.
plan = plan_with(resistance=RES)
state = initial_state(plan)
state.trades_today = 1
got = [evaluate_symbol(plan, state, PARAMS, px, 1000.0, 1000.0, i, True, {"A"})
       for i, px in enumerate([1005, 1010, 1003, 1006])]
check("the per-symbol daily cap blocks a second", [g for g in got if g], [])


# Setup C is the mirror: break down, rally to the EMA, roll over.
def run_c(prices, ema_value=1000.0):
    plan = plan_with(support=SUP, close=1010.0)
    state = initial_state(plan)
    for i, price in enumerate(prices):
        sig = evaluate_symbol(plan, state, PARAMS, price, ema_value, ema_value, i, True, {"C"})
        if sig:
            return sig, state
    return None, state


check("seeded above the support from the close",
      initial_state(plan_with(support=SUP, close=1010.0)).phase_c, "above")
sig, _ = run_c([995, 990, 997, 994])
check("setup C fires on the roll-over", sig.setup if sig else None, "C")
close_to("off the rally high", sig.retracement["extreme"], 997.0)
check("no breakdown, no short", run_c([1005, 1006])[0], None)
check("a roll-over above the EMA is not an entry", run_c([995, 990, 1003.5, 1001])[0], None)
check("reaching the zone is not the trigger", run_c([995, 990, 997])[0], None)

# The short must not fire on a stock that is going up.
check("setup C never fires on a rally through the level", run_c([1005, 1010, 1020])[0], None)


# Setup B: holding above the major support, crossing another marked level.
OTHER = ConfirmedLevel("R1", 1050.0, "resistance", 1050.0, 500.0, 100.0, 0.0, 1.0)


def run_b(prices, ema_value=1000.0, marked=(SUP, OTHER), close=1010.0):
    plan = plan_with(support=SUP, marked=list(marked), close=close)
    state = initial_state(plan)
    for i, price in enumerate(prices):
        sig = evaluate_symbol(plan, state, PARAMS, price, ema_value, ema_value, i, True, {"B"})
        if sig:
            return sig, state
    return None, state


sig, _ = run_b([1020, 1055])
check("setup B fires crossing another level", sig.setup if sig else None, "B")
check("and names the level it crossed", sig.level.pivot if sig else None, "R1")
check("and the support it is standing on", sig.basis.pivot if sig else None, "S1")
check("under the EMA, no trade", run_b([1020, 1055], ema_value=1060.0)[0], None)
check("wobbling around its own support is not a cross", run_b([1020, 999, 1001])[0], None)

# "Holding above the major support" is tested at the moment of the cross. The
# candidate has to sit *below* the support for that to be constructable at all -
# anything above it is crossed only from a price that is already holding.
LOWER = ConfirmedLevel("S2", 900.0, "support", 900.0, 100.0, 600.0, 0.0, 10.0)
check("below the major support, no trade",
      run_b([850, 950], marked=(SUP, LOWER), close=850.0)[0], None)

# And the cross is *consumed* by that tick even though it could not be taken:
# signals.ts updates the below-map on every tick regardless of whether the setup
# fired, so price must drop back under the level and cross it again to re-arm.
# Faithful to the live rule rather than a convenience - worth knowing, because it
# means a level crossed while the stock was under its major support is spent.
check("a cross made under the support does not fire later",
      run_b([850, 950, 1020, 1030], marked=(SUP, LOWER), close=850.0)[0], None)
sig, _ = run_b([850, 950, 1020, 880, 1020], marked=(SUP, LOWER), close=850.0)
check("it re-arms once price crosses the level again",
      sig.level.pivot if sig else None, "S2")

# A strategy must only be able to fire its own legs.
plan = plan_with(resistance=RES, support=SUP)
state = initial_state(plan)
got = [evaluate_symbol(plan, state, PARAMS, px, 1000.0, 1000.0, i, True, {"C"})
       for i, px in enumerate([1005, 1010, 1003, 1006])]
check("the short rule cannot fire setup A", [g for g in got if g], [])


# ---------------- report ----------------

print(f"{passed} passed, {len(failed)} failed")
for f in failed:
    print("  FAIL  " + f)
sys.exit(1 if failed else 0)
