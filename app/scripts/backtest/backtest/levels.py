"""The overnight scan, replayed from the archive.

Ported from app/src/lib/eod (pivots.ts, oi.ts, chain.ts, confluence.ts) and
app/src/lib/strategy/levels.ts. The live desk computes these from the Kite
instrument dump and an option-chain snapshot; here the same arithmetic runs on
the NSE bhavcopy rows already in PostgreSQL.

What the live desk does the night before a session, this does for any session in
the archive: take the previous session's high, low and official close, build the
Fibonacci pivots, and keep only the pivots that a lopsided option strike agrees
with. The output is a SymbolPlan per stock - the handful of prices the rules
watch - identical in shape to the one signals.py consumes live.

Step 1 of the build order checks the result against `daily_levels` in Mongo for
a session the desk has already traded. If they do not match, nothing downstream
means anything.
"""
import math
from dataclasses import dataclass

# lib/eod/pivots.ts
R1_FIB, R2_FIB = 0.382, 0.618
# lib/eod/oi.ts
OI_RATIO = 1.8
# lib/eod/chain.ts - ATM +- 8 ladder positions
STRIKE_WINDOW = 8
# lib/eod/confluence.ts
BAND_MIN_PCT, BAND_MAX_PCT = 0.0, 0.8

PIVOT_ORDER = ("R3", "R2", "R1", "P", "S1", "S2", "S3")


@dataclass
class ConfirmedLevel:
    """One pivot a strike agreed with. Mirrors lib/eod/confluence.ts ConfirmedLevel."""
    pivot: str
    pivot_value: float
    kind: str                 # "support" | "resistance"
    strike: float
    call_oi: float
    put_oi: float
    gap_pct: float            # strike vs pivot, percent of the pivot
    reach_pct: float          # pivot vs the close, percent of the close

    def skew(self):
        """levels.ts skewOf: the dominant side over the other, oriented to the level's kind.

        A support's strength is puts over calls, a resistance's is calls over
        puts. Orienting it here is what lets "skew above 5x" mean the same thing
        on both sides, which is how the rule is written.

        Infinity for a one-sided strike: no open interest at all on the losing
        side is the strongest form of the imbalance, not a missing measurement.
        """
        dom, other = (self.put_oi, self.call_oi) if self.kind == "support" else (self.call_oi, self.put_oi)
        if other <= 0:
            return math.inf if dom > 0 else 0.0
        return dom / other


@dataclass
class SymbolPlan:
    """The prices one stock is watched at. Mirrors strategy/levels.ts SymbolPlan."""
    symbol: str
    close: float              # previous session's official close
    lot_size: int
    strike_step: float
    major_resistance: ConfirmedLevel | None
    major_support: ConfirmedLevel | None
    marked: list


def fib_pivots(high, low, close):
    """None when the session has no range - a stock locked at a circuit limit all day
    collapses every level onto P, which would then confirm seven times over against
    one strike."""
    if not all(isinstance(v, (int, float)) and math.isfinite(v) and v > 0 for v in (high, low, close)):
        return None
    rng = high - low
    if rng <= 0:
        return None
    p = (high + low + close) / 3
    return {"R3": p + rng, "R2": p + R2_FIB * rng, "R1": p + R1_FIB * rng, "P": p,
            "S1": p - R1_FIB * rng, "S2": p - R2_FIB * rng, "S3": p - rng}


def pivot_levels(pivots, close):
    """The central pivot has no fixed side: above it P acts as support, below it as
    resistance. Every other level's role is fixed by construction."""
    kind = {"R3": "resistance", "R2": "resistance", "R1": "resistance",
            "P": "support" if close >= pivots["P"] else "resistance",
            "S1": "support", "S2": "support", "S3": "support"}
    return [(label, pivots[label], kind[label]) for label in PIVOT_ORDER]


def gap_pct(value, ref):
    return abs(value - ref) / ref * 100


def chain_window(strike_oi, reference):
    """chain.ts planChain: the ATM +- STRIKE_WINDOW ladder positions, keeping only
    strikes that list both a call and a put.

    `strike_oi` is {strike: {"CE": oi, "PE": oi}} for one expiry.
    Returns [(strike, call_oi, put_oi)].
    """
    ladder = sorted(strike_oi)
    if not ladder:
        return []
    atm = 0
    for i in range(1, len(ladder)):
        if abs(ladder[i] - reference) < abs(ladder[atm] - reference):
            atm = i
    band = ladder[max(0, atm - STRIKE_WINDOW): atm + STRIKE_WINDOW + 1]
    return [(k, strike_oi[k]["CE"], strike_oi[k]["PE"])
            for k in band if "CE" in strike_oi[k] and "PE" in strike_oi[k]]


def oi_levels(chain, ratio=OI_RATIO):
    """Strikes where one side carries at least `ratio` times the other's open interest."""
    out = []
    for strike, call_oi, put_oi in chain:
        if call_oi + put_oi <= 0:
            continue
        kind = ("resistance" if call_oi >= ratio * put_oi
                else "support" if put_oi >= ratio * call_oi else None)
        if kind:
            out.append((strike, kind, call_oi, put_oi))
    return out


def confirm_levels(pivots, levels, close):
    """confluence.ts: greedy tightest-first pairing, each pivot and each strike used once.

    The one-use-per-strike half matters: R1 and R2 are only 0.236 of the range
    apart, so one strike routinely falls in band of both. Letting it confirm
    each would report one piece of evidence as two independent signals.
    """
    pairs = []
    for label, value, kind in pivots:
        if not (math.isfinite(value) and value > 0):
            continue
        for strike, lkind, call_oi, put_oi in levels:
            if lkind != kind:
                continue
            gap = gap_pct(strike, value)
            if BAND_MIN_PCT <= gap <= BAND_MAX_PCT:
                pairs.append((gap, label, value, kind, strike, call_oi, put_oi))

    pairs.sort(key=lambda x: x[0])
    used_pivots, used_strikes, out = set(), set(), []
    for gap, label, value, kind, strike, call_oi, put_oi in pairs:
        if label in used_pivots or strike in used_strikes:
            continue
        used_pivots.add(label)
        used_strikes.add(strike)
        out.append(ConfirmedLevel(label, value, kind, strike, call_oi, put_oi,
                                  gap, gap_pct(value, close)))
    return out


def pick_major(levels, kind, min_skew):
    """levels.ts pickMajor: least gap wins, skew is the gate and not the ranking.

    The gap is a distance between two independent estimates of the same price;
    the skew is a raw ratio that runs to 10x on thin strikes for reasons that
    have nothing to do with conviction.
    """
    best = None
    for level in levels:
        if level.kind != kind or level.skew() < min_skew:
            continue
        if best is None or level.gap_pct < best.gap_pct:
            best = level
    return best


def plan_for_stock(symbol, session, chain, lot_size, strike_step, params):
    """One stock's plan for the session *after* `session`.

    `session` is (high, low, close) of the previous session from cm_bhavcopy.
    `chain` is [(strike, call_oi, put_oi)] from that session's fo_bhavcopy, the
    nearest expiry strictly after it.

    Returns None when the stock cannot be traded - no range, no confirmed level,
    or no major level on either side. Neither leg of either rule can arm without
    a major level to anchor on.
    """
    high, low, close = session
    pivots = fib_pivots(high, low, close)
    if pivots is None:
        return None

    marked = confirm_levels(pivot_levels(pivots, close), oi_levels(chain), close)
    if not marked:
        return None

    excluded = set(params.get("excludedPivots") or ())
    def tradeable(level):
        return level if level is not None and level.pivot not in excluded else None

    major_resistance = tradeable(pick_major(marked, "resistance", params["resistanceSkew"]))
    major_support = tradeable(pick_major(marked, "support", params["supportSkew"]))
    if major_resistance is None and major_support is None:
        return None

    return SymbolPlan(
        symbol=symbol,
        close=close,
        lot_size=lot_size,
        strike_step=strike_step,
        major_resistance=major_resistance,
        major_support=major_support,
        marked=[lv for lv in marked if lv.pivot not in excluded],
    )


def cross_candidates(plan):
    """Setup B's candidates: every marked level except the major support it stands on.

    The rule says "crosses another support or the resistance point", and without
    the exclusion price merely wobbling around its own support registers as a
    break of it.
    """
    basis = plan.major_support
    if basis is None:
        return plan.marked
    return [lv for lv in plan.marked if lv.pivot != basis.pivot]
