"""The stop at the pullback - backtest only, for setups A-PB and C-PB.

The desk stops every trade a fixed 550 rupees of premium under the fill. That
measures as a 0.19% move in the stock at the median, about the size of the
0.075 ADR turn the entry waits for - so the stop sits inside the wiggle the
setup has just come out of. This variant puts the stop where the setup is proven
wrong instead: the stock coming back to the pullback's low (A) or the rally's
high (C). Defined with Gaurav on 2026-11-15:

  extreme  the lowest 1-minute *low* (A) or highest *high* (C) from the minute
           the pullback reached the EMA zone to the entry minute. The state
           machine measures the pullback on 1-minute closes; the stop uses the
           bars' own lows and highs, because live watches ticks and a tick low
           is what the stock really touched.
  R        distance from the entry spot to the extreme x an assumed ATM delta
           of 0.5 x the lot quantity - the rupees one lot loses if the stock
           goes back there. Raised to 550 when it comes out smaller, with the
           stop moved out to match; a trade whose R is over 800 is not taken.
  stop     a 1-minute stock bar touching that level ends the trade, filled at
           the option's *low* for that minute: the moment inside the minute is
           unknown, so the worst price in it is taken.
  backstop a premium stop 1.5R under the fill, standing in for the exchange SL
           live would rest in case the desk itself is down.

The stock stop guards only the opening rung. Once the 1:2 ladder has moved the
stop to +1R the trade is managed on premium like every other, and the ladder
steps in this trade's own R.
"""
from dataclasses import dataclass

from .position import PREMIUM_FLOOR, apply_bar


@dataclass
class PullbackStop:
    side: str            # "LONG" - a bought call (A) - or "SHORT" - a bought put (C)
    spot: float          # the stock at entry
    extreme: float       # pullback low (A) / rally high (C), from bar lows / highs
    distance: float      # stock points from the entry spot to the extreme
    raw_rupees: float    # distance x delta x qty: what the extreme costs at 1 lot
    rupees: float        # R as used: raw, raised to the floor
    floored: bool
    level: float         # the stock price that ends the trade
    backstop: float | None = None  # premium; set once the fill is known

    def record(self):
        """What a trade stores, so a result can be read back against its stop."""
        return {"side": self.side, "spot": self.spot, "extreme": self.extreme,
                "distance": self.distance, "rawRupees": self.raw_rupees,
                "rupees": self.rupees, "floored": self.floored, "level": self.level,
                "backstop": self.backstop}


def applies(strategy, signal):
    """A/C under this variant: a retracement to put the stop under. B has none."""
    return strategy["risk"].get("stopBasis") == "pullback" and signal.retracement is not None


def true_extreme(side, bars, since, until, fallback):
    """The real low (long) or high (short) of the pullback, from 1-minute bars.

    `bars` is {minute: bar} for the stock. Falls back to the state machine's
    close-based extreme when no bar in the window is usable - never further in.
    """
    window = [b for t, b in bars.items() if since <= t <= until]
    if not window:
        return fallback
    if side == "LONG":
        return min(fallback, min(b["low"] for b in window))
    return max(fallback, max(b["high"] for b in window))


def plan_stop(side, spot, extreme, qty, risk):
    """Sizes R from the pullback and places the stock stop. Returns a PullbackStop."""
    delta = risk["assumedDelta"]
    distance = (spot - extreme) if side == "LONG" else (extreme - spot)
    distance = max(distance, 0.0)
    raw = distance * delta * qty
    floored = raw < risk["minRiskRupees"]
    rupees = risk["minRiskRupees"] if floored else raw
    reach = rupees / (delta * qty)
    level = spot - reach if side == "LONG" else spot + reach
    return PullbackStop(side=side, spot=spot, extreme=extreme, distance=distance,
                        raw_rupees=raw, rupees=rupees, floored=floored, level=level)


def over_cap(stop, risk):
    return stop.rupees > risk["maxRiskRupees"]


def stock_crossed(stop, bar):
    """Did this 1-minute stock bar touch the stop?"""
    if stop.side == "LONG":
        return bar["low"] <= stop.level
    return bar["high"] >= stop.level


def watch_stock(position, bar, minute):
    """Marks the stop as hit when the stock touches it, while the opening rung holds.

    Kept apart from the option's minute because the two do not always print
    together: a stock that crosses on a minute the option did not trade still
    ends the trade, on the option's next print.
    """
    stop = position.stock_stop
    if (stop is None or position.step != 1 or position.stock_stop_hit is not None
            or bar is None or minute <= position.entry_at):
        return
    if stock_crossed(stop, bar):
        position.stock_stop_hit = minute


def apply_pullback_bar(position, bar, risk, at):
    """One minute of the option for a pullback-stop position.

    The stock stop first; then the desk's own rule - the premium backstop on the
    opening rung, the trailing ladder above it - with the backstop's exit named
    for what it is.
    """
    if position.stock_stop_hit is not None and position.step == 1:
        return {"action": "exit", "price": bar["low"], "reason": "stop"}
    verdict = apply_bar(position, bar, risk, at)
    if verdict["action"] == "exit" and verdict["reason"] == "stop":
        verdict["reason"] = "backstop"
    return verdict


def exit_rule(position, strategy_risk):
    """The (risk, apply) a position is stepped with each minute.

    A pullback-stop position steps its ladder in its own R, so the rupees each
    rung locks are that trade's, not the desk's 550.
    """
    if position.stock_stop is None:
        return strategy_risk, apply_bar
    return dict(strategy_risk, rupeesPerTrade=position.stock_stop.rupees), apply_pullback_bar


def arm(position, stop, risk):
    """Fits a just-opened position to its pullback stop: the 1.5R premium
    backstop, and the stop it is watched against."""
    unit = stop.rupees / position.qty
    raw = position.entry - risk["backstopMultiple"] * unit
    position.risk_capped = raw <= PREMIUM_FLOOR
    position.stop = PREMIUM_FLOOR if position.risk_capped else raw
    stop.backstop = position.stop
    position.stock_stop = stop
    position.context["pullbackStop"] = stop.record()
    return position
