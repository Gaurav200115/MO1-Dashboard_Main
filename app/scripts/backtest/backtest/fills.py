"""Choosing the contract, and running a position minute by minute to its exit.

Two things here decide whether a backtest number means anything.

**The contract is locked at entry.** `atm_strike_at` reads `strike_offset` once,
at the entry minute, to find the at-the-money strike. From then on the position
is followed by `strike_paise` and the offset is never read again. Following the
offset instead would hand back a price series that jumps from one contract to
another every time spot crosses a strike boundary - and every number in it would
look perfectly reasonable.

**A contract that leaves the band closes the trade.** Only ATM+-3 was downloaded
each minute, so a position that runs far enough simply stops being in the data.
That silence is told from "did not trade this minute" by reading the band out of
the data itself - the lowest and highest strike actually present for that symbol,
expiry and minute. Inside the band, carry the last price and hold. Outside it,
close the trade at its last known price and record the exit as `out-of-band`.
"""
from .position import apply_bar, close_position


def minute_band_state(band, minute, strike):
    """Where our strike sits relative to the strikes present that minute.

    "absent"   no rows at all for this symbol and expiry that minute - a gap in
               the download or a market-wide pause, not a statement about us
    "inside"   our strike is within the strikes present: it simply did not trade
    "outside"  our strike has left the downloaded band
    """
    present = band.get(minute)
    if present is None:
        return "absent"
    low, high = present
    return "inside" if low <= strike <= high else "outside"


def step_position(position, by_strike, band, minute, flatten_at, risk):
    """Advances one open position by a single minute. Returns it if it closed.

    One minute at a time rather than straight to the exit, because the desk's
    3-position cap is shared across every running strategy: a signal at 11:04
    can only be taken if something has closed by 11:04. Running each position to
    completion the moment it opens would decide that cap against a book that
    does not exist yet, and quietly take trades the live desk could not have.
    """
    if minute <= position.entry_at:
        return None

    if minute.time() >= flatten_at:
        return close_position(position, position.last_price, position.last_at, "eod-flatten")

    bar = by_strike.get(position.strike, {}).get(minute)
    if bar is None:
        if minute_band_state(band, minute, position.strike) == "outside":
            # The strike we hold has drifted out of the downloaded band. The
            # trade is closed here at its last known price and banked as a
            # completed trade - not discarded, and not guessed at.
            return close_position(position, position.last_price, position.last_at, "out-of-band")
        # "inside" or "absent": no new print, so nothing the rule reacts to.
        return None

    position.last_price, position.last_at = bar["close"], minute

    verdict = apply_bar(position, bar, risk, minute)
    if verdict["action"] == "exit":
        return close_position(position, verdict["price"], minute, verdict["reason"])
    return None


def manage_position(position, by_strike, band, minutes, flatten_at, risk):
    """Runs one position to its exit. The single-position case of `step_position`.

    A position always closes: on its stop, its trailing stop, the edge of the
    archive, or the flatten.
    """
    for minute in minutes:
        closed = step_position(position, by_strike, band, minute, flatten_at, risk)
        if closed is not None:
            return closed

    # The session ran out before the flatten time - the last bar of the day is
    # the last price available.
    return close_position(position, position.last_price, position.last_at, "eod-flatten")


def session_minutes(band):
    """Every minute the archive has any option row for, in order."""
    return sorted(band)
