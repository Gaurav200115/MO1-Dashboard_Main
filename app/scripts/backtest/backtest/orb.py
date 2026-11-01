"""The NIFTY 15-minute opening-range breakout. A backtest-only rule.

The live desk does not run this and nothing here is reachable from it: the rule
is defined in `strategies.NIFTY_ORB_15M`, not in registry.ts.

As specified (Gaurav, 2026-11-01), with the four points he settled when asked:

  1. The range is the high and low of NIFTY's 09:15-09:29 minutes.
  2. From 09:30, the first minute that **closes** above the high buys the ATM
     call; the first that closes below the low buys the ATM put. A wick through
     the edge that closes back inside is not a break.
  3. **One trade a day.** Whichever edge breaks first is the day's trade, and
     nothing is taken after it - not the other side, not a re-entry.
  4. The stop and the trail are in **premium points**, not NIFTY points: the
     stop sits 15 under the fill; once the premium has been 15 above the fill
     the stop moves to +5, and every further 5 moves it up another 5 (+20 ->
     +10, +25 -> +15 ...). It never moves down.
  5. Whatever is still open at 13:00 is closed at 13:00, profit or loss.

What it shares with the stock rules, deliberately: the fill is the entry
minute's close (no spread in the archive), the contract is locked onto its
strike at entry and never followed by `strike_offset` again, the stop is tested
on the minute's low before the trail is tested on its high, and a contract that
leaves the downloaded band closes the trade at its last known price.
"""
from collections import defaultdict

from . import db
from .config import ist_time
from .fills import manage_position, session_minutes
from .gate import CLEAR, fill_price
from .position import PREMIUM_FLOOR, Position

CALL, PUT = "CE", "PE"


def _notes():
    return {"signals": 0, "rejected": defaultdict(int), "skipped": defaultdict(int),
            "bySetup": defaultdict(int), "symbols": 0, "incomplete": 0}


def opening_range(bars, start, end):
    """(high, low) of the minutes in [start, end) - or None if any minute is missing.

    A missing minute can be the one that set the high or the low, and a range
    built without it would be narrower than the real one and break earlier. The
    day is skipped instead, and counted.
    """
    window = [b for b in bars if start <= b["at"].time() < end]
    expected = (end.hour * 60 + end.minute) - (start.hour * 60 + start.minute)
    if len(window) < expected:
        return None
    return max(b["high"] for b in window), min(b["low"] for b in window)


def find_break(bars, high, low, after, cutoff):
    """The first minute in [after, cutoff) to close outside the range.

    Returns (bar, "CE") for a close above the high, (bar, "PE") for one below the
    low, or None. A close exactly on the edge has not broken it.
    """
    for bar in bars:
        t = bar["at"].time()
        if t < after:
            continue
        if t >= cutoff:
            break
        if bar["close"] > high:
            return bar, CALL
        if bar["close"] < low:
            return bar, PUT
    return None


def _paise(x):
    return round(x * 100)


def trail_stop(entry, peak, risk):
    """Where the stop sits once the premium has touched `peak`, and on which rung.

    None below the first rung. Worked in whole paise, because 15.00 of gain
    computed in floating point can come out as 14.999999 and miss the rung it
    has plainly reached.
    """
    gain = _paise(peak) - _paise(entry)
    start = _paise(risk["trailStartPoints"])
    if gain < start:
        return None
    rung = (gain - start) // _paise(risk["trailStepPoints"])
    stop = entry + risk["trailLockPoints"] + rung * risk["trailStepPoints"]
    return round(stop, 2), rung


def apply_points_bar(position, bar, risk, at):
    """One minute of the contract against the points stop and trail.

    The stop on the minute's low first, then the trail on its high - so a minute
    that both reaches a new rung and hits the stop is a stop, the conservative
    reading of a bar whose order inside the minute is unknown. The fill is the
    stop itself unless the minute opened through it.
    """
    if bar["low"] <= position.stop:
        trailed = position.stop > position.entry
        return {"action": "exit",
                "price": min(bar["open"], position.stop),
                "reason": "trail-stop" if trailed else "stop"}

    trail = trail_stop(position.entry, bar["high"], risk)
    if trail is not None and trail[0] > position.stop:
        stop, rung = trail
        position.stop = stop
        position.step = rung + 2
        position.target = round(position.entry + risk["trailStartPoints"]
                                + (rung + 1) * risk["trailStepPoints"], 2)
        position.ladder.append({"at": at, "step": position.step, "stop": stop,
                                "target": position.target,
                                "locked": (stop - position.entry) * position.qty})
    return {"action": "hold"}


def open_orb_position(strategy, day, signal_bar, side, opening, expiry, strike,
                      entry_bar, lot_size):
    risk = strategy["risk"]
    entry = fill_price(entry_bar)
    raw_stop = round(entry - risk["stopPoints"], 2)
    capped = raw_stop <= PREMIUM_FLOOR
    high, low = opening
    return Position(
        symbol=strategy["params"]["symbol"],
        setup=strategy["setups"][0],
        trading_date=day.isoformat(),
        strategy_id=strategy["id"],
        strategy_version=strategy["version"],
        option_type=side,
        expiry=expiry,
        strike=strike,
        qty=lot_size * risk["lots"],
        entry=entry,
        entry_at=signal_bar["at"],
        risk_per_unit=risk["stopPoints"],
        risk_capped=capped,
        stop=PREMIUM_FLOOR if capped else raw_stop,
        target=round(entry + risk["trailStartPoints"], 2),
        gate=CLEAR,
        context={
            # The edge that broke, in the fields the Trade Analysis page already
            # reads for a level: ORH / ORL in place of a pivot name.
            "pivot": "ORH" if side == CALL else "ORL",
            "pivotValue": high if side == CALL else low,
            "levelStrike": None,
            "levelKind": "resistance" if side == CALL else "support",
            "skew": None,
            "gapPct": None,
            "spotAtEntry": signal_bar["close"],
            "emaAtEntry": None,
            "retracement": None,
            "openingRange": {"high": high, "low": low},
        },
    )


def replay_session(conn, day, strategy, log=None):
    """Replays one session. Returns (closed_positions, notes) - at most one position."""
    notes = _notes()
    params, risk = strategy["params"], strategy["risk"]
    symbol, setup = params["symbol"], strategy["setups"][0]

    bars = db.spot_bars(conn, day, [symbol]).get(symbol, [])
    if not bars:
        notes["skipped"][f"no {symbol} minute bars"] += 1
        return [], notes
    notes["symbols"] = 1
    if db.index_coverage(conn, day, symbol) < db.INDEX_SERIES_PER_DAY:
        notes["incomplete"] = 1

    range_end = ist_time(params["rangeEndIst"])
    opening = opening_range(bars, ist_time(params["rangeStartIst"]), range_end)
    if opening is None:
        notes["skipped"]["opening range incomplete"] += 1
        return [], notes

    hit = find_break(bars, *opening, range_end, ist_time(params["entryCutoffIst"]))
    if hit is None:
        # Not a data problem: the rule simply had no trade that day.
        notes["skipped"][f"no break before {params['entryCutoffIst']}"] += 1
        return [], notes
    signal_bar, side = hit
    notes["signals"] += 1
    notes["bySetup"][setup] += 1

    # One trade a day means the day is spent on the first break, whether or not
    # it can be priced. Moving on to a later break would trade something the
    # rule did not.
    expiry = db.index_entry_expiry(conn, day, symbol)
    if expiry is None:
        notes["skipped"][f"no {symbol} option data for the day"] += 1
        return [], notes
    by_strike, band = db.option_day(conn, day, symbol, expiry, side)
    picked = db.atm_strike_at(by_strike, band, signal_bar["at"])
    if picked is None:
        notes["skipped"]["no at-the-money strike at the entry minute"] += 1
        return [], notes
    strike, entry_bar = picked
    if not entry_bar["volume"]:
        notes["rejected"]["contract did not trade in the entry minute"] += 1
        return [], notes
    lot_size = db.index_lot_size(conn, day, symbol, expiry)
    if not lot_size:
        notes["skipped"]["no lot size in the F&O bhavcopy"] += 1
        return [], notes

    position = open_orb_position(strategy, day, signal_bar, side, opening, expiry, strike,
                                 entry_bar, lot_size)
    closed = manage_position(position, by_strike, band, session_minutes(band),
                             ist_time(params["flattenIst"]), risk, apply=apply_points_bar)
    if log:
        log(f"{day}  {symbol} {side} {strike:g} {closed.exit_reason} {closed.profit:+,.0f}")
    return [closed], notes
