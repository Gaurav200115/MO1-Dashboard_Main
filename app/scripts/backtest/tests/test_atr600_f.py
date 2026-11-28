"""ATR600-F and ATR600-FA: fewer, better entries on the -ATR600 rule. Backtest only.

  -F    A: no move to cost, no A from 12:00.  B: unchanged.  C: skip a stock whose
        5-min ATR is under 0.2% of price.
  -FA   A, B and C: no move to cost and the 0.2% ATR floor.  A: none from 12:00.

    py -3.12 tests/test_atr600_f.py
"""
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fake_archive import FakeArchive, Stock, at
from settings import GATE_FLOORS
from backtest import strategies as S
from backtest.runner import replay_session
from backtest.strategies import risk_of, selection

DAY = dt.date(2026, 10, 15)
passed, failed = 0, []


def check(name, got, want):
    global passed
    if got == want:
        passed += 1
    else:
        failed.append(f"{name}\n      got  {got}\n      want {want}")


FL, FS = S.BREAKOUT_RETRACE_21EMA_F, S.BREAKDOWN_RETRACE_21EMA_F
AL, AS = S.BREAKOUT_RETRACE_21EMA_FA, S.BREAKDOWN_RETRACE_21EMA_FA
BL, BS = S.BREAKOUT_RETRACE_21EMA_ATR600, S.BREAKDOWN_RETRACE_21EMA_ATR600
NO_BE = {k: v for k, v in BL["risk"].items() if k != "breakevenAtR"}

# ---------------- the definitions ----------------
check("-F A: no move to cost, otherwise -ATR600", risk_of(FL, "A-F"), NO_BE)
check("-F B: -ATR600 exactly", risk_of(FL, "B-F"), BL["risk"])
check("-F C: -ATR600 exactly", risk_of(FS, "C-F"), BS["risk"])
check("-F: A till 12:00, no ATR floor on the long side",
      (FL["params"]["legCutoffIst"], "minAtrPct" in FL["params"]), ({"A": "12:00"}, False))
check("-F: the 0.2% floor on C only", FS["params"]["minAtrPct"], {"C": 0.2})
check("-F: C has no A cutoff to read", "legCutoffIst" in FS["params"], False)
check("-FA: no move to cost on every setup",
      (risk_of(AL, "A-FA"), risk_of(AL, "B-FA"), risk_of(AS, "C-FA")), (NO_BE, NO_BE, NO_BE))
check("-FA: the 0.2% floor on all three",
      (AL["params"]["minAtrPct"], AS["params"]["minAtrPct"]), ({"A": 0.2, "B": 0.2}, {"C": 0.2}))
check("-FA: A till 12:00", AL["params"]["legCutoffIst"], {"A": "12:00"})
check("books and setups", (FL["setups"], FS["setups"], AL["setups"], AS["setups"], FL["book"], AL["book"]),
      (["A-F", "B-F"], ["C-F"], ["A-FA", "B-FA"], ["C-FA"], "atr600-f", "atr600-fa"))
for rule in (FL, FS, AL, AS):
    check(f"{rule['id']}: entries otherwise -ATR600's",
          {k: v for k, v in rule["params"].items() if k not in ("legCutoffIst", "minAtrPct")}, BL["params"])


# ---------------- whole sessions ----------------
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


ALPHA_PRICES = prices([(9, 15, 19, 1000), (9, 20, 24, 1024), (9, 25, 25, 1005.5), (9, 26, 26, 1008),
                       (9, 27, 27, 1004.5), (9, 28, 59, 1006.5)])
SHORT_PRICES = prices([(9, 15, 19, 978), (9, 20, 20, 972), (9, 21, 24, 970), (9, 25, 25, 974), (9, 26, 59, 971)])
# Up to 34 at 09:36 (past +900 = 33.60 on the 250 lot), back to 29.50 at 09:40, then 31.
DIP = premium([(9, 15, 35, 30, 30, 30, 30), (9, 36, 36, 30, 34, 30, 34), (9, 37, 39, 34, 34, 34, 34),
               (9, 40, 40, 34, 34, 29.5, 29.5), (9, 41, 59, 31, 31, 31, 31)])
FLAT = premium([(9, 15, 59, 25, 25, 25, 25)])


def alpha(prem, seed_range=6.0, spot=ALPHA_PRICES):
    return Stock(symbol="ALPHA", ohlc=(1030.0, 970.0, 1000.0), chain=chain_dict(), prices=spot, seed=1000.0,
                 atm=1020.0, premium=prem, history=((1010.0, 990.0, 1000.0),) * 14, seed_range=seed_range,
                 skew_per_strike=0.0)


def shorty(seed_range):
    return Stock(symbol="SHORTY", ohlc=(1030.0, 970.0, 1000.0), chain=chain_dict(), prices=SHORT_PRICES, seed=975.0,
                 atm=970.0, premium=FLAT, history=((1010.0, 990.0, 1000.0),) * 14, seed_range=seed_range,
                 skew_per_strike=0.0)


def run(stocks, setups):
    strategy_ids, chosen = selection(setups)
    return replay_session(FakeArchive(DAY, stocks), DAY, [S.STRATEGIES[s] for s in strategy_ids],
                          GATE_FLOORS, setups=chosen)


def taken(trades):
    return [(p.setup, p.entry_at.strftime("%H:%M")) for p in sorted(trades, key=lambda p: p.entry_at)]


# A: no move to cost - rides the 09:40 dip that takes -ATR600 out at cost.
base, _ = run([alpha(DIP)], ["A-ATR600"])
f, _ = run([alpha(DIP)], ["A-F"])
fa, _ = run([alpha(DIP)], ["A-FA"])
check("-ATR600 A: out at cost on the dip", base[0].exit_reason, "breakeven")
check("-F A: no cost move, rides it to the end", (f[0].exit_reason, round(f[0].profit, 2)), ("eod-flatten", 250.0))
check("-FA A: the same", (fa[0].exit_reason, round(fa[0].profit, 2)), ("eod-flatten", 250.0))

# A from 12:00: none.
NOON = prices([(9, 15, 59, 1000), (10, 0, 59, 1000), (11, 0, 59, 1000), (12, 0, 19, 1000), (12, 20, 24, 1024),
               (12, 25, 25, 1005.5), (12, 26, 26, 1008), (12, 27, 27, 1004.5), (12, 28, 59, 1006.5)])
LATE = premium([(h, 0 if h > 9 else 15, 59, 30, 30, 30, 30) for h in (9, 10, 11, 12)])
check("-ATR600 takes A at 12:28", taken(run([alpha(LATE, spot=NOON)], ["A-ATR600"])[0]), [("A-ATR600", "12:28")])
check("-F: no A from 12:00", run([alpha(LATE, spot=NOON)], ["A-F"])[0], [])
check("-FA: no A from 12:00", run([alpha(LATE, spot=NOON)], ["A-FA"])[0], [])

# The ATR floor. SHORTY's C fires at 09:26. Seed bars 1 high-to-low: ATR about 1.63
# on 971 = 0.17%, under the floor. Seed bars 6: about 5.94 = 0.61%, over it.
for sr, label, under in ((1.0, "0.17%", True), (6.0, "0.61%", False)):
    c600, _ = run([shorty(sr)], ["C-ATR600"])
    cf, cf_notes = run([shorty(sr)], ["C-F"])
    check(f"C-ATR600 takes SHORTY at ATR {label}", taken(c600), [("C-ATR600", "09:26")])
    check(f"C-F at ATR {label}: {'skipped' if under else 'taken'}", taken(cf), [] if under else [("C-F", "09:26")])
    if under:
        check("counted as its own rejection", cf_notes["rejected"].get("stock 5-min ATR under 0.2%"), 1)

# B: ALPHA's B fires at 09:20 with one closed bar behind it - ATR = the seed's x 13/14.
# Seed bars 1 high-to-low: about 0.93 on 1024 = 0.09%. -F has no floor on B; -FA does.
bf, _ = run([alpha(DIP, seed_range=1.0)], ["B-F"])
bfa, bfa_notes = run([alpha(DIP, seed_range=1.0)], ["B-FA"])
b600, _ = run([alpha(DIP, seed_range=1.0)], ["B-ATR600"])
check("-F B: no floor, the -ATR600 trade exactly",
      [(p.entry_at, round(p.stop, 6), p.exit_reason, round(p.profit, 2)) for p in bf],
      [(p.entry_at, round(p.stop, 6), p.exit_reason, round(p.profit, 2)) for p in b600])
check("-FA B: under 0.2%, skipped", bfa, [])
check("and counted", bfa_notes["rejected"].get("stock 5-min ATR under 0.2%"), 1)


# ---------------- runs are one book or another ----------------
def refused(setups):
    try:
        selection(setups)
    except SystemExit:
        return True
    return False


check("-F and -FA cannot share a run", refused(["A-F", "B-FA"]), True)
check("the three -F legs are one run", refused(["A-F", "B-F", "C-F"]), False)
check("the three -FA legs are one run", refused(["A-FA", "B-FA", "C-FA"]), False)

# ---------------- the dashboard lists the same legs ----------------
SETUPS_TS = (Path(__file__).resolve().parents[3] / "src" / "lib" / "backtest" / "setups.ts")
text = SETUPS_TS.read_text(encoding="utf-8")
for strategy in (FL, FS, AL, AS):
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
