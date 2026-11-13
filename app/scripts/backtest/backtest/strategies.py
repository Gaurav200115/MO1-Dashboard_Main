"""The strategy registry, mirrored from app/src/lib/strategy/registry.ts.

This file is a *mirror*, not a second source of truth. registry.ts is where a
rule is written and reviewed; this is the same numbers in Python so the replay
runs the rule the live desk ran. Two consequences worth stating plainly:

  - Every field here must match registry.ts exactly. `check_against_registry()`
    re-reads the TypeScript and fails loudly on any drift, and the runner calls
    it before a run starts. A backtest of a rule the desk is not running is
    worse than no backtest, because it looks like evidence.

  - Versions are immutable. Bumping a rule means a new version in registry.ts
    and a new entry here - never an edit in place. Stored backtest trades name
    the version they were produced under, exactly as live trades do.
"""
import re
from pathlib import Path

# app/src/lib/strategy/registry.ts, from app/scripts/backtest/backtest/
REGISTRY_TS = Path(__file__).resolve().parents[3] / "src" / "lib" / "strategy" / "registry.ts"

MAX_OPEN_POSITIONS = 3

SHARED_PARAMS = {
    "emaPeriod": 21,
    "emaIntervalMinutes": 5,
    "emaZonePct": 0.4,
    "entryReboundPct": 0.2,
    "entryCutoffIst": "13:00",
    "flattenIst": "15:15",
    "maxOpenTrades": MAX_OPEN_POSITIONS,
    "maxTradesPerDay": 15,
    "maxTradesPerSymbolPerDay": 1,
    "maxSpreadPct": 2.0,
    "maxSpreadOfRiskPct": 30,
    "maxAskOverLastPct": 2.0,
    "staleQuoteSec": 120,
    "minStrikeOiShare": 3,
}

SHARED_RISK = {
    "rupeesPerTrade": 550,
    "lots": 1,
    "moneyness": "ATM",
    "rewardMultiple": 2,
    # The stop first moves at 1:2, to +1R, then one checkpoint behind.
    "trailStartMultiple": 2,
    "trailLockMultiple": 1,
    "trail": "ladder",
}

BREAKOUT_RETRACE_21EMA = {
    "id": "breakout-retrace-21ema",
    "version": 8,
    "name": "Level Break -> 21 EMA Retrace",
    "setups": ["A", "B"],
    "setupLabels": {"A": "Break & retrace", "B": "Support hold & level cross"},
    "sides": {"A": "LONG", "B": "LONG"},
    "params": dict(SHARED_PARAMS, resistanceSkew=4, supportSkew=5),
    "risk": dict(SHARED_RISK),
}

BREAKDOWN_RETRACE_21EMA = {
    "id": "breakdown-retrace-21ema",
    "version": 4,
    "name": "Support Break -> 21 EMA Retrace (Short)",
    "setups": ["C"],
    "setupLabels": {"C": "Breakdown & retrace"},
    "sides": {"C": "SHORT"},
    "params": dict(SHARED_PARAMS, resistanceSkew=4, supportSkew=5),
    "risk": dict(SHARED_RISK),
}

# ---------------- backtest-only rules ----------------
#
# Not mirrored from registry.ts, because the live desk does not run them and
# must not: they exist here and nowhere else. `check_against_registry` names the
# two mirrored constants explicitly, so a rule here is never compared with - or
# confused for - one the desk trades.
#
# NIFTY 15-minute opening range, as Gaurav specified it (2026-11-01):
#   - the high and low of 09:15-09:29, watched from 09:30
#   - a 1-minute NIFTY close above the high buys the ATM call; below the low,
#     the ATM put
#   - one trade a day: the first break taken, nothing after it
#   - stop 15 premium points under the fill; at +15 the stop moves to +5, and
#     every further +5 moves it up another 5 (+20 -> +10, +25 -> +15 ...)
#   - anything still open at 13:00 is closed at 13:00
NIFTY_ORB_15M = {
    "id": "nifty-orb-15m",
    "version": 1,
    "name": "NIFTY 15-min Opening Range Breakout",
    "backtestOnly": True,
    "standalone": True,
    "setups": ["ORB"],
    "setupLabels": {"ORB": "NIFTY opening range break"},
    # One leg that trades either way: the side is decided by which edge breaks.
    "sides": {"ORB": "BOTH"},
    "params": {
        "symbol": "NIFTY",
        "rangeStartIst": "09:15",
        "rangeEndIst": "09:30",          # exclusive: the range is the 09:15-09:29 minutes
        "breakOn": "1-minute close",
        "entryCutoffIst": "13:00",
        "flattenIst": "13:00",
        "maxTradesPerDay": 1,
    },
    "risk": {
        "lots": 1,
        "moneyness": "ATM",
        "stopPoints": 15,
        "trailStartPoints": 15,
        "trailLockPoints": 5,
        "trailStepPoints": 5,
    },
}

# ADR-scaled retrace, as Gaurav specified it (2026-11-13). Backtest only: if it
# shows a good result it goes live as a version change of the two live rules,
# and not before.
#
#   - The live rules measure the retrace in a fixed percent of price: within
#     0.4% of the 21 EMA to arm, a 0.2% turn off the extreme to enter. Here both
#     are measured in the stock's own 14-session average daily range instead -
#     zone 0.15 ADR, turn 0.075 ADR - calibrated so the median stock behaves as
#     the live rule does (adr.py has the measurement). The minimum pullback and
#     the closed-bar kill line ride on the same two numbers, exactly as live.
#   - Everything else is the live long v8 / short v4 as they stood that day:
#     same levels, same skews, same 13:00 cutoff, same book gate, same 550 risk,
#     and the same SL trail - at 1:2 the SL moves to +1R, then one step behind
#     (the "SL 1:2->1" in the tag).
#   - Setup B has no retracement percent, so B-ADR is B unchanged. It is in
#     the run so the three legs share the desk's three-position cap as they do
#     live; without it A-ADR and C-ADR would get slots B would have taken.
#
# Written out in full rather than derived from SHARED_PARAMS / SHARED_RISK,
# because a released version is frozen: if the live rule moves on, this must not
# move with it under the same version number. tests/test_adr.py fails when the
# two stop matching, so the change is a decision rather than an accident.
ADR_TAG = "ADR, SL 1:2->1"

ADR_PARAMS = {
    "emaPeriod": 21,
    "emaIntervalMinutes": 5,
    "entryBasis": "adr",
    "adrPeriod": 14,
    "adrZoneMultiple": 0.15,
    "adrTurnMultiple": 0.075,
    "entryCutoffIst": "13:00",
    "flattenIst": "15:15",
    "maxOpenTrades": MAX_OPEN_POSITIONS,
    "maxTradesPerDay": 15,
    "maxTradesPerSymbolPerDay": 1,
    "maxSpreadPct": 2.0,
    "maxSpreadOfRiskPct": 30,
    "maxAskOverLastPct": 2.0,
    "staleQuoteSec": 120,
    "minStrikeOiShare": 3,
    "resistanceSkew": 4,
    "supportSkew": 5,
}

ADR_RISK = {
    "rupeesPerTrade": 550,
    "lots": 1,
    "moneyness": "ATM",
    "rewardMultiple": 2,
    "trailStartMultiple": 2,
    "trailLockMultiple": 1,
    "trail": "ladder",
}

BREAKOUT_RETRACE_21EMA_ADR = {
    "id": "breakout-retrace-21ema-adr",
    "version": 1,
    "name": f"Level Break -> 21 EMA Retrace [{ADR_TAG}]",
    "backtestOnly": True,
    # An alternative to the desk's legs, not an addition to them: a run holds
    # one book or the other, never both watching the same stocks.
    "book": "adr",
    "setups": ["A-ADR", "B-ADR"],
    "setupLabels": {"A-ADR": f"Break & retrace [{ADR_TAG}]",
                    "B-ADR": f"Support hold & level cross [{ADR_TAG}]"},
    "sides": {"A-ADR": "LONG", "B-ADR": "LONG"},
    # Which leg of the state machine each setup is.
    "legs": {"A-ADR": "A", "B-ADR": "B"},
    "params": dict(ADR_PARAMS),
    "risk": dict(ADR_RISK),
}

BREAKDOWN_RETRACE_21EMA_ADR = {
    "id": "breakdown-retrace-21ema-adr",
    "version": 1,
    "name": f"Support Break -> 21 EMA Retrace (Short) [{ADR_TAG}]",
    "backtestOnly": True,
    "book": "adr",
    "setups": ["C-ADR"],
    "setupLabels": {"C-ADR": f"Breakdown & retrace [{ADR_TAG}]"},
    "sides": {"C-ADR": "SHORT"},
    "legs": {"C-ADR": "C"},
    "params": dict(ADR_PARAMS),
    "risk": dict(ADR_RISK),
}

ALL_STRATEGIES = (BREAKOUT_RETRACE_21EMA, BREAKDOWN_RETRACE_21EMA, NIFTY_ORB_15M,
                  BREAKOUT_RETRACE_21EMA_ADR, BREAKDOWN_RETRACE_21EMA_ADR)
STRATEGIES = {s["id"]: s for s in ALL_STRATEGIES}


def leg_of(strategy, setup):
    """The state-machine leg a setup runs: "A-ADR" is leg A measured with the ADR ruler."""
    return strategy.get("legs", {}).get(setup, setup)


def setup_for_leg(strategy, leg):
    """The inverse of leg_of, within one strategy: leg "A" of the ADR rule is "A-ADR"."""
    for setup, mapped in strategy.get("legs", {}).items():
        if mapped == leg:
            return setup
    return leg


def book_of(strategy):
    """Which book a strategy trades on. A run holds exactly one.

    The desk's legs share one book. The ADR variant is a second version of that
    same book - mixing the two would have both versions watching the same stocks
    and competing for the same three slots, which measures neither.
    """
    if strategy.get("standalone"):
        return strategy["id"]
    return strategy.get("book", "desk")


# ---------------- setups as the unit of a run ----------------
#
# A run names *setups*, not strategies. The long rule is two legs joined by an
# "OR" in its own spec - break a resistance and retrace (A), or hold a support
# and cross a level (B) - and they are different trades with different reasons
# for working. Bundling them means never finding out which of the two is
# carrying the result. The short rule is one leg and was already separate.
#
# This is a reporting split, not a rule change: each setup still runs under its
# own strategy's parameters and version, and nothing in registry.ts moves. What
# changes is that a run can replay one leg at a time.


_OPTION = {"LONG": "CE", "SHORT": "PE", "BOTH": "CE/PE"}


def _setup_index():
    out = {}
    for strategy in ALL_STRATEGIES:
        for setup in strategy["setups"]:
            out[setup] = {
                "setup": setup,
                "strategy": strategy["id"],
                "label": strategy["setupLabels"][setup],
                "side": strategy["sides"][setup],
                "option": _OPTION[strategy["sides"][setup]],
                "version": strategy["version"],
            }
    return out


SETUPS = _setup_index()
ALL_SETUPS = list(SETUPS)


def selection(setup_ids):
    """Setup ids -> (sorted strategy ids, {strategy id: selected setups}).

    The runner needs both: which strategies to build plans and state for, and
    which of each one's legs are actually allowed to fire.
    """
    if not setup_ids:
        raise SystemExit("pick at least one setup - one of " + ", ".join(ALL_SETUPS))
    chosen = {}
    for setup in setup_ids:
        if setup not in SETUPS:
            raise SystemExit(f"unknown setup {setup!r} - one of {ALL_SETUPS}")
        chosen.setdefault(SETUPS[setup]["strategy"], set()).add(setup)
    # A standalone rule trades a different instrument on its own book. Mixed into
    # a run with the stock legs, the desk's shared three-position cap would decide
    # between them, which is a question nobody asked.
    for sid in chosen:
        if STRATEGIES[sid].get("standalone") and len(chosen) > 1:
            raise SystemExit(f"setup {', '.join(sorted(chosen[sid]))} runs on its own - "
                             f"replay it in a run of its own")
    # The ADR legs are another version of the desk's legs, so the two never
    # share a run.
    if len({book_of(STRATEGIES[sid]) for sid in chosen}) > 1:
        raise SystemExit("the ADR legs (A-ADR, B-ADR, C-ADR) are an alternative to A, B and C, "
                         "not an addition - replay them in a run of their own")
    return sorted(chosen), chosen


def describe(setup_ids):
    return ", ".join(f"{s} ({SETUPS[s]['side'].lower()})" for s in sorted(setup_ids))


def get(strategy_id):
    s = STRATEGIES.get(strategy_id)
    if s is None:
        raise SystemExit(f"unknown strategy {strategy_id!r} - one of {list(STRATEGIES)}")
    return s


def option_type(strategy, setup):
    """Which option a setup buys.

    Both rules *buy* an option, which is why there is no sign flip anywhere in
    position.py: the short rule is a bought put, so its premium still has to rise
    for the trade to make money.
    """
    return "CE" if strategy["sides"][setup] == "LONG" else "PE"


# ---------------- drift check against registry.ts ----------------

def _strip_comments(text):
    """Removes // and /* */ comments.

    Not cosmetic. registry.ts documents its own history in prose - the v7 note
    says the rule no longer sets `excludedPivots`, and the shared params are
    explained in block comments that quote the very numbers being checked.
    Parsing the comments along with the code reports a rule that is only
    described, not applied.
    """
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"(?<![:\"'])//[^\n]*", "", text)


def _ts_number(text, key):
    """A `key: 3` field, or a `const KEY = 3` declaration."""
    m = re.search(r"\b%s\s*[:=]\s*(-?[\d.]+)" % re.escape(key), text)
    return float(m.group(1)) if m else None


def _ts_string(text, key):
    m = re.search(r"\b%s\s*:\s*[\"']([^\"']*)[\"']" % re.escape(key), text)
    return m.group(1) if m else None


def _ts_block(text, const_name):
    """The source of one exported definition, from its name to the line that closes it."""
    m = re.search(r"export const %s[^=]*=\s*\{" % re.escape(const_name), text)
    if not m:
        return None
    depth, i = 0, m.end() - 1
    while i < len(text):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[m.start():i + 1]
        i += 1
    return None


def check_against_registry():
    """Compares every mirrored number with registry.ts. Returns a list of differences.

    Deliberately a parse of the TypeScript rather than a hand-kept checklist: a
    checklist drifts silently, and the failure mode of drift here is a backtest
    that quietly measures a rule nobody trades.
    """
    if not REGISTRY_TS.exists():
        return ["registry.ts not found at %s - cannot verify the mirror" % REGISTRY_TS]

    text = _strip_comments(REGISTRY_TS.read_text(encoding="utf-8"))
    bad = []

    shared = text[:text.find("export const BREAKOUT")] if "export const BREAKOUT" in text else text
    for key, mine in SHARED_PARAMS.items():
        theirs = _ts_string(shared, key) if isinstance(mine, str) else _ts_number(shared, key)
        if key == "maxOpenTrades":
            theirs = _ts_number(shared, "MAX_OPEN_POSITIONS")
        if theirs is None:
            bad.append(f"params.{key}: not found in registry.ts")
        elif isinstance(mine, str):
            if theirs != mine:
                bad.append(f"params.{key}: registry.ts has {theirs!r}, mirror has {mine!r}")
        elif float(theirs) != float(mine):
            bad.append(f"params.{key}: registry.ts has {theirs}, mirror has {mine}")

    for key, mine in SHARED_RISK.items():
        theirs = _ts_string(shared, key) if isinstance(mine, str) else _ts_number(shared, key)
        if theirs is None:
            bad.append(f"risk.{key}: not found in registry.ts")
        elif isinstance(mine, str):
            if theirs != mine:
                bad.append(f"risk.{key}: registry.ts has {theirs!r}, mirror has {mine!r}")
        elif float(theirs) != float(mine):
            bad.append(f"risk.{key}: registry.ts has {theirs}, mirror has {mine}")

    for const, mine in (("BREAKOUT_RETRACE_21EMA", BREAKOUT_RETRACE_21EMA),
                        ("BREAKDOWN_RETRACE_21EMA", BREAKDOWN_RETRACE_21EMA)):
        block = _ts_block(text, const)
        if block is None:
            bad.append(f"{const}: not found in registry.ts")
            continue
        version = _ts_number(block, "version")
        if version is None or int(version) != mine["version"]:
            bad.append(f"{const}.version: registry.ts has {version}, mirror has {mine['version']}")
        sid = _ts_string(block, "id")
        if sid != mine["id"]:
            bad.append(f"{const}.id: registry.ts has {sid!r}, mirror has {mine['id']!r}")
        setups = re.findall(r"\bid\s*:\s*[\"']([ABC])[\"']", block)
        if setups != mine["setups"]:
            bad.append(f"{const}.setups: registry.ts has {setups}, mirror has {mine['setups']}")
        for key in ("resistanceSkew", "supportSkew"):
            theirs = _ts_number(block, key)
            if theirs is None or float(theirs) != float(mine["params"][key]):
                bad.append(f"{const}.params.{key}: registry.ts has {theirs}, "
                           f"mirror has {mine['params'][key]}")

        # v6 excluded R3 and v7 took it back. If an excludedPivots list reappears
        # in registry.ts, this mirror is silently trading a pivot the desk does not.
        if "excludedPivots" in block:
            bad.append(f"{const}: registry.ts sets excludedPivots, which this mirror does not model")

    return bad


if __name__ == "__main__":
    problems = check_against_registry()
    print("\n".join(problems) if problems else "mirror matches registry.ts")
