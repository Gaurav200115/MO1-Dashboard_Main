"""Estimated charges in backtest results - Kotak Neo since 2026-11-25.

  - the rates here are exactly charges.ts's BACKTEST_CHARGE_RATES (the page and
    the run must agree), and the Zerodha set exactly its CHARGE_RATES
  - Kotak Neo: no brokerage, no GST
  - the 19 Nov contract note (Zerodha): two round trips, 138 charged
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


def ts_rates(name):
    start = TS.index(f"export const {name} = {{")
    block = TS[start:TS.index("} as const", start)]
    return {k: float(v) for k, v in re.findall(r"(\w+):\s*([\d.]+)", block)}


check("backtest rates match charges.ts BACKTEST_CHARGE_RATES exactly", ts_rates("BACKTEST_CHARGE_RATES"),
      {k: float(v) for k, v in charges.RATES.items()})
check("Zerodha rates match charges.ts CHARGE_RATES exactly", ts_rates("CHARGE_RATES"),
      {k: float(v) for k, v in charges.ZERODHA_RATES.items()})
check("Kotak Neo: no brokerage, no GST", (charges.RATES["brokeragePerOrder"], charges.RATES["gstPct"]), (0, 0))
check("and the statutory rates are Zerodha's",
      {k: v for k, v in charges.RATES.items() if k not in ("brokeragePerOrder", "gstPct")},
      {k: v for k, v in charges.ZERODHA_RATES.items() if k not in ("brokeragePerOrder", "gstPct")})

titan = charges.round_trip(54.9 * 175, 54.9 * 175 - 901, charges.ZERODHA_RATES)
ashok = charges.round_trip(1.81 * 5000, 1.81 * 5000 + 550, charges.ZERODHA_RATES)
check("19 Nov (Zerodha): TITAN + ASHOKLEY round trips ~ 138 on the contract note", round(titan + ashok), 138)
check("Zerodha's flat part of a round trip: 40 brokerage + 18% GST = 47.20",
      round(charges.round_trip(0, 0, charges.ZERODHA_RATES), 2), 47.2)
check("Kotak Neo has no flat part", charges.round_trip(0, 0), 0.0)
k_titan = charges.round_trip(54.9 * 175, 54.9 * 175 - 901)
check("Kotak Neo on the TITAN round trip = Zerodha's less brokerage and all GST",
      round(k_titan, 6), round(titan - 40 - 0.18 * (40 + (54.9 * 175 * 2 - 901) * (0.03553 / 100 + 10 / 1e7)), 6))


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


# ---------------- re-pricing a stored run (run.py recharge) ----------------
import datetime as dt  # noqa: E402
import types  # noqa: E402

if "pymongo" not in sys.modules:
    try:
        import pymongo  # noqa: F401
    except ImportError:
        stub = types.ModuleType("pymongo")
        stub.MongoClient = object
        stub.UpdateOne = lambda flt, upd: (flt, upd)
        stub.ReturnDocument = types.SimpleNamespace(AFTER=True)
        sys.modules["pymongo"] = stub
from backtest import results  # noqa: E402


class Coll:
    def __init__(self, docs):
        self.docs = {d["_id"]: d for d in docs}

    def find(self, flt, projection=None):
        return [d for d in self.docs.values() if all(d.get(k) == v for k, v in flt.items())]

    def bulk_write(self, ops, ordered=False):
        for op in ops:
            flt, upd = (op._filter, op._doc) if hasattr(op, "_filter") else op
            self.docs[flt["_id"]].update(upd["$set"])

    def update_one(self, flt, upd):
        self.docs[flt["_id"]].update(upd["$set"])


T0 = dt.datetime(2026, 10, 15, 4, 0)


def stored(i, setup, entry, exit_price, qty, gate="clear"):
    return {"_id": f"r1:{i}", "runId": "r1", "setup": setup, "gate": gate, "qty": qty,
            "buy": {"price": entry}, "sell": {"price": exit_price}, "profit": (exit_price - entry) * qty,
            "openedAt": T0 + dt.timedelta(minutes=i), "closedAt": T0 + dt.timedelta(minutes=i + 30),
            "charges": 999.0}


trade_docs = [stored(1, "A-ATR600", 30, 36, 250), stored(2, "B-ATR600", 30, 27.8, 250, "approx"),
              stored(3, "A-ATR600", 10, 10.1, 750)]
run_doc = {"_id": "r1", "status": "done", "setups": ["A-ATR600", "B-ATR600"],
           "bySetup": {"A-ATR600": {"signals": 7}, "B-ATR600": {"signals": 4}}}
fake = {results.TRADES: Coll(trade_docs), results.RUNS: Coll([run_doc])}
results.recharge_run(fake, run_doc, summarise)

as_positions = [results._stored_position(d) for d in trade_docs]
check("each stored trade re-priced at Kotak Neo",
      [d["charges"] for d in trade_docs], [round(charges.of_position(p), 2) for p in as_positions])
rerun = fake[results.RUNS].docs["r1"]
check("the run's summary is what a fresh run would store",
      rerun["summary"], summarise(as_positions))
check("its net before charges is untouched", rerun["summary"]["net"], round(6 * 250 - 2.2 * 250 + 0.1 * 750, 2))
check("each leg re-priced, keeping its signal count",
      (rerun["bySetup"]["A-ATR600"]["trades"], rerun["bySetup"]["A-ATR600"]["signals"],
       rerun["bySetup"]["B-ATR600"]["charges"]),
      (2, 7, round(charges.of_position(as_positions[1]), 2)))
check("the approx-gated trade is left out of the ex-approx summary", rerun["summaryExApprox"]["trades"], 2)
check("and the run says whose charges these are", rerun["chargesBroker"], "Kotak Neo")

print(f"{passed} passed, {len(failed)} failed")
for f in failed:
    print("  FAIL  " + f)
sys.exit(1 if failed else 0)
