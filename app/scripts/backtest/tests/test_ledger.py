"""The capital ledger (backtest/ledger.py).

  - the balance: capital plus every closed trade's profit less charges
  - a trade is taken only if its premium fits in the balance left after open trades
  - peak, low, deepest fall, longest stretch under a peak; one row a day
  - whole sessions: a second trade that does not fit is skipped and counted
  - the run id changes with a capital, and is unchanged without one

    py -3.12 tests/test_ledger.py
"""
import datetime as dt
import hashlib
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fake_archive import FakeArchive, Stock, at
from settings import GATE_FLOORS
from backtest import charges
from backtest import strategies as S
from backtest.ledger import Ledger
from backtest.runner import replay_session, run_key, run_range
from backtest.strategies import selection

DAY = dt.date(2026, 10, 15)
passed, failed = 0, []


def check(name, got, want):
    global passed
    if got == want:
        passed += 1
    else:
        failed.append(f"{name}\n      got  {got}\n      want {want}")


def pos(entry, exit_price, qty=100):
    return types.SimpleNamespace(entry=entry, exit_price=exit_price, qty=qty,
                                 profit=(exit_price - entry) * qty, context={})


# ---------------- the arithmetic ----------------
lg = Ledger(10_000)
lg.start_day("2026-10-14")
a = pos(30, 36)                       # +600
lg.close(a)
cost_a = charges.of_position(a)
check("a win: balance = capital + profit - charges", round(lg.balance, 2), round(10_000 + 600 - cost_a, 2))
check("the trade carries the balance after it", a.context["ledger"]["balanceAfter"], round(lg.balance, 2))
lg.close(a)
check("booking the same trade twice does nothing", round(lg.balance, 2), round(10_000 + 600 - cost_a, 2))
b = pos(30, 20)                       # -1,000
lg.close(b)
lg.end_day()
bal = 10_000 + 600 - cost_a - 1000 - charges.of_position(b)
check("a loss comes off it", round(lg.balance, 2), round(bal, 2))
check("the peak is the high-water balance", round(lg.peak, 2), round(10_000 + 600 - cost_a, 2))
check("the deepest fall is from that peak", round(lg.max_drawdown, 2), round(bal - (10_000 + 600 - cost_a), 2))
check("a day row", {k: lg.days[0][k] for k in ("date", "open", "trades", "skipped")},
      {"date": "2026-10-14", "open": 10_000, "trades": 2, "skipped": 0})
check("its P&L is before charges, its charges beside it",
      (lg.days[0]["pnl"], lg.days[0]["charges"]), (-400.0, round(cost_a + charges.of_position(b), 2)))

fit = Ledger(10_000)
open_now = [types.SimpleNamespace(entry=30, qty=250)]            # 7,500 in an open trade
check("a 2,500 premium fits beside a 7,500 open trade", fit.fits(open_now, types.SimpleNamespace(entry=10, qty=250)), True)
check("2,500.01 does not", fit.fits(open_now, types.SimpleNamespace(entry=10.0001, qty=250)), False)
check("nothing fits a balance at zero", Ledger(0.0).fits([], types.SimpleNamespace(entry=1, qty=1)), False)

under = Ledger(1000)
for i, change in enumerate((100, -300, 50, 50, 300)):
    under.start_day(f"d{i}")
    under.balance += change
    under.peak = max(under.peak, under.balance)
    under.end_day()
check("longest stretch of days closed under a previous peak", under.report()["longestUnderwaterDays"], 3)


# ---------------- whole sessions ----------------
# Two stocks, the same A pattern (test_pivot_skew.py's ALPHA), entering at 09:28 on
# a premium of 30 x 250 = 7,500 each.
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


def premium(stop_at=None):
    out = {}
    for m in range(15, 60):
        v = 20.0 if stop_at is not None and m >= stop_at else 30.0
        out[at(DAY, 9, m)] = (30.0, 30.0, v, v) if m == stop_at else (v,) * 4
    return out


def stock(symbol, prem):
    return Stock(symbol=symbol, ohlc=(1030.0, 970.0, 1000.0), chain=chain_dict(), prices=prices(), seed=1000.0,
                 atm=1020.0, premium=prem, history=((1010.0, 990.0, 1000.0),) * 14, seed_range=6.0,
                 skew_per_strike=0.0)


def session(stocks, capital):
    strategy_ids, chosen = selection(["A-ATR600"])
    ledger = Ledger(capital) if capital else None
    if ledger:
        ledger.start_day(DAY)
    trades, notes = replay_session(FakeArchive(DAY, stocks), DAY, [S.STRATEGIES[s] for s in strategy_ids],
                                   GATE_FLOORS, setups=chosen, ledger=ledger)
    if ledger:
        ledger.end_day()
    return trades, notes, ledger


two = [stock("ALPHA", premium()), stock("BETA", premium())]
free, _, _ = session(two, None)
check("no ledger: both trades", len(free), 2)
tight, notes, lg = session(two, 10_000)
check("Rs 10,000: the first 7,500 fits, the second does not", len(tight), 1)
check("counted as its own rejection", notes["rejected"].get("not enough capital (ledger)"), 1)
check("and in the ledger", (lg.skipped, lg.days[0]["skipped"]), (1, 1))
roomy, _, lg2 = session(two, 20_000)
check("Rs 20,000: both fit", len(roomy), 2)
check("both booked at the end of the data", lg2.days[0]["trades"], 2)
check("the balance is the capital plus their net",
      round(lg2.balance, 2), round(20_000 + sum(p.profit - charges.of_position(p) for p in roomy), 2))

# A stop frees its premium: ALPHA stopped at 09:40 -> its 7,500 is back (less the loss)
# for anything after. Booked the minute it closed.
stopped, _, lg3 = session([stock("ALPHA", premium(stop_at=40))], 10_000)
check("a stop is booked the minute it closes", stopped[0].context["ledger"]["balanceAfter"],
      round(10_000 + stopped[0].profit - charges.of_position(stopped[0]), 2))

# run_range: the ledger report on the run.
strategy_ids, _ = selection(["A-ATR600"])
_, report = run_range(FakeArchive(DAY, two), ["A-ATR600"], DAY, DAY, GATE_FLOORS, capital=10_000)
check("run_range reports the ledger", sorted(report["ledger"]),
      sorted(["capital", "final", "peak", "low", "maxDrawdown", "maxDrawdownPct", "longestUnderwaterDays",
              "skipped", "days"]))
check("one day row, one skipped trade", (len(report["ledger"]["days"]), report["ledger"]["skipped"]), (1, 1))
_, plain = run_range(FakeArchive(DAY, two), ["A-ATR600"], DAY, DAY, GATE_FLOORS)
check("no capital, no ledger", plain["ledger"], None)

# ---------------- the run id ----------------
base = "A-ATR600,B-ATR600,C-ATR600|2025-10-23|2026-11-12"
check("without a capital the id is what it always was",
      run_key(["C-ATR600", "A-ATR600", "B-ATR600"], "2025-10-23", "2026-11-12"),
      hashlib.sha1(base.encode()).hexdigest()[:16])
check("a capital is part of the id",
      run_key(["A-ATR600", "B-ATR600", "C-ATR600"], "2025-10-23", "2026-11-12", 35000),
      hashlib.sha1((base + "|capital=35000").encode()).hexdigest()[:16])
check("the pinned id the dashboard must produce (scripts/test-ledger-ts.mjs)",
      run_key(["A-ATR600", "B-ATR600", "C-ATR600"], "2025-10-23", "2026-11-12", 35000), "b86d9a756ff9f5d5")

print(f"{passed} passed, {len(failed)} failed")
for f in failed:
    print("  FAIL  " + f)
sys.exit(1 if failed else 0)
