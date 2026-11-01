"""The entry rules, as a state machine per stock.

Ported line for line from app/src/lib/strategy/signals.ts and ema.ts.

A machine rather than a predicate because both legs of the rule are about
*sequence*, not about a condition being true right now. "Below the level, then
crosses it, then retraces" cannot be answered from a single tick - price sitting
above a level says nothing about whether it ever crossed from below, and the
difference between those two is the whole setup.

The replay feeds this one 1-minute close at a time, where the live engine feeds
it a tick. That difference is a stated limit of the backtest, not a change to
the rule: the machine itself is identical.
"""
import math
from dataclasses import dataclass, field

from .levels import cross_candidates


class Ema:
    """ema.ts Ema: an SMA of the first `period` closes, then a standard EMA."""

    def __init__(self, period):
        if not isinstance(period, int) or period < 2:
            raise ValueError(f"EMA period must be an integer >= 2, got {period}")
        self.period = period
        self.k = 2 / (period + 1)
        self.value = None
        self._seed = []

    def push(self, close):
        if not (isinstance(close, (int, float)) and math.isfinite(close) and close > 0):
            return self.value
        if self.value is None:
            self._seed.append(close)
            if len(self._seed) < self.period:
                return None
            self.value = sum(self._seed) / len(self._seed)
            return self.value
        self.value = close * self.k + self.value * (1 - self.k)
        return self.value

    def seed_from(self, closes):
        for close in closes:
            self.push(close)
        return self.value


def ema_gap_pct(price, ema):
    return abs(price - ema) / ema * 100


def near_ema(price, ema, proximity_pct):
    if not (math.isfinite(price) and price > 0 and math.isfinite(ema) and ema > 0):
        return False
    return ema_gap_pct(price, ema) <= proximity_pct


@dataclass
class Signal:
    setup: str
    symbol: str
    spot: float
    ema: float
    level: object             # the ConfirmedLevel broken (A, C) or crossed (B)
    basis: object             # setup B: the major support held above. None otherwise.
    retracement: dict | None  # setups A and C: the pullback entered off. None for B.
    crossed_at: object
    at: object


@dataclass
class SymbolState:
    symbol: str
    # Setup A - break the major resistance, then pull back to the EMA.
    phase_a: str = "idle"
    crossed_at: object = None
    high_since_cross: float = 0.0
    zone_low: float | None = None
    zone_at: object = None
    # Setup B - holding above the major support, crossing some other level.
    phase_b: str = "idle"
    below: dict = field(default_factory=dict)
    # Setup C - the short. Mirror of A.
    phase_c: str = "idle"
    broke_at: object = None
    low_since_break: float = 0.0
    zone_high: float | None = None
    zone_high_at: object = None

    last_ltp: float | None = None
    trades_today: int = 0
    note: str | None = None


def initial_state(plan):
    """Seeded from the previous session's official close rather than the first tick.

    This is deliberate and it changes what the rule does. A stock that closed
    below its major resistance and gaps open above it has crossed that level -
    the cross happened in the auction - and seeding from the first tick would
    class it as "was never below" and sit out the entire move. Seeding from the
    close treats the gap as the break it is.
    """
    below = {lv.pivot: plan.close < lv.pivot_value for lv in plan.marked}
    resistance, support = plan.major_resistance, plan.major_support
    return SymbolState(
        symbol=plan.symbol,
        phase_a=("below" if plan.close < resistance.pivot_value else "idle") if resistance else "idle",
        phase_c=("above" if plan.close > support.pivot_value else "idle") if support else "idle",
        phase_b="watching" if support else "idle",
        below=below,
    )


def _retraced(state, ltp, params):
    """Did price actually come back down to the EMA, as opposed to the EMA rising to
    meet a price that never moved? Measured against the high since the break."""
    if state.high_since_cross <= 0:
        return False
    pullback = (state.high_since_cross - ltp) / state.high_since_cross * 100
    return pullback >= params["entryReboundPct"]


def _rallied(state, ltp, params):
    """The short's mirror of _retraced."""
    if state.low_since_break <= 0:
        return False
    rally = (ltp - state.low_since_break) / state.low_since_break * 100
    return rally >= params["entryReboundPct"]


def _can_trade(state, params):
    return state.trades_today < params["maxTradesPerSymbolPerDay"]


def evaluate_symbol(plan, state, params, ltp, ema, last_bar_close, at, entries_open, setups):
    """Advances one stock's state by one tick and returns a Signal if one fired.

    Level tracking runs even when entries are closed or the EMA is still
    warming. Skipping it would leave the machine in the wrong phase the moment
    it *is* allowed to trade - a break that happened during warm-up is still a
    break.
    """
    if not (isinstance(ltp, (int, float)) and math.isfinite(ltp) and ltp > 0):
        return None

    state.last_ltp = ltp
    state.note = None

    # --- Setup A: break the major resistance, then retrace to the EMA ---------
    resistance = plan.major_resistance
    if "A" in setups and resistance and state.phase_a != "spent":
        level = resistance.pivot_value

        if state.phase_a == "idle" and ltp < level:
            # Price came back under the level, so a fresh break is now observable.
            state.phase_a = "below"
        elif state.phase_a == "below" and ltp > level:
            state.phase_a = "crossed"
            state.crossed_at = at
            state.high_since_cross = ltp
        elif state.phase_a in ("crossed", "retraced"):
            state.high_since_cross = max(state.high_since_cross, ltp)

            # A closed bar decisively under the EMA ends the setup rather than
            # arming it. The rule wants a pullback the EMA holds; price closing
            # through it is the pullback failing, and re-requiring a fresh break
            # is what stops one dead break from arming all afternoon.
            broke = (ema is not None and last_bar_close is not None
                     and last_bar_close < ema * (1 - params["emaZonePct"] / 100))

            if broke:
                state.phase_a = "below" if ltp < level else "idle"
                state.crossed_at = None
                state.high_since_cross = 0.0
                state.zone_low = None
                state.zone_at = None
            elif ema is None:
                state.note = "EMA warming"
            else:
                # Two separate events, in order. Reaching the zone is the setup;
                # turning back up off the low of it is the trigger.
                if state.phase_a == "crossed":
                    if not near_ema(ltp, ema, params["emaZonePct"]):
                        state.note = "waiting for retrace"
                    elif not _retraced(state, ltp, params):
                        # Price at the EMA is not the same event as price having
                        # come back to it. If a break stalls and goes sideways
                        # the EMA rises into the price and the zone test starts
                        # passing without any retrace having happened.
                        state.note = "EMA caught up, no pullback"
                    else:
                        state.phase_a = "retraced"
                        state.zone_low = ltp
                        state.zone_at = at

                if state.phase_a == "retraced" and state.zone_low is not None:
                    # The pullback may deepen after it first reaches the zone;
                    # the rebound is always measured from the lowest point it
                    # actually reached.
                    if ltp < state.zone_low:
                        state.zone_low = ltp

                    low = state.zone_low
                    trigger = low * (1 + params["entryReboundPct"] / 100)

                    if ltp < trigger:
                        state.note = f"retraced to {low:.2f}, needs {show_trigger(trigger, 'up')}"
                    elif ltp <= ema:
                        # The zone is two-sided so a wick through the EMA still
                        # counts as reaching it, which means a rebound can
                        # trigger from below the line. Requiring the entry
                        # itself to be above the EMA keeps a long from being
                        # opened while price is still under it.
                        state.note = "rebounded but still under the EMA"
                    elif entries_open and _can_trade(state, params):
                        state.phase_a = "spent"
                        return Signal(
                            setup="A", symbol=plan.symbol, spot=ltp, ema=ema,
                            level=resistance, basis=None,
                            retracement={"extreme": low,
                                         "emaGapPct": abs(low - ema) / ema * 100,
                                         "at": state.zone_at if state.zone_at is not None else at,
                                         "turnPct": (ltp - low) / low * 100},
                            crossed_at=state.crossed_at, at=at)

    # --- Setup B: hold above the major support, cross another marked level ----
    support = plan.major_support
    fired = None

    if "B" in setups and support and state.phase_b == "watching":
        holding = ltp > support.pivot_value

        for level in cross_candidates(plan):
            was_below = state.below.get(level.pivot, plan.close < level.pivot_value)

            if (fired is None and holding and was_below and ltp > level.pivot_value
                    and ema is not None and ltp > ema
                    and entries_open and _can_trade(state, params)):
                fired = Signal(setup="B", symbol=plan.symbol, spot=ltp, ema=ema,
                               level=level, basis=support, retracement=None,
                               crossed_at=at, at=at)

            state.below[level.pivot] = ltp < level.pivot_value

        if fired is not None:
            state.phase_b = "spent"
        elif not holding:
            state.note = state.note if state.note is not None else "below major support"

    # Keep the ladder's own memory current even when setup B is spent, so a
    # later strategy reading this state is not looking at a snapshot frozen at
    # entry.
    if fired is None and state.phase_b != "watching":
        for level in plan.marked:
            state.below[level.pivot] = ltp < level.pivot_value

    # --- Setup C: break the major support, rally to the EMA, roll over --------
    #
    # The mirror image of setup A, and deliberately written as one rather than
    # folded into it with sign flips. Every comparison reverses - a break is
    # downward, the pullback is a rally, the confirmation is a drop, and the
    # invalidation is a close back *above* the EMA - and the version of this
    # with a `direction` multiplier scattered through it is the version where
    # one missed flip silently shorts a stock that is going up.
    short_basis = plan.major_support
    if fired is None and "C" in setups and short_basis and state.phase_c != "spent":
        level = short_basis.pivot_value

        if state.phase_c == "idle" and ltp > level:
            state.phase_c = "above"
        elif state.phase_c == "above" and ltp < level:
            state.phase_c = "broken"
            state.broke_at = at
            state.low_since_break = ltp
        elif state.phase_c in ("broken", "retraced"):
            state.low_since_break = min(state.low_since_break, ltp)

            # A bar closing back above the EMA is the breakdown failing.
            reclaimed = (ema is not None and last_bar_close is not None
                         and last_bar_close > ema * (1 + params["emaZonePct"] / 100))

            if reclaimed:
                state.phase_c = "above" if ltp > level else "idle"
                state.broke_at = None
                state.low_since_break = 0.0
                state.zone_high = None
                state.zone_high_at = None
            elif ema is None:
                state.note = "EMA warming"
            else:
                if state.phase_c == "broken":
                    if not near_ema(ltp, ema, params["emaZonePct"]):
                        state.note = "waiting for retrace"
                    elif not _rallied(state, ltp, params):
                        state.note = "EMA came down, no rally"
                    else:
                        state.phase_c = "retraced"
                        state.zone_high = ltp
                        state.zone_high_at = at

                if state.phase_c == "retraced" and state.zone_high is not None:
                    if ltp > state.zone_high:
                        state.zone_high = ltp

                    high = state.zone_high
                    trigger = high * (1 - params["entryReboundPct"] / 100)

                    if ltp > trigger:
                        state.note = f"retraced to {high:.2f}, needs {show_trigger(trigger, 'down')}"
                    elif ltp >= ema:
                        state.note = "rolled over but still above the EMA"
                    elif entries_open and _can_trade(state, params):
                        state.phase_c = "spent"
                        return Signal(
                            setup="C", symbol=plan.symbol, spot=ltp, ema=ema,
                            level=short_basis, basis=None,
                            retracement={"extreme": high,
                                         "emaGapPct": abs(high - ema) / ema * 100,
                                         "at": state.zone_high_at if state.zone_high_at is not None else at,
                                         "turnPct": (high - ltp) / high * 100},
                            crossed_at=state.broke_at, at=at)

    return fired


def show_trigger(price, towards):
    """Renders a trigger price so the number shown would actually fire.

    Rounding to the nearest paise is wrong in one direction: a long needing
    1206.909 displayed as 1206.91 is fine, but a short needing 1193.109 shown as
    1193.11 names a price a paise *above* the threshold, which would not
    trigger. Round away from the level in each case instead.
    """
    rounded = (math.ceil(price * 100) / 100 if towards == "up"
               else math.floor(price * 100) / 100)
    return f"{rounded:.2f}"
