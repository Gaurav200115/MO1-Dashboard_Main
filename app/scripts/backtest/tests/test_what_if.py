"""Each trade replayed under the live exit and the 1.5R break-even (what_if.py).

  - the two exits differ only in the break-even
  - a trade that touches 1.5R and falls back: a scratch under one, -1R under the other
  - the live shadow outlives a real trade stopped at cost, and can go on to ratchet
  - the shadow matching the run's own rule reproduces the real trade exactly
  - shadows hold no slot; the ATR stop and the Rs 600 ladder carry into them
  - the stored trade carries both

    py -3.12 tests/test_what_if.py
"""
import datetime as dt
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fake_archive import FakeArchive, Stock, at
from settings import GATE_FLOORS
from backtest import strategies as S
from backtest import what_if
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


# ---------------- the two exits ----------------
base = dict(S.BREAKOUT_RETRACE_21EMA_SK["risk"], rupeesPerTrade=550)
check("liveRule: no break-even", "breakevenAtR" in what_if.risk_for(base, "liveRule"), False)
check("breakevenAt15: cost at 1.5R", what_if.risk_for(base, "breakevenAt15")["breakevenAtR"], 1.5)
check("nothing else differs",
      {k: v for k, v in what_if.risk_for(base, "breakevenAt15").items() if k != "breakevenAtR"},
      what_if.risk_for(base, "liveRule"))
check("a rule without a break-even gains one only in its shadow",
      ("breakevenAtR" in S.BREAKOUT_RETRACE_21EMA["risk"],
       what_if.risk_for(S.BREAKOUT_RETRACE_21EMA["risk"], "breakevenAt15")["breakevenAtR"]), (False, 1.5))


# ---------------- whole sessions ----------------
# ALPHA (test_pivot_skew.py's fixture) enters A at 09:28 on a premium of 30.
# R = 550 on the 250 lot = 2.20 a unit: stop 27.80, 1.5R = 33.30, 2R = 34.40.

def chain_dict():
    return {float(k): (1000.0, 100.0) if k == 1020 else (100.0, 1000.0) if k == 980 else (500.0, 500.0)
            for k in range(900, 1121, 10)}


def prices():
    out = {}
    for first, last, price in [(15, 19, 1000), (20, 24, 1024), (25, 25, 1005.5), (26, 26, 1008),
                               (27, 27, 1004.5), (28, 59, 1006.5)]:
        for m in range(first, last + 1):
            out[at(DAY, 9, m)] = float(price)
    return out


def path(spec):
    """{minute: (o, h, l, c)} from [(first, last, o, h, l, c)], 09:mm."""
    out = {}
    for first, last, *bar in spec:
        for m in range(first, last + 1):
            out[at(DAY, 9, m)] = tuple(float(x) for x in bar)
    return out


# Touches 33.50 (past 1.5R) at 09:36, falls to 29 at 09:40 - through cost, not
# through 27.80 - then recovers to 35 (past 2R) from 09:45 and holds there.
RECOVERS = path([(15, 35, 30, 30, 30, 30), (36, 36, 30, 33.5, 30, 33), (37, 39, 33, 33, 33, 33),
                 (40, 40, 33, 33, 29, 29), (41, 44, 29, 29, 29, 29), (45, 45, 29, 35, 29, 35),
                 (46, 59, 35, 35, 35, 35)])
# Touches 1.5R, then falls straight through the stop to 20.
COLLAPSES = path([(15, 35, 30, 30, 30, 30), (36, 36, 30, 33.5, 30, 33), (37, 39, 33, 33, 33, 33),
                  (40, 40, 33, 33, 20, 20), (41, 59, 20, 20, 20, 20)])


def alpha(premium):
    return Stock(symbol="ALPHA", ohlc=(1030.0, 970.0, 1000.0), chain=chain_dict(), prices=prices(),
                 seed=1000.0, atm=1020.0, premium=premium, history=((1010.0, 990.0, 1000.0),) * 14,
                 seed_range=6.0)


def run(stocks, setups):
    strategy_ids, chosen = selection(setups)
    trades, _ = replay_session(FakeArchive(DAY, stocks), DAY, [S.STRATEGIES[s] for s in strategy_ids],
                               GATE_FLOORS, setups=chosen)
    return trades


def outcome(w):
    return (w["reason"], round(w["profit"], 2))


sk = run([alpha(COLLAPSES)], ["A-SK"])
check("one A-SK trade at 09:28", [(p.setup, p.entry_at.strftime("%H:%M"), p.entry) for p in sk],
      [("A-SK", "09:28", 30.0)])
real = sk[0]
check("the run's own rule (cost at 1.5R): out at cost", (real.exit_reason, round(real.profit, 2)),
      ("breakeven", 0.0))
check("breakevenAt15 reproduces the real trade exactly", outcome(real.context["whatIf"]["breakevenAt15"]),
      (real.exit_reason, round(real.profit, 2)))
check("liveRule: the same fall is a full -1R", outcome(real.context["whatIf"]["liveRule"]), ("stop", -550.0))

sk = run([alpha(RECOVERS)], ["A-SK"])
real = sk[0]
check("cost at 1.5R: out at cost on the 09:40 dip", (real.exit_reason, round(real.profit, 2),
                                                     real.exit_at.strftime("%H:%M")), ("breakeven", 0.0, "09:40"))
live = real.context["whatIf"]["liveRule"]
check("the live shadow rides out the dip, ratchets at 2R and holds to the end of the data",
      (live["reason"], live["step"], round(live["profit"], 2)), ("eod-flatten", 2, round(5 * 250, 2)))

# The live desk's rule (no break-even): its liveRule shadow is the real trade.
plain = run([alpha(COLLAPSES)], ["A"])
real = plain[0]
check("A (live rule): -1R", (real.exit_reason, round(real.profit, 2)), ("stop", -550.0))
check("liveRule reproduces it", outcome(real.context["whatIf"]["liveRule"]), ("stop", -550.0))
check("and the break-even shadow would have scratched it", outcome(real.context["whatIf"]["breakevenAt15"]),
      ("breakeven", 0.0))

# -ATR600: the ATR stop and the Rs 600 ladder carry into both shadows. The ATR at
# 09:28 is test_atr_stop.py's: (6 x 13/14 x 13 + 24) / 14 -> stop 30 - ATR/3.
fix = run([alpha(COLLAPSES)], ["A-ATR600"])
real = fix[0]
atr = real.context["atrStop"]
check("-ATR600 shadows exist", sorted(real.context["whatIf"]), ["breakevenAt15", "liveRule"])
# 1.5 x Rs 600 on 250 = 3.60 a unit: cost at 33.60. The 33.50 touch is short of it,
# so neither the real trade nor either shadow moves to cost - all three are stopped.
check("its break-even is 1.5 x Rs 600: 33.50 does not reach it, all stopped at the ATR stop",
      [outcome(real.context["whatIf"][k]) for k in ("liveRule", "breakevenAt15")] + [(real.exit_reason, round(real.profit, 2))],
      [("stop", round(-atr["points"] * 250, 2))] * 3)

# Shadows hold no slot: three stocks, three trades, the book's cap of three.
many = run([alpha(COLLAPSES), Stock(**{**alpha(COLLAPSES).__dict__, "symbol": "BETA"}),
            Stock(**{**alpha(COLLAPSES).__dict__, "symbol": "GAMMA"})], ["A-SK"])
check("three stocks, three trades - the shadows took no slot", len(many), 3)
check("each with its own pair", [sorted(p.context["whatIf"]) for p in many], [["breakevenAt15", "liveRule"]] * 3)


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

doc = results.trade_document(run([alpha(RECOVERS)], ["A-SK"])[0], "run-wi")
check("the stored trade carries both, with times in epoch ms",
      (sorted(doc["whatIf"]), type(doc["whatIf"]["liveRule"]["exitAt"]).__name__,
       doc["whatIf"]["liveRule"]["profit"], doc["whatIf"]["breakevenAt15"]["profit"]),
      (["breakevenAt15", "liveRule"], "int", 1250.0, 0.0))

print(f"{passed} passed, {len(failed)} failed")
for f in failed:
    print("  FAIL  " + f)
sys.exit(1 if failed else 0)
