"""Two changes to setup A on the -ATR600 rule: -2X and -OEMA. Backtest only.

  -2X    A may trade a stock twice a day; after the first A trade closes, A needs a
         fresh break and retrace. B and C keep one a stock.
  -OEMA  A enters only when the ATM option is above its own 1-minute 21 EMA,
         checked once at the moment A fires; otherwise the setup is lost.

    py -3.12 tests/test_a_variants.py
"""
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fake_archive import FakeArchive, Stock, at
from settings import GATE_FLOORS
from backtest import strategies as S
from backtest.runner import option_ema, replay_session
from backtest.signals import SymbolState, _can_trade_a
from backtest.strategies import selection

DAY = dt.date(2026, 10, 15)
passed, failed = 0, []


def check(name, got, want):
    global passed
    if got == want:
        passed += 1
    else:
        failed.append(f"{name}\n      got  {got}\n      want {want}")


# ---------------- the definitions ----------------
X_LONG, X_SHORT = S.BREAKOUT_RETRACE_21EMA_A2X, S.BREAKDOWN_RETRACE_21EMA_A2X
O_LONG, O_SHORT = S.BREAKOUT_RETRACE_21EMA_AOEMA, S.BREAKDOWN_RETRACE_21EMA_AOEMA
ATR600 = S.BREAKOUT_RETRACE_21EMA_ATR600

for rule in (X_LONG, X_SHORT, O_LONG, O_SHORT):
    check(f"{rule['id']}: the -ATR600 stop and ladder", rule["risk"], ATR600["risk"])
    check(f"{rule['id']}: backtest only, v1", (rule["backtestOnly"], rule["version"]), (True, 1))
check("-2X params: -ATR600's plus A twice and the re-arm",
      {k: v for k, v in X_LONG["params"].items() if k not in ("maxATradesPerSymbolPerDay", "rearmAAfterClose")},
      ATR600["params"])
check("-2X: twice, re-armed after close",
      (X_LONG["params"]["maxATradesPerSymbolPerDay"], X_LONG["params"]["rearmAAfterClose"]), (2, True))
check("-2X keeps one trade a stock for everyone else", X_LONG["params"]["maxTradesPerSymbolPerDay"], 1)
check("-OEMA params: -ATR600's plus the option EMA on A",
      {k: v for k, v in O_LONG["params"].items() if k != "optionEmaGate"}, ATR600["params"])
check("-OEMA: A only, 21 periods, 1-minute bars", O_LONG["params"]["optionEmaGate"],
      {"legs": ["A"], "period": 21, "intervalMinutes": 1})
check("setups and books",
      (X_LONG["setups"], X_SHORT["setups"], O_LONG["setups"], O_SHORT["setups"], X_LONG["book"], O_LONG["book"]),
      (["A-2X", "B-2X"], ["C-2X"], ["A-OEMA", "B-OEMA"], ["C-OEMA"], "atr600-a2x", "atr600-aoema"))
check("legs", (X_LONG["legs"], O_SHORT["legs"]), ({"A-2X": "A", "B-2X": "B"}, {"C-OEMA": "C"}))
check("the short buys a put", (X_SHORT["sides"], O_SHORT["sides"]), ({"C-2X": "SHORT"}, {"C-OEMA": "SHORT"}))


# ---------------- A's own per-stock limit ----------------
def state(trades, a):
    s = SymbolState(symbol="X")
    s.trades_today, s.a_trades = trades, a
    return s


p2 = X_LONG["params"]
check("-2X: A's first trade on a stock", _can_trade_a(state(0, 0), p2), True)
check("-2X: A's second", _can_trade_a(state(1, 1), p2), True)
check("-2X: no third", _can_trade_a(state(2, 2), p2), False)
check("-2X: a stock B traded stays closed to A", _can_trade_a(state(1, 0), p2), False)
check("every other rule: one a stock, as before",
      (_can_trade_a(state(0, 0), ATR600["params"]), _can_trade_a(state(1, 1), ATR600["params"])), (True, False))


# ---------------- the option's EMA ----------------
bars = {at(DAY, 9, 15 + i): {"close": 10.0 + i} for i in range(30)}
check("option EMA: under 21 closes before the minute, none", option_ema(bars, at(DAY, 9, 35), 21), None)
check("21 closes: their plain mean", option_ema(bars, at(DAY, 9, 36), 21), sum(10.0 + i for i in range(21)) / 21)
check("the entry minute's own close is not in it",
      option_ema(bars, at(DAY, 9, 36), 21), option_ema({**bars, at(DAY, 9, 36): {"close": 999.0}}, at(DAY, 9, 36), 21))
check("a minute the option did not trade is not a bar",
      option_ema({m: b for m, b in bars.items() if m != at(DAY, 9, 20)}, at(DAY, 9, 36), 21), None)


# ---------------- whole sessions ----------------
# test_pivot_skew.py's ALPHA: R1 at about 1022.92, the EMA seeded flat at 1000, ADR
# 2% (zone 3.0, turn 1.5). Its A pattern - break to 1024, pull back to 1004.50,
# turn up to 1006.50 - takes A at 09:28.

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


def stock(symbol, spot, prem, skew=4.0):
    """`skew=0` prices every strike alike, so an option's own minutes do not jump
    when the stand-in re-centres its strikes on a moving spot."""
    return Stock(symbol=symbol, ohlc=(1030.0, 970.0, 1000.0), chain=chain_dict(), prices=spot, seed=1000.0,
                 atm=1020.0, premium=prem, history=((1010.0, 990.0, 1000.0),) * 14, seed_range=6.0,
                 skew_per_strike=skew)


def run(stocks, setups):
    strategy_ids, chosen = selection(setups)
    return replay_session(FakeArchive(DAY, stocks), DAY, [S.STRATEGIES[s] for s in strategy_ids],
                          GATE_FLOORS, setups=chosen)


def entries(trades):
    return [(p.setup, p.entry_at.strftime("%H:%M")) for p in sorted(trades, key=lambda p: p.entry_at)]


# Twice in a morning: the 09:28 A, a fall through its stop at 09:40, back under
# the level, then a second break at 10:20 and the same pullback again.
TWICE = prices([(9, 15, 19, 1000), (9, 20, 24, 1024), (9, 25, 25, 1005.5), (9, 26, 26, 1008),
                (9, 27, 27, 1004.5), (9, 28, 59, 1006.5), (10, 0, 19, 1006.5), (10, 20, 24, 1024),
                (10, 25, 25, 1008), (10, 26, 26, 1007), (10, 27, 59, 1009.5)])
STOPPED = premium([(9, 15, 39, 30, 30, 30, 30), (9, 40, 40, 30, 30, 20, 20), (9, 41, 59, 20, 20, 20, 20),
                   (10, 0, 59, 20, 20, 20, 20)])
HELD = premium([(9, 15, 59, 30, 30, 30, 30), (10, 0, 59, 30, 30, 30, 30)])

one, notes_one = run([stock("ALPHA", TWICE, STOPPED)], ["A-ATR600"])
two, notes_two = run([stock("ALPHA", TWICE, STOPPED)], ["A-2X"])
check("-ATR600: one A on ALPHA", entries(one), [("A-ATR600", "09:28")])
check("-2X: the first A is -ATR600's", entries(two)[:1], [("A-2X", "09:28")])
check("-2X: after it closed, a fresh break and retrace takes A again", len(two), 2)
check("the second came after the first closed, off the 10:20 break",
      (two[0].exit_at <= two[1].entry_at, two[1].entry_at >= at(DAY, 10, 20)), (True, True))
check("both under the -2X rule, the ATR600 stop and ladder",
      [(p.strategy_id, p.context["atrStop"]["ladderRupees"]) for p in two],
      [("breakout-retrace-21ema-atr600-a2x", 600)] * 2)

held, _ = run([stock("ALPHA", TWICE, HELD)], ["A-2X"])
check("-2X: while the first A is still open there is no second", entries(held), [("A-2X", "09:28")])

three = prices([(9, 15, 19, 1000), (9, 20, 24, 1024), (9, 25, 25, 1005.5), (9, 26, 26, 1008),
                (9, 27, 27, 1004.5), (9, 28, 59, 1006.5), (10, 0, 19, 1006.5), (10, 20, 24, 1024),
                (10, 25, 25, 1008), (10, 26, 26, 1007), (10, 27, 49, 1009.5), (10, 50, 54, 1024),
                (10, 55, 55, 1012), (10, 56, 56, 1011), (10, 57, 59, 1013.5)])
DOWN = premium([(9, 15, 39, 30, 30, 30, 30), (9, 40, 40, 30, 30, 20, 20), (9, 41, 59, 20, 20, 20, 20),
                (10, 0, 30, 20, 20, 20, 20), (10, 31, 31, 20, 20, 10, 10), (10, 32, 59, 10, 10, 10, 10)])
capped, _ = run([stock("ALPHA", three, DOWN)], ["A-2X"])
check("-2X: never a third A on the stock", len(capped) <= 2, True)


# -OEMA. The same A pattern an hour later, so the option has 21+ minutes behind it:
# flat at 1000 until 10:19, break at 10:20, pull back, turn up at 10:28.
LATE = prices([(9, 15, 59, 1000), (10, 0, 19, 1000), (10, 20, 24, 1024), (10, 25, 25, 1005.5),
               (10, 26, 26, 1008), (10, 27, 27, 1004.5), (10, 28, 59, 1006.5)])
RISING = {at(DAY, 9, 15) + dt.timedelta(minutes=i): (20 + 0.1 * i,) * 4 for i in range(105)}
FALLING = {at(DAY, 9, 15) + dt.timedelta(minutes=i): (40 - 0.1 * i,) * 4 for i in range(105)}
FLAT = {at(DAY, 9, 15) + dt.timedelta(minutes=i): (30.0,) * 4 for i in range(105)}

plain, _ = run([stock("ALPHA", LATE, RISING, skew=0.0)], ["A-ATR600"])
check("-ATR600 takes the late A at 10:28", entries(plain), [("A-ATR600", "10:28")])
up, _ = run([stock("ALPHA", LATE, RISING, skew=0.0)], ["A-OEMA"])
check("-OEMA: option rising, above its EMA - the same trade", entries(up), [("A-OEMA", "10:28")])
check("at the same price", [p.entry for p in up], [p.entry for p in plain])
down, down_notes = run([stock("ALPHA", LATE, FALLING, skew=0.0)], ["A-OEMA"])
check("-OEMA: option falling, under its EMA - no trade", down, [])
check("counted as its own rejection", down_notes["rejected"].get("option under its 1-min 21 EMA"), 1)
flat, _ = run([stock("ALPHA", LATE, FLAT, skew=0.0)], ["A-OEMA"])
check("-OEMA: exactly at its EMA is not above it", flat, [])
early, early_notes = run([stock("ALPHA", TWICE, HELD)], ["A-OEMA"])
check("-OEMA: A at 09:28 has 13 option minutes behind it - no EMA, no trade", early, [])
check("counted as not ready", early_notes["rejected"].get("option 1-min EMA not ready"), 1)

# B is not checked: SHORTY-style C and ALPHA's B fire under -OEMA as under -ATR600.
b_plain, _ = run([stock("ALPHA", TWICE, FALLING)], ["B-ATR600"])
b_oema, _ = run([stock("ALPHA", TWICE, FALLING)], ["B-OEMA"])
check("-OEMA leaves B alone", [t for _, t in entries(b_oema)], [t for _, t in entries(b_plain)])
check("and B did trade", len(b_plain) > 0, True)


# ---------------- runs are one book or another ----------------
def refused(setups):
    try:
        selection(setups)
    except SystemExit:
        return True
    return False


check("-2X and -ATR600 cannot share a run", refused(["A-2X", "B-ATR600"]), True)
check("nor -2X and -OEMA", refused(["A-2X", "A-OEMA"]), True)
check("the three -2X legs are one run", refused(["A-2X", "B-2X", "C-2X"]), False)
check("the three -OEMA legs are one run", refused(["A-OEMA", "B-OEMA", "C-OEMA"]), False)


# ---------------- the dashboard lists the same legs ----------------
SETUPS_TS = (Path(__file__).resolve().parents[3] / "src" / "lib" / "backtest" / "setups.ts")
text = SETUPS_TS.read_text(encoding="utf-8")
for strategy in (X_LONG, X_SHORT, O_LONG, O_SHORT):
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
