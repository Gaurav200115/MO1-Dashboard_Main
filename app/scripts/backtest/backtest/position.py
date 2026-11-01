"""Turning a rupee risk budget into premium levels, and walking the trailing ladder.

Ported line for line from app/src/lib/strategy/position.ts.

All of it is arithmetic on one number: the risk unit, R, expressed per unit of
the option rather than per trade. A 550 rupee budget on a 250-unit lot is 2.20
of premium, so the stop sits 2.20 below the fill and every rung of the ladder is
another 2.20. Working in per-unit terms keeps the ladder identical across stocks
whose lot sizes differ by two orders of magnitude.

There is no sign to flip anywhere in this file. Every position is a *bought*
option - the short rule buys a put - so the premium has to rise for the trade to
make money either way.
"""
from dataclasses import dataclass, field

# A premium cannot trade below five paise, so that is the floor a stop can sit at.
PREMIUM_FLOOR = 0.05


@dataclass
class Sizing:
    qty: int
    risk_per_unit: float
    stop: float
    target: float
    risk_capped: bool


def size_trade(entry, lot_size, risk):
    """position.ts sizeTrade.

    A cheap premium can be worth less than the risk budget: 550 of risk on a
    1,250-unit lot is 0.44 per unit, which is fine, but 550 on a 100-unit lot is
    5.50, and an ATM premium of 4 cannot fall that far. The trade is still taken
    - it risks the whole premium instead of the planned figure - and the
    shortfall is recorded rather than quietly rounded away, because it means
    that trade contributed less than a full R to the sample.
    """
    qty = lot_size * risk["lots"]
    if qty <= 0:
        raise ValueError(f"Cannot size a trade with qty {qty}")

    risk_per_unit = risk["rupeesPerTrade"] / qty
    raw = entry - risk_per_unit
    risk_capped = raw <= PREMIUM_FLOOR

    return Sizing(
        qty=qty,
        risk_per_unit=risk_per_unit,
        stop=PREMIUM_FLOOR if risk_capped else raw,
        target=entry + risk["rewardMultiple"] * risk_per_unit,
        risk_capped=risk_capped,
    )


def rung_levels(step, risk):
    """Stop and target in R-units for a given rung. position.ts rungLevels.

    Rung 1 is the opening position: stop one R below the fill, target at the
    configured reward multiple. On the 550 / 1:2 / start-at-1:3 defaults this
    produces exactly the specified ladder:

      +1100 (1:2)  stop stays at -550   the checkpoint passes, nothing moves
      +1650 (1:3)  stop -> +550         the first move, a 1100 gap
      +2200 (1:4)  stop -> +1650        one checkpoint behind from here on
      +2750 (1:5)  stop -> +2200
    """
    reward = risk["rewardMultiple"]
    start = risk["trailStartMultiple"]
    lock = risk["trailLockMultiple"]
    if step <= 1:
        return -1, reward

    # Rung n has been reached by touching the rung-(n-1) target, which sat at
    # (reward + n - 2) R.
    reached = reward + step - 2

    # Three regimes, and the discontinuity between the first two is deliberate.
    # Below the trail start the stop does not move at all - reaching 1:2 is
    # progress, not a reason to tighten. At the start multiple it jumps straight
    # to the lock; after that it follows one checkpoint behind.
    stop_r = -1 if reached < start else lock if reached == start else reached - 1
    return stop_r, reached + 1


@dataclass
class Position:
    symbol: str
    setup: str
    trading_date: str
    strategy_id: str
    strategy_version: int
    option_type: str
    expiry: object
    strike: float
    qty: int
    entry: float
    entry_at: object
    risk_per_unit: float
    risk_capped: bool
    stop: float
    target: float
    step: int = 1
    ladder: list = field(default_factory=list)
    gate: str = "clear"
    context: dict = field(default_factory=dict)

    # The last price this contract actually printed, and when. A position is
    # closed at this rather than at a price invented for the minute it ended on:
    # the flatten and the out-of-band exit both land on minutes where the
    # contract may not have traded at all.
    last_price: float | None = None
    last_at: object = None

    # Filled on exit.
    exit_price: float | None = None
    exit_at: object = None
    exit_reason: str | None = None

    def __post_init__(self):
        if self.last_price is None:
            self.last_price = self.entry
        if self.last_at is None:
            self.last_at = self.entry_at

    @property
    def profit(self):
        if self.exit_price is None:
            return None
        return (self.exit_price - self.entry) * self.qty


def open_position(signal, strategy, fill, lot_size, expiry, strike, option_type, gate, trading_date):
    """A filled signal, sized the desk's way."""
    sizing = size_trade(fill["price"], lot_size, strategy["risk"])
    return Position(
        symbol=signal.symbol,
        setup=signal.setup,
        trading_date=trading_date,
        strategy_id=strategy["id"],
        strategy_version=strategy["version"],
        option_type=option_type,
        expiry=expiry,
        strike=strike,
        qty=sizing.qty,
        entry=fill["price"],
        entry_at=signal.at,
        risk_per_unit=sizing.risk_per_unit,
        risk_capped=sizing.risk_capped,
        stop=sizing.stop,
        target=sizing.target,
        gate=gate,
        context={
            "pivot": signal.level.pivot,
            "pivotValue": signal.level.pivot_value,
            "levelStrike": signal.level.strike,
            "levelKind": signal.level.kind,
            "skew": (None if signal.level.skew() == float("inf") else signal.level.skew()),
            "gapPct": signal.level.gap_pct,
            "spotAtEntry": signal.spot,
            "emaAtEntry": signal.ema,
            "retracement": signal.retracement,
        },
    )


def advance_ladder(position, premium, risk, at):
    """Walks the ladder forward to wherever the premium has reached.

    Loops rather than advancing a single rung, because the premium is sampled
    periodically: a fast move can clear two rungs between two reads, and
    stopping at the first would leave the stop a full R behind where the rule
    says it should be.
    """
    if risk["trail"] == "single" and position.step >= 2:
        return None

    entry, unit = position.entry, position.risk_per_unit
    step, stop, target = position.step, position.stop, position.target
    steps = []

    # Bounded so a nonsensical premium - a bad tick, a zero unit - cannot spin.
    while premium >= target and len(steps) < 64:
        step += 1
        stop_r, target_r = rung_levels(step, risk)
        stop = entry + stop_r * unit
        target = entry + target_r * unit
        steps.append({"at": at, "step": step, "stop": stop, "target": target,
                      "locked": stop_r * risk["rupeesPerTrade"]})
        if risk["trail"] == "single":
            break

    if not steps:
        return None
    return {"stop": stop, "target": target, "step": step, "steps": steps}


def evaluate(position, last, risk, at):
    """What to do with an open trade at the premium just read.

    The stop is checked before the ladder. Both cannot be true of one premium,
    but the order states the priority plainly: a trade is never ratcheted on the
    same read that takes it out.
    """
    if last <= position.stop:
        # Which stop it was is decided by where the stop sits, not by how many
        # checkpoints have gone by. Under a ladder that does not move until 1:3,
        # a trade can be two checkpoints in and still be stopped out on its
        # original stop - calling that a trailing stop would report a loss as a
        # locked gain.
        trailed = position.stop > position.entry
        return {"action": "exit", "reason": "trail-stop" if trailed else "stop"}

    if risk["trail"] == "single" and position.step >= 2 and last >= position.target:
        return {"action": "exit", "reason": "trail-stop"}

    advance = advance_ladder(position, last, risk, at)
    if advance:
        return {"action": "trail", "advance": advance}
    return {"action": "hold"}


def apply_bar(position, bar, risk, at):
    """One minute of the contract, applied to an open position.

    The stop is tested on the minute's low and the ladder on its high, the stop
    first - the same priority the live engine gives them, resolved the only way
    a 1-minute bar allows. A minute that both stops the trade and clears a rung
    is counted as a stop, which is the conservative reading and the one that
    matches `evaluate` above.

    The fill is the stop itself, unless the minute *opened* through it, in which
    case the open is the first price actually available.
    """
    if bar["low"] <= position.stop:
        trailed = position.stop > position.entry
        return {"action": "exit",
                "price": min(bar["open"], position.stop),
                "reason": "trail-stop" if trailed else "stop"}

    verdict = evaluate(position, bar["high"], risk, at)
    if verdict["action"] == "trail":
        advance = verdict["advance"]
        position.stop = advance["stop"]
        position.target = advance["target"]
        position.step = advance["step"]
        position.ladder.extend(advance["steps"])
    return {"action": "hold"}


def close_position(position, price, at, reason):
    position.exit_price = price
    position.exit_at = at
    position.exit_reason = reason
    return position
