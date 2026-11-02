"""The NIFTY 15-minute opening-range rule: the range, the break, the points
trail, one trade a day, and the 13:00 flatten.

The archive is stood in for by replacing the handful of `db` reads the rule
makes, so each case is a whole session replayed through `orb.replay_session`
rather than the pieces checked one by one.

    py -3.12 tests/test_orb.py
"""
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backtest import db, orb
from backtest.runner import replay_session
from backtest.strategies import NIFTY_ORB_15M, SETUPS, STRATEGIES, selection

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
DAY = dt.date(2026, 10, 15)
EXPIRY = dt.date(2026, 10, 20)
ATM, NEXT = 25000.0, 25050.0
LOT = 65
RISK = NIFTY_ORB_15M["risk"]

passed, failed = 0, []


def check(name, got, want):
    global passed
    if got == want:
        passed += 1
    else:
        failed.append(f"{name}\n      got  {got}\n      want {want}")


def minute(h, m):
    return dt.datetime.combine(DAY, dt.time(h, m), tzinfo=IST)


def session_minutes():
    t, out = minute(9, 15), []
    while t <= minute(15, 29):
        out.append(t)
        t += dt.timedelta(minutes=1)
    return out


MINUTES = session_minutes()


def spot(closes=None, drop=()):
    """NIFTY minute bars. The 09:15-09:29 range is 24960-25040 unless overridden;
    `closes` sets {minute: close} after that (high/low follow the close)."""
    closes = closes or {}
    out = []
    for m in MINUTES:
        if m in drop:
            continue
        if m < minute(9, 30):
            hi = 25040.0 if m == minute(9, 20) else 25010.0
            lo = 24960.0 if m == minute(9, 25) else 24990.0
            out.append({"at": m, "open": 25000.0, "high": hi, "low": lo, "close": 25000.0,
                        "volume": 0})
        else:
            c = closes.get(m, 25000.0)
            out.append({"at": m, "open": c, "high": c, "low": c, "close": c, "volume": 0})
    return out


def premium(path, side):
    """option_day's answer: the ATM strike follows `path` {minute: (o, h, l, c)},
    holding its last price between entries; the next strike up trades 30 lower,
    so a position that wandered onto it would show a different P&L."""
    by_strike = {ATM: {}, NEXT: {}}
    last = (100.0, 100.0, 100.0, 100.0)
    for m in MINUTES:
        last = path.get(m, (last[3],) * 4)
        o, h, l, c = last
        for strike, shift, offset in ((ATM, 0.0, 0), (NEXT, -30.0, 1)):
            by_strike[strike][m] = {"at": m, "strike": strike, "offset": offset,
                                    "open": o + shift, "high": h + shift, "low": l + shift,
                                    "close": c + shift, "volume": 650, "spot": 25000.0}
    band = {m: (24750.0, 25250.0) for m in MINUTES}
    return by_strike, band


def replay(closes=None, path=None, drop=(), lot=LOT, coverage=22):
    """One session through the real entry point, the archive replaced underneath it."""
    seen = {}

    def option_day(conn, day, symbol, expiry, side):
        seen["side"] = side
        return premium(path or {}, side)

    db.spot_bars = lambda conn, day, symbols: {"NIFTY": spot(closes, drop)}
    db.index_coverage = lambda conn, day, symbol: coverage
    db.index_entry_expiry = lambda conn, day, symbol: EXPIRY
    db.option_day = option_day
    db.index_lot_size = lambda conn, day, symbol, expiry: lot
    positions, notes = replay_session(None, DAY, [NIFTY_ORB_15M], floors={})
    return positions, notes, seen


# ---------------- the range and the break ----------------

bars = spot()
check("the range is the 09:15-09:29 high and low",
      orb.opening_range(bars, dt.time(9, 15), dt.time(9, 30)), (25040.0, 24960.0))
check("a missing minute in the range voids it",
      orb.opening_range(spot(drop={minute(9, 22)}), dt.time(9, 15), dt.time(9, 30)), None)

wick = spot()
for b in wick:
    if b["at"] == minute(9, 40):
        b["high"] = 25080.0          # trades through the high, closes back inside
check("a wick through the high that closes inside is not a break",
      orb.find_break(wick, 25040.0, 24960.0, dt.time(9, 30), dt.time(13, 0)), None)
check("a close exactly on the high is not a break",
      orb.find_break(spot({minute(9, 40): 25040.0}), 25040.0, 24960.0,
                     dt.time(9, 30), dt.time(13, 0)), None)
hit = orb.find_break(spot({minute(9, 40): 25041.0}), 25040.0, 24960.0,
                     dt.time(9, 30), dt.time(13, 0))
check("a close above the high buys the call", (hit[0]["at"], hit[1]), (minute(9, 40), "CE"))
hit = orb.find_break(spot({minute(10, 5): 24950.0}), 25040.0, 24960.0,
                     dt.time(9, 30), dt.time(13, 0))
check("a close below the low buys the put", (hit[0]["at"], hit[1]), (minute(10, 5), "PE"))
check("a break at 13:00 or later is not taken",
      orb.find_break(spot({minute(13, 0): 25100.0}), 25040.0, 24960.0,
                     dt.time(9, 30), dt.time(13, 0)), None)
check("the range minutes themselves cannot break it",
      orb.find_break(spot(), 25005.0, 24995.0, dt.time(9, 30), dt.time(13, 0)), None)


# ---------------- the trail, in premium points ----------------

check("below +15 the stop does not move", orb.trail_stop(100.0, 114.95, RISK), None)
check("+15 moves the stop to +5", orb.trail_stop(100.0, 115.0, RISK), (105.0, 0))
check("+19.95 is still the first rung", orb.trail_stop(100.0, 119.95, RISK), (105.0, 0))
check("+20 moves it to +10", orb.trail_stop(100.0, 120.0, RISK), (110.0, 1))
check("+27 moves it to +15", orb.trail_stop(100.0, 127.0, RISK), (115.0, 2))
check("a gain that floating point puts at 14.999... still reaches the rung",
      orb.trail_stop(120.35, 135.35, RISK), (125.35, 0))


# ---------------- whole sessions ----------------

UP = {minute(9, 40): 25050.0}         # the high breaks at 09:40, the call is bought

p, notes, seen = replay(UP, {minute(9, 40): (100, 100, 100, 100),
                             minute(9, 41): (100, 100, 84, 84)})
check("the first break is the day's one trade", len(p), 1)
check("a high break buys the call", seen["side"], "CE")
p = p[0]
check("on the at-the-money strike, not its neighbour", p.strike, ATM)
check("filled at the entry minute's close", p.entry, 100.0)
check("the lot size comes from the bhavcopy", p.qty, 65)
check("stopped 15 points under the fill", (p.exit_reason, p.exit_price), ("stop", 85.0))
check("losing 15 points a unit", round(p.profit), -15 * 65)

p, _, _ = replay(UP, {minute(9, 40): (100, 100, 100, 100),
                      minute(9, 41): (80, 82, 78, 79)})
check("a minute that opens through the stop fills at the open", p[0].exit_price, 80.0)

p, _, _ = replay(UP, {minute(9, 40): (100, 100, 100, 100),
                      minute(9, 41): (100, 116, 101, 112),
                      minute(9, 50): (112, 112, 104, 104)})
p = p[0]
check("after +15 a fall to +5 exits there", (p.exit_reason, p.exit_price), ("trail-stop", 105.0))
check("banking 5 points", round(p.profit), 5 * 65)
check("the move is on the ladder", [(s["stop"], s["locked"]) for s in p.ladder], [(105.0, 325.0)])

p, _, _ = replay(UP, {minute(9, 40): (100, 100, 100, 100),
                      minute(9, 41): (100, 116, 101, 115),
                      minute(9, 45): (115, 121, 114, 120),
                      minute(9, 50): (120, 127.5, 119, 126),
                      minute(10, 0): (126, 126, 110, 110)})
p = p[0]
check("each +5 lifts the stop 5: +27.5 leaves it at +15",
      (p.exit_reason, p.exit_price), ("trail-stop", 115.0))
check("one ladder entry per move", [s["stop"] for s in p.ladder], [105.0, 110.0, 115.0])

p, _, _ = replay(UP, {minute(9, 40): (100, 100, 100, 100),
                      minute(9, 41): (100, 116, 84, 90)})
check("a minute that reaches +15 and the stop is a stop", p[0].exit_reason, "stop")

p, _, _ = replay(UP, {minute(9, 40): (100, 100, 100, 100),
                      minute(12, 59): (100, 108, 99, 107),
                      minute(13, 0): (107, 109, 106, 108)})
p = p[0]
check("still open at 13:00 is flattened", p.exit_reason, "eod-flatten")
check("at the last price before 13:00", (p.exit_price, p.exit_at), (107.0, minute(12, 59)))

# Breaks the high, is stopped, then breaks the low: still one trade.
p, notes, seen = replay({minute(9, 40): 25050.0, minute(11, 0): 24900.0},
                        {minute(9, 40): (100, 100, 100, 100),
                         minute(9, 41): (100, 100, 84, 84)})
check("one trade a day, even after a stop and a break the other way", len(p), 1)
check("and it was the first break", p[0].option_type, "CE")
check("one signal counted", notes["signals"], 1)

p, notes, seen = replay({minute(10, 5): 24950.0}, {minute(10, 5): (100, 100, 100, 100)})
check("a low break buys the put", (seen["side"], p[0].option_type), ("PE", "PE"))

p, notes, _ = replay({}, {})
check("no break, no trade", (len(p), dict(notes["skipped"])),
      (0, {"no break before 13:00": 1}))

p, notes, _ = replay(UP, {}, drop={minute(9, 20)})
check("an incomplete range is skipped, not guessed",
      (len(p), dict(notes["skipped"])), (0, {"opening range incomplete": 1}))

p, notes, _ = replay(UP, {minute(9, 40): (100, 100, 100, 100)}, coverage=10)
check("a day with option series missing is counted", notes["incomplete"], 1)


# ---------------- kept apart from the desk's rules ----------------

check("ORB runs on its own", selection(["ORB"])[0], ["nifty-orb-15m"])
try:
    selection(["A", "ORB"])
    check("ORB refuses to be mixed with the stock legs", "accepted", "refused")
except SystemExit:
    check("ORB refuses to be mixed with the stock legs", "refused", "refused")
check("it is marked backtest-only", STRATEGIES["nifty-orb-15m"].get("backtestOnly"), True)
check("the setup lists both options", SETUPS["ORB"]["option"], "CE/PE")

print(f"{passed} passed, {len(failed)} failed")
for f in failed:
    print("  FAIL  " + f)
sys.exit(1 if failed else 0)
