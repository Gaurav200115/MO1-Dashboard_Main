"""Each backtest trade replayed again under two exits - backtest only (2026-11-25).

The analysis page's trailing what-if compares exits. From a finished trade it
can only model them off the ladder, which starts at 2R - and the two exits
Gaurav wants side by side differ *below* 2R:

  liveRule       the live desk's: stop at -1R until 1:2, then +1R and one behind
  breakevenAt15  the same, plus the stop to cost once the trade is up 1.5R

A trade that touched 1.5R and fell back is a -1R loss under one and a scratch
under the other, and nothing stored on the trade says which happened. So every
trade is replayed under both, on the same option minutes as the real one, and
both results are stored on it (`whatIf`). Exact, not modelled.

The shadows are copies taken the moment the position opens - same contract,
fill, stop and ladder unit (the ATR stop, the -ATR600 Rs 600 rungs, the
pullback stop) - stepped minute by minute alongside it. They never hold a
slot, a budget or a day's count: the run's book is the real position's alone.
A shadow may outlive its position (a trade stopped at cost can run on under the
live rule), so it is stepped until its own exit or the flatten.
"""
import copy

# key -> the break-even multiple that exit uses (None: no break-even).
EXITS = {"liveRule": None, "breakevenAt15": 1.5}


def risk_for(base, key):
    """The real position's risk with only the break-even set to this exit's."""
    risk = {k: v for k, v in base.items() if k != "breakevenAtR"}
    if EXITS[key] is not None:
        risk["breakevenAtR"] = EXITS[key]
    return risk


def open_shadows(position):
    """[(position, key, shadow)] for a position just opened."""
    out = []
    for key in EXITS:
        shadow = copy.deepcopy(position)
        shadow.context.pop("whatIf", None)
        out.append((position, key, shadow))
    return out


def record(position, key, shadow):
    """Stores a shadow's exit on the real position, where the trade document reads it."""
    position.context.setdefault("whatIf", {})[key] = {
        "exitPrice": shadow.exit_price,
        "exitAt": shadow.exit_at,
        "reason": shadow.exit_reason,
        "profit": shadow.profit,
        "step": shadow.step,
    }
