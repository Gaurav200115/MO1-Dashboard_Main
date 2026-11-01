"""Running a position minute by minute: stops, the ladder, the flatten, and the
edge of the archive.

Synthetic minute data, because the cases that matter are the awkward ones - a
minute that gaps through the stop, a contract that stops appearing, a contract
that stops appearing *because it left the downloaded band*. Those three look
alike in a query and mean entirely different things.

    py -3.12 tests/test_fills.py
"""
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backtest import strategies as S
from backtest.fills import manage_position, minute_band_state, session_minutes
from backtest.position import Position, size_trade

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
RISK = S.SHARED_RISK
DAY = dt.date(2026, 10, 15)
FLATTEN = dt.time(15, 15)

passed, failed = 0, []


def check(name, got, want):
    global passed
    if got == want:
        passed += 1
    else:
        failed.append(f"{name}\n      got  {got}\n      want {want}")


def minute(h, m):
    return dt.datetime.combine(DAY, dt.time(h, m), tzinfo=IST)


def bar(at, o, h, l, c, volume=1000):
    return {"at": at, "open": o, "high": h, "low": l, "close": c,
            "volume": volume, "spot": 1000.0, "offset": 0, "strike": 1000.0}


def position_at(entry=100.0, lot=250, at=None):
    sz = size_trade(entry, lot, RISK)
    return Position(
        symbol="TEST", setup="A", trading_date=DAY.isoformat(),
        strategy_id="breakout-retrace-21ema", strategy_version=7,
        option_type="CE", expiry=dt.date(2026, 10, 28), strike=1000.0,
        qty=sz.qty, entry=entry, entry_at=at or minute(10, 0),
        risk_per_unit=sz.risk_per_unit, risk_capped=sz.risk_capped,
        stop=sz.stop, target=sz.target)


def run(bars_by_minute, band=None, strike=1000.0):
    """bars_by_minute: {minute: bar or None}. None = the contract did not print."""
    pos = position_at()
    by_strike = {strike: {m: b for m, b in bars_by_minute.items() if b is not None}}
    if band is None:
        band = {m: (900.0, 1100.0) for m in bars_by_minute}
    return manage_position(pos, by_strike, band, session_minutes(band), FLATTEN, RISK)


# Entry 100.00, lot 250, R = 2.20 -> stop 97.80, first target 104.40.

# ---------------- the stop ----------------

p = run({minute(10, 1): bar(minute(10, 1), 100.0, 100.5, 97.5, 98.0)})
check("stopped out on the minute's low", p.exit_reason, "stop")
check("filled at the stop", round(p.exit_price, 2), 97.80)
check("and loses one R", round(p.profit), -550)

# A minute that opens below the stop never traded at the stop.
p = run({minute(10, 1): bar(minute(10, 1), 95.0, 96.0, 94.0, 95.5)})
check("a gap through the stop fills at the open", round(p.exit_price, 2), 95.00)
check("which loses more than one R", round(p.profit), -1250)

# ---------------- the ladder ----------------

p = run({
    minute(10, 1): bar(minute(10, 1), 100.0, 104.5, 99.5, 104.4),   # 1:2 touched
    minute(10, 2): bar(minute(10, 2), 104.4, 106.7, 104.0, 106.6),  # 1:3 touched -> stop to +1R
    minute(10, 3): bar(minute(10, 3), 106.6, 106.8, 102.0, 102.1),  # back through +1R
})
check("a trade stopped above its entry is a trail-stop", p.exit_reason, "trail-stop")
check("locked in one R", round(p.profit), 550)
check("after reaching rung 3", p.step, 3)

# The stop is tested before the ladder on the same minute.
p = run({minute(10, 1): bar(minute(10, 1), 100.0, 110.0, 97.0, 98.0)})
check("a minute that both clears a rung and stops out is a stop", p.exit_reason, "stop")

# ---------------- the flatten ----------------

p = run({
    minute(14, 0): bar(minute(14, 0), 100.0, 101.0, 99.5, 100.9),
    minute(15, 14): bar(minute(15, 14), 101.0, 101.5, 100.5, 101.2),
    minute(15, 15): bar(minute(15, 15), 101.2, 101.4, 101.0, 101.3),
})
check("flattened at 15:15", p.exit_reason, "eod-flatten")
check("at the last price before it", round(p.exit_price, 2), 101.20)
check("15:15 itself is not traded through", p.exit_at, minute(15, 14))

# ---------------- the edge of the archive ----------------

check("inside the strikes present", minute_band_state({minute(10, 1): (900.0, 1100.0)},
                                                      minute(10, 1), 1000.0), "inside")
check("outside them", minute_band_state({minute(10, 1): (1010.0, 1100.0)},
                                        minute(10, 1), 1000.0), "outside")
check("no rows at all that minute", minute_band_state({}, minute(10, 1), 1000.0), "absent")

# The contract stops printing but is still inside the band: it simply did not
# trade. Carry the last price and hold.
p = run({
    minute(10, 1): bar(minute(10, 1), 100.0, 101.0, 99.5, 100.8),
    minute(10, 2): None,
    minute(10, 3): None,
    minute(10, 4): bar(minute(10, 4), 100.8, 101.2, 100.0, 101.0),
})
check("a quiet contract is held, not closed", p.exit_reason, "eod-flatten")
check("and runs to the end of the data", p.exit_at, minute(10, 4))

# The stock has run and our strike has left the downloaded ATM+-3 band.
band = {minute(10, 1): (900.0, 1100.0),
        minute(10, 2): (1010.0, 1200.0),       # 1000 is no longer in it
        minute(10, 3): (1010.0, 1200.0)}
p = run({minute(10, 1): bar(minute(10, 1), 100.0, 103.0, 99.5, 102.5),
         minute(10, 2): None, minute(10, 3): None}, band=band)
check("a contract that leaves the band closes the trade", p.exit_reason, "out-of-band")
check("at its last known price", round(p.exit_price, 2), 102.50)
check("banked as a real profit", round(p.profit), 625)
check("timed at the last price it had", p.exit_at, minute(10, 1))

# A stop reached before the band is left is still a stop.
band = {minute(10, 1): (900.0, 1100.0), minute(10, 2): (1010.0, 1200.0)}
p = run({minute(10, 1): bar(minute(10, 1), 100.0, 100.2, 97.0, 97.5),
         minute(10, 2): None}, band=band)
check("the rule exits before the archive does", p.exit_reason, "stop")

# ---------------- cheap premiums ----------------
# 550 of risk on a 100-unit lot is 5.50 per unit, which a premium of 4 cannot
# absorb. The trade is taken and risks the whole premium instead.

sz = size_trade(4.0, 100, RISK)
pos = Position(symbol="T", setup="A", trading_date=DAY.isoformat(),
               strategy_id="x", strategy_version=1, option_type="CE",
               expiry=DAY, strike=1000.0, qty=sz.qty, entry=4.0,
               entry_at=minute(10, 0), risk_per_unit=sz.risk_per_unit,
               risk_capped=sz.risk_capped, stop=sz.stop, target=sz.target)
band = {minute(10, 1): (900.0, 1100.0)}
p = manage_position(pos, {1000.0: {minute(10, 1): bar(minute(10, 1), 4.0, 4.1, 0.05, 0.1)}},
                    band, session_minutes(band), FLATTEN, RISK)
check("a risk-capped trade stops at the premium floor", round(p.exit_price, 2), 0.05)
check("losing less than the budgeted R", round(p.profit), -395)

print(f"{passed} passed, {len(failed)} failed")
for f in failed:
    print("  FAIL  " + f)
sys.exit(1 if failed else 0)
