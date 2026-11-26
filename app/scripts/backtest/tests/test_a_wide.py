"""Setup A with a wider ATR stop: -ATR2 (ATR/2) and -ATR1 (ATR/1). Backtest only.

For A only: SL = the stock's 5-min ATR / 2 (or / 1) in premium points, no move to
cost, no new entry from 12:00. B and C are -ATR600's exactly.

    py -3.12 tests/test_a_wide.py
"""
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fake_archive import FakeArchive, Stock, at
from settings import GATE_FLOORS
from backtest import strategies as S
from backtest.runner import replay_session
from backtest.signals import _a_open
from backtest.strategies import risk_of, selection

DAY = dt.date(2026, 10, 15)
passed, failed = 0, []


def check(name, got, want):
    global passed
    if got == want:
        passed += 1
    else:
        failed.append(f"{name}\n      got  {got}\n      want {want}")


def close(name, got, want, tol=1e-6):
    check(name, want if got is not None and abs(got - want) <= tol else got, want)


L2, S2 = S.BREAKOUT_RETRACE_21EMA_ATR2, S.BREAKDOWN_RETRACE_21EMA_ATR2
L1, S1 = S.BREAKOUT_RETRACE_21EMA_ATR1, S.BREAKDOWN_RETRACE_21EMA_ATR1
ATR600_L, ATR600_S = S.BREAKOUT_RETRACE_21EMA_ATR600, S.BREAKDOWN_RETRACE_21EMA_ATR600

# ---------------- the definitions ----------------
for long_, short_, div, sfx in ((L2, S2, 2, "ATR2"), (L1, S1, 1, "ATR1")):
    a = risk_of(long_, f"A-{sfx}")
    check(f"-{sfx}: A's SL is ATR / {div}", a["atrStopDivisor"], div)
    check(f"-{sfx}: A has no move to cost", "breakevenAtR" in a, False)
    check(f"-{sfx}: A keeps the Rs 600 ladder",
          {k: v for k, v in a.items() if k not in ("atrStopDivisor",)},
          {k: v for k, v in ATR600_L["risk"].items() if k not in ("atrStopDivisor", "breakevenAtR")})
    check(f"-{sfx}: B is -ATR600's exactly", risk_of(long_, f"B-{sfx}"), ATR600_L["risk"])
    check(f"-{sfx}: C is -ATR600's exactly", risk_of(short_, f"C-{sfx}"), ATR600_S["risk"])
    check(f"-{sfx}: A's own cutoff 12:00, the strategy's still 13:00",
          (long_["params"]["legCutoffIst"], long_["params"]["entryCutoffIst"]), ({"A": "12:00"}, "13:00"))
    check(f"-{sfx}: entries otherwise the -ATR600 rule's",
          {k: v for k, v in long_["params"].items() if k != "legCutoffIst"}, ATR600_L["params"])
    check(f"-{sfx}: setups and book", (long_["setups"], short_["setups"], long_["book"]),
          ([f"A-{sfx}", f"B-{sfx}"], [f"C-{sfx}"], f"atr600-a-{sfx.lower()}"))
check("every rule without legRisk is unchanged", risk_of(ATR600_L, "A-ATR600") is ATR600_L["risk"], True)

check("A open at 11:59", _a_open(L2["params"], at(DAY, 11, 59)), True)
check("A shut from 12:00", _a_open(L2["params"], at(DAY, 12, 0)), False)
check("no A cutoff on -ATR600", _a_open(ATR600_L["params"], at(DAY, 12, 30)), True)


# ---------------- whole sessions ----------------
# test_pivot_skew.py's ALPHA: A at 09:28 on a premium of 30; its 5-min ATR at
# 09:28 is (6 x 13/14 x 13 + 24) / 14 (test_atr_stop.py).
ATR_928 = (6 * 13 / 14 * 13 + 24) / 14


def chain_dict():
    return {float(k): (1000.0, 100.0) if k == 1020 else (100.0, 1000.0) if k == 980 else (500.0, 500.0)
            for k in range(900, 1121, 10)}


def prices(spec):
    out = {}
    for h, first, last, price in spec:
        for m in range(first, last + 1):
            out[at(DAY, h, m)] = float(price)
    return out


def premium(spec):
    out = {}
    for h, first, last, *bar in spec:
        for m in range(first, last + 1):
            out[at(DAY, h, m)] = tuple(float(x) for x in bar)
    return out


def stock(spot, prem):
    return Stock(symbol="ALPHA", ohlc=(1030.0, 970.0, 1000.0), chain=chain_dict(), prices=spot, seed=1000.0,
                 atm=1020.0, premium=prem, history=((1010.0, 990.0, 1000.0),) * 14, seed_range=6.0,
                 skew_per_strike=0.0)


def run(spot, prem, setups):
    strategy_ids, chosen = selection(setups)
    trades, _ = replay_session(FakeArchive(DAY, [stock(spot, prem)]), DAY,
                               [S.STRATEGIES[s] for s in strategy_ids], GATE_FLOORS, setups=chosen)
    return trades


EARLY = prices([(9, 15, 19, 1000), (9, 20, 24, 1024), (9, 25, 25, 1005.5), (9, 26, 26, 1008),
                (9, 27, 27, 1004.5), (9, 28, 59, 1006.5)])
# Up to 34 at 09:36 (past +900 = 33.60 on the 250 lot), back to 29.50 at 09:40, then 31.
DIP = premium([(9, 15, 35, 30, 30, 30, 30), (9, 36, 36, 30, 34, 30, 34), (9, 37, 39, 34, 34, 34, 34),
               (9, 40, 40, 34, 34, 29.5, 29.5), (9, 41, 59, 31, 31, 31, 31)])

base = run(EARLY, DIP, ["A-ATR600"])
two = run(EARLY, DIP, ["A-ATR2"])
one = run(EARLY, DIP, ["A-ATR1"])
check("all three take A at 09:28 at 30", [(p.setup, p.entry_at.strftime("%H:%M"), p.entry) for p in base + two + one],
      [("A-ATR600", "09:28", 30.0), ("A-ATR2", "09:28", 30.0), ("A-ATR1", "09:28", 30.0)])
close("-ATR600: SL 30 - ATR/3", base[0].context["atrStop"]["stop"], 30 - ATR_928 / 3)
close("-ATR2: SL 30 - ATR/2", two[0].context["atrStop"]["stop"], 30 - ATR_928 / 2)
close("-ATR1: SL 30 - ATR", one[0].context["atrStop"]["stop"], 30 - ATR_928)
close("-ATR2: R = ATR/2 x 250", two[0].risk_per_unit * two[0].qty, ATR_928 / 2 * 250)
check("-ATR600 moved to cost at +900 and was taken out at 29.50 on the dip",
      (base[0].exit_reason, base[0].exit_at.strftime("%H:%M")), ("breakeven", "09:40"))
check("-ATR2 does not move to cost: it rides the dip", two[0].exit_reason, "eod-flatten")
check("and ends on the 31 close", round(two[0].profit, 2), 250.0)
check("-ATR1 the same", (one[0].exit_reason, round(one[0].profit, 2)), ("eod-flatten", 250.0))
check("its replayed live exit is the real trade (no cost move to remove)",
      (two[0].context["whatIf"]["liveRule"]["reason"], round(two[0].context["whatIf"]["liveRule"]["profit"], 2)),
      ("eod-flatten", 250.0))

# The same A pattern after 12:00: -ATR600 (cutoff 13:00) takes it, -ATR2 / -ATR1 do not.
NOON = prices([(9, 15, 59, 1000), (10, 0, 59, 1000), (11, 0, 59, 1000), (12, 0, 19, 1000), (12, 20, 24, 1024),
               (12, 25, 25, 1005.5), (12, 26, 26, 1008), (12, 27, 27, 1004.5), (12, 28, 59, 1006.5)])
FLAT = premium([(h, 0 if h > 9 else 15, 59, 30, 30, 30, 30) for h in (9, 10, 11, 12)])
check("-ATR600 takes the 12:28 A", [p.entry_at.strftime("%H:%M") for p in run(NOON, FLAT, ["A-ATR600"])], ["12:28"])
check("-ATR2: no A from 12:00", run(NOON, FLAT, ["A-ATR2"]), [])
check("-ATR1: no A from 12:00", run(NOON, FLAT, ["A-ATR1"]), [])

# B is -ATR600's: same entry, same ATR/3 stop.
b600 = run(EARLY, DIP, ["B-ATR600"])
b2 = run(EARLY, DIP, ["B-ATR2"])
check("B fires the same under -ATR2", [(p.entry_at, p.entry) for p in b2], [(p.entry_at, p.entry) for p in b600])
check("with the -ATR600 stop and exit",
      [(round(p.stop, 6), p.exit_reason, round(p.profit, 2)) for p in b2],
      [(round(p.stop, 6), p.exit_reason, round(p.profit, 2)) for p in b600])


# ---------------- runs are one book or another ----------------
def refused(setups):
    try:
        selection(setups)
    except SystemExit:
        return True
    return False


check("-ATR2 and -ATR600 cannot share a run", refused(["A-ATR2", "B-ATR600"]), True)
check("nor -ATR2 and -ATR1", refused(["A-ATR2", "A-ATR1"]), True)
check("the three -ATR2 legs are one run", refused(["A-ATR2", "B-ATR2", "C-ATR2"]), False)
check("the three -ATR1 legs are one run", refused(["A-ATR1", "B-ATR1", "C-ATR1"]), False)

# ---------------- the dashboard lists the same legs ----------------
SETUPS_TS = (Path(__file__).resolve().parents[3] / "src" / "lib" / "backtest" / "setups.ts")
text = SETUPS_TS.read_text(encoding="utf-8")
for strategy in (L2, S2, L1, S1):
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
