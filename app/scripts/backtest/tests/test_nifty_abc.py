"""The live A, B and C on NIFTY - A-NIFTY, B-NIFTY, C-NIFTY. Backtest only.

What this file pins down:

  - the definition: live long v11 / short v7 plus R 650, no cross-leg cap,
    NIFTY as the instrument, and nothing else
  - the overnight scan on the index: pivots from NIFTY's previous session, the
    official close, the OPTIDX weekly chain, NIFTY's own ADR, the index lot size
  - a whole session through replay_session: v2 takes each setup at most once a
    day - a second fresh break of A the same day is not traded (v1 re-armed and
    took it); A firing does not use up B
  - Rs 650 a trade on a 65 lot (10 premium points), the weekly contract, 0 DTE
  - the gate asks the index options (OPTIDX), never the stock ones
  - one book, its own run; the dashboard lists the same legs

    py -3.12 tests/test_nifty_abc.py
"""
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fake_archive import IST, Result
from settings import GATE_FLOORS
from backtest import runner
from backtest import strategies as S
from backtest.runner import replay_session
from backtest.strategies import selection

DAY, PREV = dt.date(2026, 10, 15), dt.date(2026, 10, 14)
LONG, SHORT = S.NIFTY_BREAKOUT_RETRACE_21EMA, S.NIFTY_BREAKDOWN_RETRACE_21EMA

passed, failed = 0, []


def check(name, got, want):
    global passed
    if got == want:
        passed += 1
    else:
        failed.append(f"{name}\n      got  {got}\n      want {want}")


def at(day, h, m):
    return dt.datetime.combine(day, dt.time(h, m), tzinfo=IST)


# ---------------- the definition ----------------

live = S.BREAKOUT_RETRACE_21EMA
changed = {"instrument": "NIFTY", "maxTradesPerDay": None, "maxTradesPerSymbolPerDay": None,
           "skipStockLiquidity": True}
check("v2: no re-arm - each setup once a day", ("rearmAfterSignal" in LONG["params"],
                                               LONG["version"], SHORT["version"]), (False, 2, 2))
check("everything not changed is the live rule",
      {k: v for k, v in LONG["params"].items() if k not in changed},
      {k: v for k, v in live["params"].items() if k not in changed})
check("the changes", {k: LONG["params"][k] for k in changed}, changed)
check("the short reads the same params", SHORT["params"], LONG["params"])
check("R is Rs 650; target 1:2 = Rs 1,300; the live ladder otherwise",
      LONG["risk"], dict(live["risk"], rupeesPerTrade=650))
check("21 EMA on 5-minute bars, entries to 13:00, flat 15:15, 3 open",
      {k: LONG["params"][k] for k in ("emaPeriod", "emaIntervalMinutes", "entryCutoffIst",
                                      "flattenIst", "maxOpenTrades")},
      {"emaPeriod": 21, "emaIntervalMinutes": 5, "entryCutoffIst": "13:00",
       "flattenIst": "15:15", "maxOpenTrades": 3})
check("own book", (LONG["book"], SHORT["book"]), ("nifty-abc", "nifty-abc"))


def refused(setups):
    try:
        selection(setups)
    except SystemExit:
        return True
    return False


check("A and A-NIFTY cannot share a run", refused(["A", "A-NIFTY"]), True)
check("nor ORB and C-NIFTY", refused(["ORB", "C-NIFTY"]), True)
check("the three NIFTY legs are one run", refused(["A-NIFTY", "B-NIFTY", "C-NIFTY"]), False)


# ---------------- a stand-in archive for NIFTY ----------------
# Previous session 24300 / 23700, official close 24000: P 24000, R1 24229.20,
# S1 23770.80. Strike 24250 is call-heavy 10x (confirms R1), 23750 put-heavy 10x
# (confirms S1); the rest balanced. ADR: 13 sessions of 1% and the previous one
# of 2.5% -> 1.107% of 24000 = Rs 265.7; zone 0.15 ADR = 39.9, turn 0.075 ADR = 19.9.

def p(v):
    return int(round(v * 100))


class NiftyArchive:
    def __init__(self, prices, premium=120.0, expiry=DAY + dt.timedelta(days=5)):
        self.prices = prices                  # {minute: spot}
        self.premium = premium
        self.expiry = expiry
        self.instruments = set()

    def execute(self, sql, params=()):
        q = " ".join(sql.split())
        if "FROM trading_calendar" in q:
            return Result([(params[0] - dt.timedelta(days=1),)])
        if "FROM spot_1min" in q and "GROUP BY 1" in q:
            rows = [(PREV - dt.timedelta(days=i), p(24120), p(23880), p(24000)) for i in range(13, 0, -1)]
            return Result(rows + [(PREV, p(24300), p(23700), p(23990))])
        if "max(underlying_paise)" in q:
            return Result([(p(24000),)])
        if "FROM fo_bhavcopy" in q and "instrument = %s" in q:
            self.instruments.add(params[2])
        if "min(expiry_date) FROM fo_bhavcopy" in q:
            return Result([(self.expiry,)])
        if "strike_paise, option_type, open_interest FROM fo_bhavcopy" in q:
            rows = []
            for k in range(23000, 25001, 50):
                call, put = (1000.0, 100.0) if k == 24250 else (100.0, 1000.0) if k == 23750 else (500.0, 500.0)
                rows += [(p(k), "CE", call), (p(k), "PE", put)]
            return Result(rows)
        if "SELECT lot_size FROM fo_bhavcopy" in q:
            return Result([(65,)])
        if "max(open_interest) FROM fo_bhavcopy" in q:
            return Result([(10_000_000.0,)])
        if "open_interest, contracts FROM fo_bhavcopy" in q:
            return Result([(5_000_000.0, 200_000)])
        if "FROM done" in q:
            return Result([(22,)])
        if "FROM corporate_actions" in q:
            return Result([])
        if "FROM liquidity_rank WHERE month" in q:
            return Result([])
        if "min(expiry_date) FROM option_1min" in q:
            return Result([(self.expiry,)])
        if "FROM option_1min" in q:
            _, _, side, _, _ = params
            rows = []
            for minute, spot in sorted(self.prices.items()):
                centre = round(spot / 50) * 50
                for k in range(centre - 250, centre + 251, 50):
                    off = (k - centre) // 50
                    v = max(0.05, self.premium - off * 20 * (1 if side == "CE" else -1))
                    rows.append((minute, p(k), off, p(v), p(v), p(v), p(v), 50_000, p(spot)))
            return Result(rows)
        if "FROM spot_1min" in q and "symbol = ANY" in q:
            return Result([("NIFTY", m, p(v), p(v), p(v), p(v), 0) for m, v in sorted(self.prices.items())])
        if "FROM spot_1min" in q:
            _, start, end = params
            rows = []
            d = start.date()
            while d < end.date():
                rows += [(at(d, 9, 15) + dt.timedelta(minutes=i), p(24000)) for i in range(375)]
                d += dt.timedelta(days=1)
            return Result(rows)
        raise AssertionError("unexpected query: " + q[:140])


def path(spec):
    out = {}
    for first, last, price in spec:
        for m in range(first, last + 1):
            out[at(DAY, 9, m)] = float(price)
    return out


# Breaks R1 at 09:20, back to 24050 at 09:25 (EMA 24023.6), turns at 09:26: A.
# Under the level again at 09:27, breaks again at 09:30, back to 24080 at 09:35
# (EMA 24049.4), turns at 09:36 - a second A setup, which v2 does not trade.
TWICE = path([(15, 19, 24000), (20, 24, 24260), (25, 25, 24050), (26, 26, 24075),
              (27, 29, 24075), (30, 34, 24260), (35, 35, 24080), (36, 59, 24105)])


def run(prices, setups=("A-NIFTY",), strategies=None, **kw):
    arch = NiftyArchive(prices, **kw)
    strategy_ids, chosen = selection(list(setups))
    trades, notes = replay_session(arch, DAY, strategies or [S.STRATEGIES[s] for s in strategy_ids],
                                   GATE_FLOORS, setups=chosen)
    return trades, notes, arch


# ---------------- the scan on the index ----------------

plans = runner._index_plans(NiftyArchive(TWICE), DAY, PREV, [LONG], "NIFTY")
plan = plans[LONG["id"]].get("NIFTY")
check("NIFTY gets a plan", plan is not None, True)
check("R1 from the previous session and the official close, confirmed at 24250",
      (plan.major_resistance.pivot, round(plan.major_resistance.pivot_value, 2), plan.major_resistance.strike),
      ("R1", 24229.2, 24250.0))
check("S1 at 23750", (plan.major_support.pivot, plan.major_support.strike), ("S1", 23750.0))
check("the index's lot size", plan.lot_size, 65)
check("NIFTY's own 14-session ADR", round(plan.adr_pct, 3), round((13 * 1.0 + 2.5) / 14, 3))


# ---------------- whole sessions ----------------

trades, notes, arch = run(TWICE)
check("A trades its first setup at 09:26 and not the second one at 09:36",
      [(t.setup, t.entry_at.strftime("%H:%M")) for t in trades], [("A-NIFTY", "09:26")])
check("on the weekly NIFTY call, ATM at entry",
      [(t.symbol, t.option_type, t.expiry, t.strike) for t in trades],
      [("NIFTY", "CE", DAY + dt.timedelta(days=5), 24100.0)])
check("Rs 650 on 65 = 10 premium points of risk",
      [(t.qty, round(t.risk_per_unit, 4), round(t.risk_per_unit * t.qty, 2)) for t in trades],
      [(65, 10.0, 650.0)])
from backtest.position import size_trade  # noqa: E402
sized = size_trade(120.0, 65, LONG["risk"])
check("opening stop 10 under, 1:2 target 20 over (Rs 1,300)",
      (round(sized.stop, 4), round(sized.target, 4)), (110.0, 140.0))
check("the gate read the index options only", arch.instruments, {"OPTIDX"})
check("the stock liquidity proxies are not applied: clear, not approx",
      [t.gate for t in trades], ["clear"])
check("one signal: the spent leg never signals again that day",
      (notes["signals"], dict(notes["rejected"])), (1, {}))

v1 = [dict(LONG, params=dict(LONG["params"], rearmAfterSignal=True))]
twice, _, _ = run(TWICE, strategies=v1)
check("v1's re-arm would have taken the 09:36 setup too",
      [t.entry_at.strftime("%H:%M") for t in twice], ["09:26", "09:36"])

zero, _, _ = run(TWICE, expiry=DAY)
check("expiry day trades the expiring weekly (0 DTE)",
      [(t.expiry, t.entry_at.strftime("%H:%M")) for t in zero], [(DAY, "09:26")])

together, _, _ = run(TWICE, setups=("A-NIFTY", "B-NIFTY", "C-NIFTY"))
check("all three legs: one A and one B; B's 09:30 re-cross is not traded; no C setup, no C",
      sorted((t.setup, t.entry_at.strftime("%H:%M")) for t in together),
      [("A-NIFTY", "09:26"), ("B-NIFTY", "09:20")])
check("the 09:20 B was stopped when NIFTY fell back, freeing its slot",
      [t.exit_reason for t in together if t.entry_at == at(DAY, 9, 20)], ["stop"])


def most_open(ts):
    events = sorted([(t.entry_at, 1) for t in ts] + [(t.exit_at, -1) for t in ts],
                    key=lambda e: (e[0], e[1]))
    n = peak = 0
    for _, d in events:
        n += d
        peak = max(peak, n)
    return peak


check("never more than 3 open at once", most_open(together) <= 3, True)
crowded = path([(15, 19, 24000), (20, 24, 24260), (25, 25, 24050), (26, 26, 24075),
                (27, 29, 24075), (30, 34, 24260), (35, 35, 24080), (36, 59, 24105)])
one_slot = [dict(st, params=dict(st["params"], maxOpenTrades=1)) for st in (LONG,)]
single, notes1, _ = run(crowded, setups=("A-NIFTY", "B-NIFTY"), strategies=one_slot)
check("with one slot, never more than one open", most_open(single) <= 1, True)


# ---------------- the dashboard lists the same legs ----------------
text = (Path(__file__).resolve().parents[3] / "src" / "lib" / "backtest" / "setups.ts").read_text(encoding="utf-8")
for strategy in (LONG, SHORT):
    for setup in strategy["setups"]:
        block = text.split(f'setup: "{setup}"', 1)
        body = block[1].split("}", 1)[0] if len(block) == 2 else ""
        check(f"setups.ts lists {setup} under {strategy['id']} v{strategy['version']}",
              (f'strategy: "{strategy["id"]}"' in body, f"version: {strategy['version']}," in body,
               'book: "nifty-abc"' in body, 'instrument: "NIFTY"' in body),
              (True, True, True, True))


print(f"{passed} passed, {len(failed)} failed")
for f in failed:
    print("  FAIL  " + f)
sys.exit(1 if failed else 0)
