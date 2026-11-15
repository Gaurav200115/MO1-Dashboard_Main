"""ADR with a daily loss limit - A-DL, B-DL, C-DL. Backtest only.

The live ADR rule (long v9 / short v5) exactly - 550 stop, 1:2 -> +1R ladder -
plus one addition: once the day's net P&L on closed trades is down 1,700, no
new trade that day. What this file pins down:

  - the definition: the live entry and stop unchanged, the limit at 1,700
  - the day's net: wins offset losses, open trades do not count
  - whole sessions through `replay_session`, each against the ADR legs on the
    same stocks as the control:
      two losses gapping through the stop (-1,800) block a later signal, while a
      trade already open runs on to its own exit
      three clean 550 losses (-1,650) do not reach 1,700, so the fourth trade is taken
      the short leg runs under its own strategy
  - that the -DL legs never share a run with A/B/C or another variant
  - that a stored trade carries its tag, and the dashboard lists the same legs

    py -3.12 tests/test_daily_loss.py
"""
import datetime as dt
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fake_archive import FakeArchive, Stock, at, flat_premium, premium_falling_through
from settings import GATE_FLOORS
from backtest import strategies as S
from backtest.runner import day_net, replay_session
from backtest.strategies import selection

DAY = dt.date(2026, 10, 15)
DL_LONG, DL_SHORT = S.BREAKOUT_RETRACE_21EMA_DL, S.BREAKDOWN_RETRACE_21EMA_DL
LIMIT_NOTE = "daily loss limit Rs 1700"
DAY_NOTE = "days the Rs 1700 daily loss limit was reached"

passed, failed = 0, []


def check(name, got, want):
    global passed
    if got == want:
        passed += 1
    else:
        failed.append(f"{name}\n      got  {got}\n      want {want}")


# ---------------- the definition ----------------

check("the entry is the live ADR rule", DL_LONG["params"], S.ADR_PARAMS)
check("the short's too", DL_SHORT["params"], S.ADR_PARAMS)
live_risk = S.BREAKOUT_RETRACE_21EMA["risk"]
check("the stop and ladder are the live ones: 550, 1:2 -> +1R",
      {k: v for k, v in DL_LONG["risk"].items() if k != "dailyLossLimitRupees"}, live_risk)
check("the limit is 1,700", (DL_LONG["risk"]["dailyLossLimitRupees"],
                             DL_SHORT["risk"]["dailyLossLimitRupees"]), (1700, 1700))
check("its own book", (DL_LONG["book"], DL_SHORT["book"]), ("adr-daily-loss", "adr-daily-loss"))


# ---------------- the day's net ----------------

class Closed:
    def __init__(self, profit):
        self.profit = profit


check("wins offset losses: +1,100 then three -550 is -550",
      day_net([Closed(1100), Closed(-550), Closed(-550), Closed(-550)]), -550)
check("a trade with no exit yet counts nothing", day_net([Closed(-900), Closed(None)]), -900)
check("an empty day is 0", day_net([]), 0)


# ---------------- whole sessions, through replay_session ----------------
# The fixtures of test_adr.py. Previous session 1030 / 970 / 1000: R1 1022.92.
# A 2% ADR at a 1000 close: zone 3.00, turn 1.50. ALPHA, BRAVO and CHARLIE all
# break R1 at 09:20, pull back to 1004.50 at 09:27 and enter at 09:28 at a 30.00
# premium - three positions, the whole cap. 550 on a 250 lot is 2.20 a unit, so
# each stop sits at 27.80. DELTA does the same thirty minutes later and signals
# at 09:58, by which time the first three are decided.

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


EARLY = prices([(15, 19, 1000), (20, 24, 1024), (25, 25, 1005.5), (26, 26, 1008),
                (27, 27, 1004.5), (28, 59, 1006.5)])
LATE = prices([(15, 49, 1000), (50, 54, 1024), (55, 55, 1005.5), (56, 56, 1008),
               (57, 57, 1004.5), (58, 59, 1006.5)])


def gapping(held, opened, at_minute):
    """Holds at `held`, then opens the minute at `opened` - below the stop - and stays there."""
    out = {}
    for m in range(15, 60):
        t = minute(9, m)
        if m < at_minute:
            out[t] = (held, held, held, held)
        elif m == at_minute:
            out[t] = (opened, opened, opened - 0.4, opened - 0.2)
        else:
            out[t] = (opened - 0.2,) * 4
    return out


def stock(symbol, spot, premium):
    return Stock(symbol=symbol, ohlc=OHLC, chain=CHAIN, prices=spot, seed=1000.0, atm=1020.0,
                 premium=premium, history=TWO_PCT)


def run(stocks, setups):
    strategy_ids, chosen = selection(setups)
    return replay_session(FakeArchive(DAY, stocks), DAY,
                          [S.STRATEGIES[s] for s in strategy_ids], GATE_FLOORS, setups=chosen)


def summary(trades):
    return sorted((p.symbol, p.entry_at.strftime("%H:%M"), p.exit_reason, round(p.profit, 2))
                  for p in trades)


# --- reached: two losses gap through the 27.80 stop at 26.40, -900 each ---
reached = [stock("ALPHA", EARLY, gapping(30.0, 26.4, 30)),
           stock("BRAVO", EARLY, gapping(30.0, 26.4, 30)),
           stock("CHARLIE", EARLY, flat_premium(DAY, 30.0)),
           stock("DELTA", LATE, flat_premium(DAY, 30.0))]

trades, notes = run(reached, ["A-DL"])
check("-1,800 by 09:30: DELTA's 09:58 signal is refused, the rest stand",
      summary(trades),
      [("ALPHA", "09:28", "stop", -900.0), ("BRAVO", "09:28", "stop", -900.0),
       ("CHARLIE", "09:28", "eod-flatten", 0.0)])
check("counted as refused by the limit", notes["rejected"].get(LIMIT_NOTE), 1)
check("and the day counted once as having reached it", notes["skipped"].get(DAY_NOTE), 1)
check("refused by the limit, not by the book - CHARLIE left a slot free",
      notes["rejected"].get("book full"), None)
check("CHARLIE, open when the limit tripped, runs on to its own exit",
      [p.exit_reason for p in trades if p.symbol == "CHARLIE"], ["eod-flatten"])
check("every trade under the -DL strategy",
      sorted({(p.setup, p.strategy_id, p.strategy_version) for p in trades}),
      [("A-DL", "breakout-retrace-21ema-adr-dll", 1)])

control, control_notes = run(reached, ["A-ADR"])
check("control: the ADR legs with no limit take DELTA at 09:58",
      [p.entry_at.strftime("%H:%M") for p in control if p.symbol == "DELTA"], ["09:58"])
check("control: and count nothing against a limit",
      (control_notes["rejected"].get(LIMIT_NOTE), control_notes["skipped"].get(DAY_NOTE)),
      (None, None))

# --- not reached: three clean stops at 27.80, -550 each = -1,650 ---
clean = [stock(s, EARLY, premium_falling_through(DAY, 30.0, 27.0, 30))
         for s in ("ALPHA", "BRAVO", "CHARLIE")] + [stock("DELTA", LATE, flat_premium(DAY, 30.0))]
trades, notes = run(clean, ["A-DL"])
check("three clean stops are -1,650, short of 1,700",
      round(day_net([p for p in trades if p.symbol != "DELTA"]), 2), -1650.0)
check("so DELTA's 09:58 signal is the day's fourth trade",
      [p.entry_at.strftime("%H:%M") for p in trades if p.symbol == "DELTA"], ["09:58"])
check("and nothing is refused or counted", (notes["rejected"].get(LIMIT_NOTE),
                                            notes["skipped"].get(DAY_NOTE)), (None, None))

# --- the short leg ---
SHORT = prices([(15, 19, 978), (20, 20, 972), (21, 24, 970), (25, 25, 974), (26, 59, 971)])
trades, _ = run([Stock(symbol="SHORTY", ohlc=OHLC, chain=CHAIN, prices=SHORT, seed=975.0,
                       atm=970.0, premium=flat_premium(DAY, 25.0), history=TWO_PCT)], ["C-DL"])
check("C-DL buys a put under its own strategy, at the ADR rule's 09:26",
      [(p.setup, p.option_type, p.strategy_id, p.entry_at.strftime("%H:%M")) for p in trades],
      [("C-DL", "PE", "breakdown-retrace-21ema-adr-dll", "09:26")])


# ---------------- runs are one book or another ----------------

def refused(setups):
    try:
        selection(setups)
    except SystemExit:
        return True
    return False


check("A and A-DL cannot share a run", refused(["A", "A-DL"]), True)
check("nor A-ADR and C-DL", refused(["A-ADR", "C-DL"]), True)
check("nor A-PB and B-DL", refused(["A-PB", "B-DL"]), True)
check("the three -DL legs are one run", refused(["A-DL", "B-DL", "C-DL"]), False)
check("spanning both -DL strategies", selection(["A-DL", "B-DL", "C-DL"])[0],
      ["breakdown-retrace-21ema-adr-dll", "breakout-retrace-21ema-adr-dll"])


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
    doc = results.trade_document(trades[0], "run-dl")
    check("a stored C-DL trade carries the tag",
          (doc["setup"], doc["setupLabel"]), ("C-DL", "Breakdown & retrace [ADR, SL 550, day stop 1700]"))
    check("and the desk's 550 R", round(doc["riskPerUnit"] * doc["qty"], 6), 550.0)


# ---------------- the dashboard lists the same legs ----------------
SETUPS_TS = (Path(__file__).resolve().parents[3] / "src" / "lib" / "backtest" / "setups.ts")
text = SETUPS_TS.read_text(encoding="utf-8")
for strategy in (DL_LONG, DL_SHORT):
    for setup in strategy["setups"]:
        block = text.split(f'setup: "{setup}"', 1)
        body = block[1].split("}", 1)[0] if len(block) == 2 else ""
        check(f"setups.ts lists {setup} under {strategy['id']} v{strategy['version']}",
              (f'strategy: "{strategy["id"]}"' in body, f"version: {strategy['version']}," in body,
               'book: "adr-daily-loss"' in body),
              (True, True, True))


print(f"{passed} passed, {len(failed)} failed")
for f in failed:
    print("  FAIL  " + f)
sys.exit(1 if failed else 0)
