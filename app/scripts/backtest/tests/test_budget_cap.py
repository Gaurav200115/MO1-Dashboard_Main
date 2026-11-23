"""Fewer trades, less drawdown - A-CAP / B-CAP / C-CAP and B-35K. Backtest only.

What this file pins down:

  - the definitions: the live long v11 / short v7 rule unchanged, plus
      -CAP  at most 3 entries a day across A, B and C, none from 10:30
      -35K  B alone, the normal day
    both under a Rs 35,000 budget, max 3 open
  - the budget: premium x qty of the open trades plus the new one, Rs 35,000
    exactly still fits; an over-budget signal is skipped, never made room for,
    and does not count toward the day's 3
  - whole sessions through `replay_session`, against the live legs as control
  - that the variants never share a run, and the dashboard lists the same legs

    py -3.12 tests/test_budget_cap.py
"""
import datetime as dt
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fake_archive import FakeArchive, Stock, at, flat_premium
from settings import GATE_FLOORS
from backtest import strategies as S
from backtest.runner import over_budget, premium_in, replay_session
from backtest.strategies import selection

DAY = dt.date(2026, 10, 15)
CAP_LONG, CAP_SHORT, B35 = (S.BREAKOUT_RETRACE_21EMA_CAP, S.BREAKDOWN_RETRACE_21EMA_CAP,
                            S.BREAKOUT_RETRACE_21EMA_B35K)
CAP_NOTE = "3 a day reached (all setups)"
BUDGET_NOTE = "over the Rs 35000 budget"

passed, failed = 0, []


def check(name, got, want):
    global passed
    if got == want:
        passed += 1
    else:
        failed.append(f"{name}\n      got  {got}\n      want {want}")


# ---------------- the definitions ----------------

LIVE = S.BREAKOUT_RETRACE_21EMA
live_params = LIVE["params"]
ADDED = ("entryCutoffIst", "maxTradesPerDayBook")
check("-CAP: the live params, with only the 10:30 cut-off and the 3 a day added",
      {k: v for k, v in CAP_LONG["params"].items() if k not in ADDED},
      {k: v for k, v in live_params.items() if k not in ADDED})
check("-CAP: cut-off 10:30, 3 a day across the run",
      (CAP_LONG["params"]["entryCutoffIst"], CAP_LONG["params"]["maxTradesPerDayBook"]), ("10:30", 3))
check("-CAP short: the same params", CAP_SHORT["params"], CAP_LONG["params"])
check("-35K: the live params exactly (normal day)", B35["params"], live_params)
check("-35K: B only", (B35["setups"], B35["legs"]), (["B-35K"], {"B-35K": "B"}))
for strategy in (CAP_LONG, CAP_SHORT, B35):
    check(f"{strategy['id']}: the live 550 stop and ladder, plus the 35k budget",
          strategy["risk"], dict(LIVE["risk"], capitalRupees=35000))
check("max 3 open for both", (CAP_LONG["params"]["maxOpenTrades"], B35["params"]["maxOpenTrades"]), (3, 3))
check("the live rule itself has no budget and no run-wide cap",
      (LIVE["risk"].get("capitalRupees"), live_params.get("maxTradesPerDayBook")), (None, None))


# ---------------- the budget ----------------

class Pos:
    def __init__(self, entry, qty):
        self.entry, self.qty = entry, qty


check("premium in a trade is price x qty", premium_in(Pos(30.0, 250)), 7500.0)
check("20,000 open + 15,000 new = 35,000 exactly: fits",
      over_budget([Pos(40.0, 250), Pos(40.0, 250)], Pos(60.0, 250), 35000), False)
check("20,000 open + 15,012.5 new: over",
      over_budget([Pos(40.0, 250), Pos(40.0, 250)], Pos(60.05, 250), 35000), True)
check("one trade alone over 35k: over", over_budget([], Pos(476.4, 100), 35000), True)


# ---------------- whole sessions, through replay_session ----------------
# The fixtures of test_adr.py / test_daily_loss.py. Previous session 1030 / 970 /
# 1000: R1 1022.92 at a 10x call skew. A 2% ADR at a 1000 close. ALPHA, BRAVO and
# CHARLIE break R1 at 09:20, pull back at 09:27 and enter at 09:28. DELTA does the
# same thirty minutes later and signals at 09:58. 550 on a 250 lot is 2.20 a unit.

OHLC = (1030.0, 970.0, 1000.0)
CHAIN = {
    float(k): (1000.0, 100.0) if k == 1020 else (100.0, 1000.0) if k == 980 else (500.0, 500.0)
    for k in range(900, 1121, 10)
}
TWO_PCT = ((1010.0, 990.0, 1000.0),) * 14
PATTERN = [(0, 4, 1024), (5, 5, 1005.5), (6, 6, 1008), (7, 7, 1004.5)]


def spot(start_hour, start_minute, end_hour=9, end_minute=59):
    """Flat 1000 until the break, then the pattern, then 1006.5 to the end."""
    out = {}
    t = dt.datetime.combine(DAY, dt.time(9, 15))
    brk = dt.datetime.combine(DAY, dt.time(start_hour, start_minute))
    end = dt.datetime.combine(DAY, dt.time(end_hour, end_minute))
    while t <= end:
        price = 1000.0 if t < brk else 1006.5
        for first, last, p in PATTERN:
            if brk + dt.timedelta(minutes=first) <= t <= brk + dt.timedelta(minutes=last):
                price = float(p)
        out[at(DAY, t.hour, t.minute)] = price
        t += dt.timedelta(minutes=1)
    return out


EARLY, LATE = spot(9, 20), spot(9, 50)


def gap_out(held, opened, at_minute):
    """Holds at `held`, then opens below the stop at `at_minute` and stays there."""
    out = {}
    for m in range(15, 60):
        t = at(DAY, 9, m)
        value = held if m < at_minute else opened
        out[t] = (value, value, value, value)
    return out


def stock(symbol, prices, premium):
    return Stock(symbol=symbol, ohlc=OHLC, chain=CHAIN, prices=prices, seed=1000.0, atm=1020.0,
                 premium=premium, history=TWO_PCT)


def run(stocks, setups):
    strategy_ids, chosen = selection(setups)
    return replay_session(FakeArchive(DAY, stocks), DAY,
                          [S.STRATEGIES[s] for s in strategy_ids], GATE_FLOORS, setups=chosen)


def entries(trades):
    return sorted((p.symbol, p.entry_at.strftime("%H:%M")) for p in trades)


# A-only runs first: only A's 09:28 / 09:58 entries, nothing else firing.

# --- the 3 a day: two stop out by 09:30, CHARLIE stays open, DELTA signals at 09:58 ---
three = [stock("ALPHA", EARLY, gap_out(30.0, 27.0, 30)),
         stock("BRAVO", EARLY, gap_out(30.0, 27.0, 30)),
         stock("CHARLIE", EARLY, flat_premium(DAY, 30.0)),
         stock("DELTA", LATE, flat_premium(DAY, 30.0))]
trades, notes = run(three, ["A-CAP"])
check("-CAP: the first three are taken, DELTA (the 4th) is not",
      entries(trades), [("ALPHA", "09:28"), ("BRAVO", "09:28"), ("CHARLIE", "09:28")])
check("-CAP: refused by the 3 a day, though a slot was free",
      (notes["rejected"].get(CAP_NOTE), notes["rejected"].get("book full")), (1, None))
control, _ = run(three, ["A"])
check("control: the live A takes DELTA at 09:58", ("DELTA", "09:58") in entries(control), True)

# --- the 10:30 cut-off: ECHO breaks at 10:25 and signals after 10:30 ---
late_day = spot(10, 25, 10, 59)
late_premium = {**flat_premium(DAY, 30.0), **flat_premium(DAY, 30.0, hour=10)}
echo = [stock("ECHO", late_day, late_premium)]
trades, _ = run(echo, ["A-CAP"])
control, _ = run(echo, ["A"])
check("control: the live A takes ECHO after 10:30",
      [p.entry_at.time() >= dt.time(10, 30) for p in control], [True])
check("-CAP: nothing from 10:30", trades, [])

# --- the budget: 60.00 premiums are 15,000 a trade ---
pricey = [stock("ALPHA", EARLY, gap_out(60.0, 56.0, 30)),
          stock("BRAVO", EARLY, gap_out(60.0, 56.0, 30)),
          stock("CHARLIE", EARLY, flat_premium(DAY, 60.0)),
          stock("DELTA", LATE, flat_premium(DAY, 60.0))]
trades, notes = run(pricey, ["A-CAP"])
check("-CAP: 30,000 in two trades leaves no room for CHARLIE's 15,000; DELTA fits once they close",
      entries(trades), [("ALPHA", "09:28"), ("BRAVO", "09:28"), ("DELTA", "09:58")])
check("-CAP: CHARLIE counted as over budget", notes["rejected"].get(BUDGET_NOTE), 1)
check("-CAP: and not toward the 3 a day - DELTA was the 3rd", notes["rejected"].get(CAP_NOTE), None)
check("-CAP: the open trades were not closed to make room - both ran to their own stop",
      sorted((p.symbol, p.exit_reason) for p in trades if p.symbol in ("ALPHA", "BRAVO")),
      [("ALPHA", "stop"), ("BRAVO", "stop")])
control, control_notes = run(pricey, ["A"])
check("control: the live A takes CHARLIE too", ("CHARLIE", "09:28") in entries(control), True)
check("control: no budget", control_notes["rejected"].get(BUDGET_NOTE), None)

# --- all three legs: the 3 a day counts A and B together ---
# B fires first here (09:20, the level cross) on ALPHA, BRAVO and CHARLIE. Two
# fit the budget; CHARLIE's B is skipped. Both stop out by 09:25, so CHARLIE's A
# at 09:28 fits and is the day's 3rd - DELTA's B (09:50) and A (09:58) are not.
trades, notes = run(pricey, ["A-CAP", "B-CAP", "C-CAP"])
check("-CAP, A+B+C: B, B, then A make the day's 3",
      sorted((p.symbol, p.setup, p.entry_at.strftime("%H:%M")) for p in trades),
      [("ALPHA", "B-CAP", "09:20"), ("BRAVO", "B-CAP", "09:20"), ("CHARLIE", "A-CAP", "09:28")])
check("-CAP, A+B+C: one over budget, DELTA's two refused by the 3 a day",
      (notes["rejected"].get(BUDGET_NOTE), notes["rejected"].get(CAP_NOTE)), (1, 2))

# --- B-35K: B alone, the same budget, no 3 a day ---
trades, notes = run(pricey, ["B-35K"])
check("B-35K: only B trades, and the budget holds CHARLIE back at 09:20",
      (sorted({p.setup for p in trades}), notes["rejected"].get(BUDGET_NOTE) is not None),
      (["B-35K"], True))
check("B-35K: no 3-a-day cap", notes["rejected"].get(CAP_NOTE), None)

# --- the short leg runs under the -CAP short rule ---
SHORT = {}
for m in range(15, 60):
    SHORT[at(DAY, 9, m)] = float(978 if m < 20 else 972 if m == 20 else 970 if m < 25 else 974 if m == 25 else 971)
trades, _ = run([Stock(symbol="SHORTY", ohlc=OHLC, chain=CHAIN, prices=SHORT, seed=975.0,
                       atm=970.0, premium=flat_premium(DAY, 25.0), history=TWO_PCT)], ["C-CAP"])
check("C-CAP buys a put under its own strategy",
      [(p.setup, p.option_type, p.strategy_id) for p in trades],
      [("C-CAP", "PE", "breakdown-retrace-21ema-cap")])


# ---------------- runs are one book or another ----------------

def refused(setups):
    try:
        selection(setups)
    except SystemExit:
        return True
    return False


check("A and A-CAP cannot share a run", refused(["A", "A-CAP"]), True)
check("nor B-CAP and B-35K", refused(["B-CAP", "B-35K"]), True)
check("nor B and B-35K", refused(["B", "B-35K"]), True)
check("the three -CAP legs are one run", refused(["A-CAP", "B-CAP", "C-CAP"]), False)
check("B-35K runs alone", refused(["B-35K"]), False)


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

if trades:
    doc = results.trade_document(trades[0], "run-cap")
    check("a stored C-CAP trade carries the tag",
          (doc["setup"], doc["setupLabel"]), ("C-CAP", "Breakdown & retrace [3 a day till 10:30, Rs 35k]"))


# ---------------- the dashboard lists the same legs ----------------
SETUPS_TS = (Path(__file__).resolve().parents[3] / "src" / "lib" / "backtest" / "setups.ts")
text = SETUPS_TS.read_text(encoding="utf-8")
for strategy in (CAP_LONG, CAP_SHORT, B35):
    for setup in strategy["setups"]:
        block = text.split(f'setup: "{setup}"', 1)
        body = block[1].split("}", 1)[0] if len(block) == 2 else ""
        check(f"setups.ts lists {setup} under {strategy['id']} v{strategy['version']}",
              (f'strategy: "{strategy["id"]}"' in body, f"version: {strategy['version']}," in body,
               f'book: "{strategy["book"]}"' in body),
              (True, True, True))


print(f"{passed} passed, {len(failed)} failed")
for f in failed:
    print("  FAIL  " + f)
sys.exit(1 if failed else 0)
