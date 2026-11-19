"""Estimated Zerodha charges in backtest results.

  - the rates here are exactly charges.ts's (the page and the run must agree)
  - the 19 Nov contract note: two round trips, 138 charged
  - a run's summary carries charges and every headline after them

    py -3.12 tests/test_charges.py
"""
import re
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backtest import charges
from backtest.runner import summarise

passed, failed = 0, []


def check(name, got, want):
    global passed
    if got == want:
        passed += 1
    else:
        failed.append(f"{name}\n      got  {got}\n      want {want}")


TS = (Path(__file__).resolve().parents[3] / "src" / "lib" / "strategy" / "charges.ts").read_text(encoding="utf-8")
block = TS[TS.index("CHARGE_RATES = {"):TS.index("} as const")]
ts_rates = {k: float(v) for k, v in re.findall(r"(\w+):\s*([\d.]+)", block)}
check("the rates match charges.ts exactly", ts_rates, {k: float(v) for k, v in charges.RATES.items()})

titan = charges.round_trip(54.9 * 175, 54.9 * 175 - 901)
ashok = charges.round_trip(1.81 * 5000, 1.81 * 5000 + 550)
check("19 Nov: TITAN + ASHOKLEY round trips ~ 138 on the contract note", round(titan + ashok), 138)
check("the flat part of a round trip: 40 brokerage + 18% GST = 47.20", round(charges.round_trip(0, 0), 2), 47.2)


def pos(entry, exit_price, qty, at):
    return SimpleNamespace(entry=entry, exit_price=exit_price, qty=qty, profit=(exit_price - entry) * qty,
                           exit_at=at, entry_at=at)


rows = [pos(30, 36, 250, 1), pos(30, 27.8, 250, 2), pos(10, 10.1, 750, 3)]
s = summarise(rows)
expected_charges = sum(charges.of_position(p) for p in rows)
check("charges are the sum of each round trip", s["charges"], round(expected_charges, 2))
check("net after charges = net - charges", s["netAfterCharges"], round(s["net"] - expected_charges, 2))
check("expectancy after charges", s["expectancyAfterCharges"], round((s["net"] - expected_charges) / 3, 2))
check("a small winner can become a loser after charges: profit factor falls",
      s["profitFactorAfterCharges"] < s["profitFactor"], True)
check("drawdown after charges is at least as deep", s["maxDrawdownAfterCharges"] <= s["maxDrawdown"], True)
check("an empty run has zero charges", (summarise([])["charges"], summarise([])["netAfterCharges"]), (0.0, 0.0))

print(f"{passed} passed, {len(failed)} failed")
for f in failed:
    print("  FAIL  " + f)
sys.exit(1 if failed else 0)
