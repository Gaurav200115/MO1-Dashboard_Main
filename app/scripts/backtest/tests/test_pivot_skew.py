"""ADR with a skew threshold per pivot - A-SK, B-SK, C-SK. Backtest only.

The live rule picks the major level as the closest-gap confirmed level whose
skew clears 4x (resistance) or 5x (support). This variant gives each pivot its
own bar: R1, R3, S1, S3 need 5x or more; R2, S2, P qualify at any skew. Closest
gap still wins among those that qualify. What this file pins down:

  - the definition: the live ADR rule otherwise, the per-side bars dropped
  - the pick: an R1 under 5x loses to an R2 at 2x; exactly 5.00x passes; S2 and P
    qualify at any skew; a lone R3 under 5x leaves no major at all
  - a real overnight plan: only the majors move, setup B's levels do not
  - whole sessions against the ADR legs: an R1 at 4.5x is traded live and not
    here; at 10x both take the same trade; all three legs run together
  - that the -SK legs never share a run with A/B/C or another variant
  - that a stored trade carries its tag, and the dashboard lists the same legs

    py -3.12 tests/test_pivot_skew.py
"""
import datetime as dt
import math
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fake_archive import FakeArchive, Stock, at, flat_premium
from settings import GATE_FLOORS
from backtest import strategies as S
from backtest.levels import ConfirmedLevel, pick_major, pick_major_per_pivot, plan_for_stock
from backtest.runner import replay_session
from backtest.strategies import selection

DAY = dt.date(2026, 10, 15)
SK_LONG, SK_SHORT = S.BREAKOUT_RETRACE_21EMA_SK, S.BREAKDOWN_RETRACE_21EMA_SK
TABLE = SK_LONG["params"]["pivotMinSkew"]

passed, failed = 0, []


def check(name, got, want):
    global passed
    if got == want:
        passed += 1
    else:
        failed.append(f"{name}\n      got  {got}\n      want {want}")


# ---------------- the definition ----------------

check("5x for R1, R3, S1, S3; any skew for R2, S2, P", TABLE,
      {"R1": 5, "R3": 5, "S1": 5, "S3": 5, "R2": 0, "S2": 0, "P": 0})
check("the short reads the same table", SK_SHORT["params"]["pivotMinSkew"], TABLE)
check("the per-side 4x / 5x bars are not carried",
      ("resistanceSkew" in SK_LONG["params"], "supportSkew" in SK_LONG["params"]), (False, False))
check("everything else is the live ADR rule",
      {k: v for k, v in SK_LONG["params"].items() if k != "pivotMinSkew"},
      {k: v for k, v in S.ADR_PARAMS.items() if k not in ("resistanceSkew", "supportSkew")})
check("the live stop and ladder", SK_LONG["risk"], S.BREAKOUT_RETRACE_21EMA["risk"])
check("its own book", (SK_LONG["book"], SK_SHORT["book"]), ("adr-pivot-skew", "adr-pivot-skew"))


# ---------------- the pick ----------------

def res(pivot, skew, gap):
    """A resistance with the given call/put skew and strike gap."""
    put = 100.0
    return ConfirmedLevel(pivot, 1000.0, "resistance", 1000.0, skew * put, put, gap, 1.0)


def sup(pivot, skew, gap):
    call = 100.0
    return ConfirmedLevel(pivot, 1000.0, "support", 1000.0, call, skew * call, gap, 1.0)


def picked(level):
    return level.pivot if level is not None else None


levels = [res("R1", 4.5, 0.10), res("R2", 2.0, 0.30)]
check("live: R1 at 4.5x clears 4x and wins on gap", picked(pick_major(levels, "resistance", 4)), "R1")
check("per pivot: R1 at 4.5x is out, R2 at 2x takes it",
      picked(pick_major_per_pivot(levels, "resistance", TABLE)), "R2")

levels = [res("R1", 6.0, 0.20), res("R2", 2.0, 0.10)]
check("per pivot: both qualify, so the closer R2 wins",
      picked(pick_major_per_pivot(levels, "resistance", TABLE)), "R2")
check("live: R2 at 2x could not compete", picked(pick_major(levels, "resistance", 4)), "R1")

check("a lone R3 at 4.5x leaves no major resistance",
      picked(pick_major_per_pivot([res("R3", 4.5, 0.1)], "resistance", TABLE)), None)
check("exactly 5.00x passes, as 'above 4x' does live",
      picked(pick_major_per_pivot([res("R1", 5.0, 0.1)], "resistance", TABLE)), "R1")
check("4.99x does not", picked(pick_major_per_pivot([res("R1", 4.99, 0.1)], "resistance", TABLE)), None)

one_sided = ConfirmedLevel("R3", 1000.0, "resistance", 1000.0, 500.0, 0.0, 0.2, 1.0)
check("a one-sided strike is infinite skew and qualifies",
      picked(pick_major_per_pivot([one_sided], "resistance", TABLE)), "R3")

levels = [sup("S2", 3.0, 0.10), sup("S1", 6.0, 0.30)]
check("live support: S2 at 3x is under 5x, so S1", picked(pick_major(levels, "support", 5)), "S1")
check("per pivot: S2 qualifies at any skew and is closer",
      picked(pick_major_per_pivot(levels, "support", TABLE)), "S2")
check("P as a support qualifies at 2x",
      picked(pick_major_per_pivot([sup("P", 2.0, 0.1)], "support", TABLE)), "P")
check("S3 at 4.9x does not",
      picked(pick_major_per_pivot([sup("S3", 4.9, 0.1)], "support", TABLE)), None)
check("a pivot missing from the table never qualifies",
      picked(pick_major_per_pivot([res("R1", 50.0, 0.1)], "resistance", {"R2": 0})), None)
check("a support is never picked as a resistance",
      picked(pick_major_per_pivot([sup("S2", 9.0, 0.1)], "resistance", TABLE)), None)


# ---------------- a real overnight plan ----------------
# Previous session 1030 / 970 / 1000: P 1000 (a support - the close is on it),
# R1 1022.92, R2 1037.08, S1 977.08. Strike 1020 confirms R1, 1040 confirms R2,
# 980 confirms S1; everything else is balanced and confirms nothing.

def chain(call_put):
    out = []
    for k in range(960, 1061, 10):
        call, put = call_put.get(k, (500.0, 500.0))
        out.append((float(k), call, put))
    return out


SESSION = (1030.0, 970.0, 1000.0)
two_resistances = chain({1020: (450.0, 100.0), 1040: (250.0, 100.0), 980: (100.0, 1000.0)})
live = plan_for_stock("TEST", SESSION, two_resistances, 250, 10.0, S.BREAKOUT_RETRACE_21EMA["params"])
sk = plan_for_stock("TEST", SESSION, two_resistances, 250, 10.0, SK_LONG["params"])
check("live plan: R1 at 4.5x is the major resistance", picked(live.major_resistance), "R1")
check("per-pivot plan: R1 is out, R2 at 2.5x is the major resistance", picked(sk.major_resistance), "R2")
check("S1 at 10x is the major support in both", (picked(live.major_support), picked(sk.major_support)),
      ("S1", "S1"))
check("setup B's levels are the same in both plans",
      [lv.pivot for lv in sk.marked], [lv.pivot for lv in live.marked])

weak_r1_only = chain({1020: (450.0, 100.0), 980: (100.0, 1000.0)})
sk = plan_for_stock("TEST", SESSION, weak_r1_only, 250, 10.0, SK_LONG["params"])
check("R1 at 4.5x alone: no major resistance, the support still stands",
      (picked(sk.major_resistance), picked(sk.major_support)), (None, "S1"))


# ---------------- whole sessions, through replay_session ----------------
# The fixtures of test_adr.py: ALPHA breaks R1 at 09:20, pulls back to 1004.50 at
# 09:27 and enters at 09:28. Only the 1020 strike's skew changes between runs.

def chain_dict(r1_call):
    return {
        float(k): (r1_call, 100.0) if k == 1020 else (100.0, 1000.0) if k == 980 else (500.0, 500.0)
        for k in range(900, 1121, 10)
    }


OHLC = (1030.0, 970.0, 1000.0)
TWO_PCT = ((1010.0, 990.0, 1000.0),) * 14


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


def alpha(r1_call):
    return Stock(symbol="ALPHA", ohlc=OHLC, chain=chain_dict(r1_call), prices=A_PRICES, seed=1000.0,
                 atm=1020.0, premium=flat_premium(DAY, 30.0), history=TWO_PCT)


def shorty():
    return Stock(symbol="SHORTY", ohlc=OHLC, chain=chain_dict(1000.0), prices=SHORT_PRICES,
                 seed=975.0, atm=970.0, premium=flat_premium(DAY, 25.0), history=TWO_PCT)


def run(stocks, setups):
    strategy_ids, chosen = selection(setups)
    return replay_session(FakeArchive(DAY, stocks), DAY,
                          [S.STRATEGIES[s] for s in strategy_ids], GATE_FLOORS, setups=chosen)


def entries(trades):
    return sorted((p.setup, p.symbol, p.entry_at.strftime("%H:%M")) for p in trades)


adr, _ = run([alpha(450.0)], ["A-ADR"])
sk, _ = run([alpha(450.0)], ["A-SK"])
check("R1 at 4.5x: the live ADR rule trades the 09:28 break", entries(adr), [("A-ADR", "ALPHA", "09:28")])
check("R1 at 4.5x: the per-pivot rule does not", sk, [])

adr, _ = run([alpha(1000.0)], ["A-ADR"])
sk, _ = run([alpha(1000.0)], ["A-SK"])
check("R1 at 10x: both take the same trade",
      [(p.symbol, p.entry_at, p.entry) for p in sk], [(p.symbol, p.entry_at, p.entry) for p in adr])
check("under the -SK strategy", [(p.setup, p.strategy_id, p.strategy_version) for p in sk],
      [("A-SK", "breakout-retrace-21ema-adr-pskew", 1)])

together, _ = run([alpha(1000.0), shorty()], ["A-SK", "B-SK", "C-SK"])
control, _ = run([alpha(1000.0), shorty()], ["A-ADR", "B-ADR", "C-ADR"])
check("all three legs together take what the ADR legs take, when every skew clears 5x",
      [(s.split("-")[0], sym, t) for s, sym, t in entries(together)],
      [(s.split("-")[0], sym, t) for s, sym, t in entries(control)])
check("which is B on ALPHA and C on SHORTY", entries(together),
      [("B-SK", "ALPHA", "09:20"), ("C-SK", "SHORTY", "09:26")])
check("C-SK buys a put under its own strategy",
      [(p.option_type, p.strategy_id) for p in together if p.setup == "C-SK"],
      [("PE", "breakdown-retrace-21ema-adr-pskew")])


# ---------------- runs are one book or another ----------------

def refused(setups):
    try:
        selection(setups)
    except SystemExit:
        return True
    return False


check("A and A-SK cannot share a run", refused(["A", "A-SK"]), True)
check("nor A-DL and C-SK", refused(["A-DL", "C-SK"]), True)
check("the three -SK legs are one run", refused(["A-SK", "B-SK", "C-SK"]), False)
check("spanning both -SK strategies", selection(["A-SK", "B-SK", "C-SK"])[0],
      ["breakdown-retrace-21ema-adr-pskew", "breakout-retrace-21ema-adr-pskew"])


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

c = [p for p in together if p.setup == "C-SK"]
if c:
    doc = results.trade_document(c[0], "run-sk")
    check("a stored C-SK trade carries the tag",
          (doc["setup"], doc["setupLabel"]), ("C-SK", "Breakdown & retrace [ADR, skew 5x R1/R3/S1/S3]"))
    check("and the level it traded, with its skew",
          (doc["trigger"]["level"]["pivot"], math.isclose(doc["trigger"]["level"]["skew"], 10.0)),
          ("S1", True))


# ---------------- the dashboard lists the same legs ----------------
SETUPS_TS = (Path(__file__).resolve().parents[3] / "src" / "lib" / "backtest" / "setups.ts")
text = SETUPS_TS.read_text(encoding="utf-8")
for strategy in (SK_LONG, SK_SHORT):
    for setup in strategy["setups"]:
        block = text.split(f'setup: "{setup}"', 1)
        body = block[1].split("}", 1)[0] if len(block) == 2 else ""
        check(f"setups.ts lists {setup} under {strategy['id']} v{strategy['version']}",
              (f'strategy: "{strategy["id"]}"' in body, f"version: {strategy['version']}," in body,
               'book: "adr-pivot-skew"' in body),
              (True, True, True))


print(f"{passed} passed, {len(failed)} failed")
for f in failed:
    print("  FAIL  " + f)
sys.exit(1 if failed else 0)
