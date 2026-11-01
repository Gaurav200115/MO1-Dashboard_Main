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
    "trailStartMultiple": 3,
    "trailLockMultiple": 1,
    "trail": "ladder",
}

BREAKOUT_RETRACE_21EMA = {
    "id": "breakout-retrace-21ema",
    "version": 7,
    "name": "Level Break -> 21 EMA Retrace",
    "setups": ["A", "B"],
    "setupLabels": {"A": "Break & retrace", "B": "Support hold & level cross"},
    "sides": {"A": "LONG", "B": "LONG"},
    "params": dict(SHARED_PARAMS, resistanceSkew=4, supportSkew=5),
    "risk": dict(SHARED_RISK),
}

BREAKDOWN_RETRACE_21EMA = {
    "id": "breakdown-retrace-21ema",
    "version": 3,
    "name": "Support Break -> 21 EMA Retrace (Short)",
    "setups": ["C"],
    "setupLabels": {"C": "Breakdown & retrace"},
    "sides": {"C": "SHORT"},
    "params": dict(SHARED_PARAMS, resistanceSkew=4, supportSkew=5),
    "risk": dict(SHARED_RISK),
}

STRATEGIES = {s["id"]: s for s in (BREAKOUT_RETRACE_21EMA, BREAKDOWN_RETRACE_21EMA)}


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


def _setup_index():
    out = {}
    for strategy in (BREAKOUT_RETRACE_21EMA, BREAKDOWN_RETRACE_21EMA):
        for setup in strategy["setups"]:
            out[setup] = {
                "setup": setup,
                "strategy": strategy["id"],
                "label": strategy["setupLabels"][setup],
                "side": strategy["sides"][setup],
                "option": "CE" if strategy["sides"][setup] == "LONG" else "PE",
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
