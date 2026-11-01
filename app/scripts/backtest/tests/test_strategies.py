"""Every leg the desk runs, replayed end to end - separately and together.

`test_session.py` takes one setup-A trade through `replay_session` in detail.
This file covers the rest of what the desk actually runs:

  - the **short** leg (C), which must buy a **put**
  - the long rule's two legs, **A** and **B**, run one at a time and together
  - all three on one session at once
  - the three-position cap, which is **desk-wide** and must be shared between
    them rather than given to each

That last one is the reason this file exists. Each rule could be correct on its
own and the pair still wrong: give the long rule three slots and the short rule
three more and the replay quietly runs six positions where the desk runs three,
on twice the risk, and every figure downstream of it is inflated.

    py -3.12 tests/test_strategies.py
"""
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fake_archive import FakeArchive, Stock, at, flat_premium, premium_falling_through
from settings import GATE_FLOORS
from backtest import strategies as S
from backtest.runner import replay_session
from backtest.strategies import selection

DAY = dt.date(2026, 10, 15)
LONG, SHORT = S.BREAKOUT_RETRACE_21EMA, S.BREAKDOWN_RETRACE_21EMA

passed, failed = 0, []


def check(name, got, want):
    global passed
    if got == want:
        passed += 1
    else:
        failed.append(f"{name}\n      got  {got}\n      want {want}")


def minute(h, m):
    return at(DAY, h, m)


# Previous session: high 1030, low 970, close 1000.
#   P = 1000, range = 60  ->  R1 = 1022.92, R2 = 1037.08, R3 = 1060
#                             S1 =  977.08, S2 =  962.92, S3 =  940
# Two strikes carry a lopsided book and nothing else does, so exactly one
# resistance and one support are marked:
#   1020  calls 10x puts  ->  confirms R1 (0.286% away; R2 is 1.65% away, out of band)
#    980  puts 10x calls  ->  confirms S1 (0.299% away; S2 is 1.77% away, out of band)
OHLC = (1030.0, 970.0, 1000.0)
CHAIN = {
    float(k): (1000.0, 100.0) if k == 1020 else (100.0, 1000.0) if k == 980 else (500.0, 500.0)
    for k in range(900, 1121, 10)
}


def prices(spec):
    """{minute: price} from a list of (first minute, last minute, price)."""
    out = {}
    for first, last, price in spec:
        for m in range(first, last + 1):
            out[minute(9, m)] = float(price)
    return out


# --- the short rule -------------------------------------------------------
# Breaks S1 at 977.08, falls to 970, rallies back into 0.4% of a 975 EMA, then
# rolls over 0.3% off the high of that rally.
#
# 09:15-09:19  978   above the support (and not so far above the EMA that the
#                    bar reads as the breakdown having failed)
# 09:20        972   breaks below 977.08
# 09:21-09:24  970   the low since the break
# 09:25        974   back inside 0.4% of the EMA, 0.41% up off that low
# 09:26        971   0.31% back down off the rally high -> entry
SHORT_PRICES = prices([(15, 19, 978), (20, 20, 972), (21, 24, 970),
                       (25, 25, 974), (26, 59, 971)])


def short_stock(symbol="SHORTY", premium=None):
    return Stock(symbol=symbol, ohlc=OHLC, chain=CHAIN, prices=SHORT_PRICES,
                 seed=975.0, atm=970.0,
                 premium=premium if premium is not None else flat_premium(DAY, 25.0))


# --- setup B --------------------------------------------------------------
# Holds above the major support the whole time and crosses R1 from below while
# above the EMA.
LONG_B_PRICES = prices([(15, 19, 1000), (20, 59, 1025)])


def long_b_stock(symbol="LONGY", premium=None):
    return Stock(symbol=symbol, ohlc=OHLC, chain=CHAIN, prices=LONG_B_PRICES,
                 seed=1000.0, atm=1020.0,
                 premium=premium if premium is not None else flat_premium(DAY, 30.0))


def run(stocks, setups):
    """Replays one session with only the named legs allowed to fire."""
    strategy_ids, chosen = selection(setups)
    return replay_session(FakeArchive(DAY, stocks), DAY,
                          [S.STRATEGIES[s] for s in strategy_ids], GATE_FLOORS,
                          setups=chosen)


# ---------------- the short rule on its own ----------------

positions, notes = run([short_stock()], ["C"])
check("the short rule produces a trade", len(positions), 1)

if positions:
    p = positions[0]
    check("on setup C", p.setup, "C")
    check("under the short rule", p.strategy_id, "breakdown-retrace-21ema")
    check("at the version in the registry", p.strategy_version, 3)
    check("and it BUYS A PUT", p.option_type, "PE")
    check("entered where the roll-over confirmed", p.entry_at, minute(9, 26))
    check("on the at-the-money strike", p.strike, 970.0)
    check("anchored on the support it broke", p.context["pivot"], "S1")
    check("which is a support", p.context["levelKind"], "support")
    check("off the rally high", round(p.context["retracement"]["extreme"], 2), 974.0)

# The short rule must not be able to fire the long rule's legs, even though the
# stock has a marked resistance sitting right there.
check("the short leg fires only setup C",
      {p.setup for p in run([short_stock(), long_b_stock()], ["C"])[0]}, {"C"})

# And a short that goes right still loses nothing to a sign error: the premium
# of a bought put rises as the stock falls, so the ladder is the same ladder.
won = run([short_stock(premium=premium_falling_through(DAY, 25.0, 22.0, 40))],
          ["C"])[0]
check("a short stopped out loses one R", round(won[0].profit), -550)
check("and is recorded as a stop", won[0].exit_reason, "stop")


# ---------------- setup B ----------------

positions, _ = run([long_b_stock()], ["B"])
check("setup B produces a trade", len(positions), 1)

if positions:
    p = positions[0]
    check("on setup B", p.setup, "B")
    check("which buys a call", p.option_type, "CE")
    check("entered on the cross", p.entry_at, minute(9, 20))
    check("naming the level crossed", p.context["pivot"], "R1")

# The long rule must not fire the short's leg either.
check("the long legs never fire the short's",
      {p.setup for p in run([short_stock(), long_b_stock()], ["A", "B"])[0]} <= {"A", "B"},
      True)


# ---------------- both rules on one session ----------------

positions, notes = run([short_stock(), long_b_stock()], ["A", "B", "C"])
check("all three legs run together", len(positions), 2)
check("one long and one short",
      sorted((p.setup, p.option_type) for p in positions),
      [("B", "CE"), ("C", "PE")])
check("each on its own stock",
      sorted(p.symbol for p in positions), ["LONGY", "SHORTY"])
check("and each under its own strategy",
      sorted(p.strategy_id for p in positions),
      ["breakdown-retrace-21ema", "breakout-retrace-21ema"])


# ---------------- the three-position cap is desk-wide ----------------
# Four stocks all firing setup B in the same minute, on premiums that never
# move, so nothing closes to free a slot.

four = [long_b_stock(symbol=name) for name in ("AAA", "BBB", "CCC", "DDD")]
positions, notes = run(four, ["A", "B"])
check("four signals, three positions", len(positions), 3)
check("the fourth is refused for a full book", notes["rejected"].get("book full"), 1)
check("all four signals were seen", notes["signals"], 4)

# The same cap, now with the two rules competing for it. Three stocks fire the
# long rule and two fire the short; the desk still holds three.
mixed = [long_b_stock(symbol=n) for n in ("AAA", "BBB", "CCC")] + \
        [short_stock(symbol=n) for n in ("XXX", "ZZZ")]
positions, notes = run(mixed, ["A", "B", "C"])
check("five signals across the legs, still three positions", len(positions), 3)
check("the cap is not three per rule",
      len(positions) == S.MAX_OPEN_POSITIONS, True)
check("the surplus is refused rather than dropped silently",
      notes["rejected"].get("book full"), 2)

# A signal refused because the book was full does NOT come back later, even
# once a slot frees. This is the live behaviour, not a shortcut: engine.ts calls
# evaluateSymbol first - which marks the setup `spent` the moment it fires - and
# only then asks the book for a slot. So the setup is already spent by the time
# the refusal happens, and the stock has to set itself up again from scratch.
#
# Worth knowing rather than worth changing: on a busy morning the desk does not
# queue up the signals it could not take.
freed = [long_b_stock(symbol=n, premium=premium_falling_through(DAY, 30.0, 26.0, 40))
         for n in ("AAA", "BBB", "CCC")] + \
        [short_stock(symbol=n) for n in ("XXX", "ZZZ")]
positions, notes = run(freed, ["A", "B", "C"])
check("the three longs stop out at 09:40",
      sorted(p.exit_reason for p in positions if p.setup == "B"),
      ["stop", "stop", "stop"])
check("and the shorts refused at 09:26 do not come back afterwards",
      [p for p in positions if p.setup == "C"], [])
check("they were refused, not missed", notes["rejected"].get("book full"), 2)


# ---------------- A and B, one leg at a time ----------------
#
# One stock, one price path, that offers both legs in turn:
#
#   09:15-09:19  1000   holding above the major support, below R1
#   09:20-09:24  1024   crosses R1 from below while above the EMA   -> setup B
#   09:25        1004   back inside 0.4% of the EMA, 2% off that high
#   09:26-       1008   0.4% up off the retracement low              -> setup A
#
# Whichever leg is selected is the trade that comes out, and it is a *different*
# trade: a different minute, a different strike, a different premium. Running
# them one at a time is the only way to see that.

BOTH_PRICES = prices([(15, 19, 1000), (20, 24, 1024), (25, 25, 1004), (26, 59, 1008)])


def both_stock(symbol="BOTHY"):
    return Stock(symbol=symbol, ohlc=OHLC, chain=CHAIN, prices=BOTH_PRICES,
                 seed=1000.0, atm=1020.0, premium=flat_premium(DAY, 30.0))


a_only, _ = run([both_stock()], ["A"])
b_only, _ = run([both_stock()], ["B"])
together, notes = run([both_stock()], ["A", "B"])

check("setup A on its own takes the retrace", [p.setup for p in a_only], ["A"])
check("entering after the pullback", a_only[0].entry_at if a_only else None, minute(9, 26))
check("on the strike at the money then", a_only[0].strike if a_only else None, 1010.0)

check("setup B on its own takes the cross", [p.setup for p in b_only], ["B"])
check("entering on the cross", b_only[0].entry_at if b_only else None, minute(9, 20))
check("on the strike at the money then", b_only[0].strike if b_only else None, 1020.0)

check("the two legs are genuinely different trades",
      (a_only[0].entry_at, a_only[0].strike) != (b_only[0].entry_at, b_only[0].strike)
      if a_only and b_only else None, True)

# Run together, the earlier leg takes the stock and the later one is shut out by
# the one-trade-per-stock-per-day cap - it does not even signal, because
# signals.ts tests `canTrade` before producing one. So **A and B together is not
# A plus B**: adding two separate runs up would double-count a stock that could
# only ever have been traded once.
check("together, only the earlier leg trades the stock", [p.setup for p in together], ["B"])
check("and the later leg does not even signal", dict(notes["bySetup"]), {"B": 1})
check("though each signals when run on its own",
      (dict(run([both_stock()], ["A"])[1]["bySetup"]),
       dict(run([both_stock()], ["B"])[1]["bySetup"])),
      ({"A": 1}, {"B": 1}))


print(f"{passed} passed, {len(failed)} failed")
for f in failed:
    print("  FAIL  " + f)
sys.exit(1 if failed else 0)
