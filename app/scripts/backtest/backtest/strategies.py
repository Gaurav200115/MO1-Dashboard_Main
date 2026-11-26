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
    # Long v9 / short v5 (2026-11-15): the retrace is measured in the stock's own
    # 14-session average daily range - zone 0.15 ADR, turn 0.075 ADR - instead of
    # the fixed 0.4% / 0.2% of v8 / v4. Backtested first as A-ADR / B-ADR / C-ADR
    # (below), and went live unchanged. adr.py has the definition.
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
    # Long v11 / short v7: skip a contract where one price step across the lot
    # costs more than 20% of the risk (110 of 550). The archive holds no tick
    # sizes, so gate.contract_tick reads the contract's step from its own prices.
    "maxStepCostOfRiskPct": 20,
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

# Long v10 / short v6 (2026-11-15): the major level's skew bar is per pivot -
# 5x for R1, R3, S1, S3; any skew for R2, S2, P - instead of 4x per resistance /
# 5x per support. Backtested first as A-SK / B-SK / C-SK (below) and went live
# unchanged. registry.ts holds it as PIVOT_MIN_SKEW, shared by both rules.
PIVOT_MIN_SKEW = {"R1": 5, "R3": 5, "S1": 5, "S3": 5, "R2": 0, "S2": 0, "P": 0}

BREAKOUT_RETRACE_21EMA = {
    "id": "breakout-retrace-21ema",
    "version": 11,
    "name": "Level Break -> 21 EMA Retrace",
    "setups": ["A", "B"],
    "setupLabels": {"A": "Break & retrace", "B": "Support hold & level cross"},
    "sides": {"A": "LONG", "B": "LONG"},
    "params": dict(SHARED_PARAMS, pivotMinSkew=dict(PIVOT_MIN_SKEW)),
    "risk": dict(SHARED_RISK),
}

BREAKDOWN_RETRACE_21EMA = {
    "id": "breakdown-retrace-21ema",
    "version": 7,
    "name": "Support Break -> 21 EMA Retrace (Short)",
    "setups": ["C"],
    "setupLabels": {"C": "Breakdown & retrace"},
    "sides": {"C": "SHORT"},
    "params": dict(SHARED_PARAMS, pivotMinSkew=dict(PIVOT_MIN_SKEW)),
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

# ADR-scaled retrace, as Gaurav specified it (2026-11-13). Backtested here first;
# it went live unchanged on 2026-11-15 as long v9 / short v5, so the desk's own
# A, B and C now run exactly this rule. These stay as the frozen record of what
# was backtested to justify that change - tests/test_adr.py checks the two are
# still identical - and as a way to re-run that exact version.
#
#   - The live rules measure the retrace in a fixed percent of price: within
#     0.4% of the 21 EMA to arm, a 0.2% turn off the extreme to enter. Here both
#     are measured in the stock's own 14-session average daily range instead -
#     zone 0.15 ADR, turn 0.075 ADR - calibrated so the median stock behaves as
#     the live rule does (adr.py has the measurement). The minimum pullback and
#     the closed-bar kill line ride on the same two numbers, exactly as live.
#   - Everything else was the live long v8 / short v4 as they stood that day:
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
#
# One thing worth knowing for future comparisons: now that the live rule is the
# ADR rule, the mirror can no longer replay the v8 / v4 percent rule. Anything
# compared against it needs a run made before this change, which records its
# versions on the run.
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

# Stop at the pullback, as Gaurav specified it (2026-11-15). Backtest only: it
# goes live only if it shows a lower drawdown than the desk's fixed 550 stop.
#
# The entry is the live ADR rule (long v9 / short v5) unchanged. What changes is
# where setups A and C put their stop. The desk stops every trade 550 rupees of
# premium under the fill, which measured as a 0.19% move in the stock at the
# median - about the same size as the 0.075 ADR turn the entry waits for, and
# above the pullback's own low in 80 of 108 live A/C trades. So the stop sat
# inside the very wiggle the setup had just come out of.
#
#   - The stop is the stock returning to the pullback's low (A) or the rally's
#     high (C) - the price at which the setup is proven wrong - watched on the
#     stock's 1-minute bars, not on the option.
#   - R, the trade's risk in rupees, is what that costs at 1 lot: the distance
#     from the entry spot to that extreme x an assumed ATM delta of 0.5 x the
#     lot quantity. Under 550 it is raised to 550 and the stop moved further out
#     to match, so no trade is stopped tighter than the desk's own; over 800 the
#     trade is not taken, and the setup is spent for the day as a gate rejection
#     spends it.
#   - The 1:2 ladder runs in that trade's own R: at +2R the stop moves to +1R,
#     then one step behind.
#   - The option keeps a premium stop at 1.5R under the fill, the stand-in for
#     the exchange-held SL that live would rest as a backstop for when the desk
#     itself is down. An option that loses 1.5R while the stock holds is closed
#     there, and counted as its own exit reason.
#   - Setup B fires on a level cross, not a pullback, so it has no low to stop
#     under: B-PB is B unchanged, on the fixed 550 premium stop. It is in the run
#     so the three legs share the three-position cap as they do live.
#
# pullback_stop.py has the arithmetic and the exit rule.
PULLBACK_STOP_TAG = "ADR, SL pullback 550-800"

PULLBACK_STOP_RISK = {
    # Setup B's fixed risk, and the floor every A/C stop is raised to.
    "rupeesPerTrade": 550,
    "lots": 1,
    "moneyness": "ATM",
    "rewardMultiple": 2,
    "trailStartMultiple": 2,
    "trailLockMultiple": 1,
    "trail": "ladder",
    "stopBasis": "pullback",
    "minRiskRupees": 550,
    "maxRiskRupees": 800,
    "assumedDelta": 0.5,
    "backstopMultiple": 1.5,
}

BREAKOUT_RETRACE_21EMA_PB = {
    "id": "breakout-retrace-21ema-pbsl",
    "version": 1,
    "name": f"Level Break -> 21 EMA Retrace [{PULLBACK_STOP_TAG}]",
    "backtestOnly": True,
    # Another version of the desk's legs, like the ADR variant: never in a run
    # with A/B/C or the ADR legs, which would have both watching the same stocks.
    "book": "pullback-stop",
    "setups": ["A-PB", "B-PB"],
    "setupLabels": {"A-PB": f"Break & retrace [{PULLBACK_STOP_TAG}]",
                    "B-PB": f"Support hold & level cross [{PULLBACK_STOP_TAG}]"},
    "sides": {"A-PB": "LONG", "B-PB": "LONG"},
    "legs": {"A-PB": "A", "B-PB": "B"},
    "params": dict(ADR_PARAMS),
    "risk": dict(PULLBACK_STOP_RISK),
}

BREAKDOWN_RETRACE_21EMA_PB = {
    "id": "breakdown-retrace-21ema-pbsl",
    "version": 1,
    "name": f"Support Break -> 21 EMA Retrace (Short) [{PULLBACK_STOP_TAG}]",
    "backtestOnly": True,
    "book": "pullback-stop",
    "setups": ["C-PB"],
    "setupLabels": {"C-PB": f"Breakdown & retrace [{PULLBACK_STOP_TAG}]"},
    "sides": {"C-PB": "SHORT"},
    "legs": {"C-PB": "C"},
    "params": dict(ADR_PARAMS),
    "risk": dict(PULLBACK_STOP_RISK),
}

# ADR with a daily loss limit, as Gaurav specified it (2026-11-15). Backtest only.
#
# The pullback stop above did not backtest well, so the stop stays the desk's:
# 550 of premium, the 1:2 ladder to +1R and one step behind. This is the live
# ADR rule (long v9 / short v5) exactly, with one addition:
#
#   - Once the day's net P&L on *closed* trades is down 1,700 or more, no new
#     trade is taken for the rest of the day. Wins offset losses. Trades already
#     open are left alone - they run on under their own stop and ladder, and if
#     they close in profit the day can come back above the line, which lets
#     entries resume. The limit covers all three legs together, like the cap.
#   - A stop fills at its own price in this replay, so a loss is normally
#     exactly 550: three full losses are 1,650, and 1,700 usually trips on the
#     fourth (or the third, when gaps through the stop added 50 or more). He
#     chose 1,700 over 1,650 knowing that.
#
# The limit is checked as each signal fires, after the open book has been
# stepped for that minute - so a loss closed at 10:04 blocks a signal at 10:04.
DAILY_LOSS_TAG = "ADR, SL 550, day stop 1700"

DAILY_LOSS_RISK = dict(ADR_RISK, dailyLossLimitRupees=1700)

BREAKOUT_RETRACE_21EMA_DL = {
    "id": "breakout-retrace-21ema-adr-dll",
    "version": 1,
    "name": f"Level Break -> 21 EMA Retrace [{DAILY_LOSS_TAG}]",
    "backtestOnly": True,
    # Another version of the desk's legs: never in a run with A/B/C or the
    # other variants, which would watch the same stocks for the same slots.
    "book": "adr-daily-loss",
    "setups": ["A-DL", "B-DL"],
    "setupLabels": {"A-DL": f"Break & retrace [{DAILY_LOSS_TAG}]",
                    "B-DL": f"Support hold & level cross [{DAILY_LOSS_TAG}]"},
    "sides": {"A-DL": "LONG", "B-DL": "LONG"},
    "legs": {"A-DL": "A", "B-DL": "B"},
    "params": dict(ADR_PARAMS),
    "risk": dict(DAILY_LOSS_RISK),
}

BREAKDOWN_RETRACE_21EMA_DL = {
    "id": "breakdown-retrace-21ema-adr-dll",
    "version": 1,
    "name": f"Support Break -> 21 EMA Retrace (Short) [{DAILY_LOSS_TAG}]",
    "backtestOnly": True,
    "book": "adr-daily-loss",
    "setups": ["C-DL"],
    "setupLabels": {"C-DL": f"Breakdown & retrace [{DAILY_LOSS_TAG}]"},
    "sides": {"C-DL": "SHORT"},
    "legs": {"C-DL": "C"},
    "params": dict(ADR_PARAMS),
    "risk": dict(DAILY_LOSS_RISK),
}

# ADR with a skew threshold per pivot, as Gaurav specified it (2026-11-15).
# Backtest only.
#
# The live rule (long v9 / short v5) picks each stock's major level as the
# confirmed level closest to its strike whose skew clears one bar per side: 4x
# for a resistance, 5x for a support. This variant gives each pivot its own bar:
#
#   R1, R3, S1, S3   skew 5x or more - anything under 5x cannot be the major
#   R2, S2, P        any skew - every confirmed level qualifies (a confirmed
#                    level is already at least 1.8x by construction)
#
# The pick is otherwise the same - least gap wins among the levels that qualify
# - so where an R1 at 4.5x used to be the major, the closest qualifying level now
# takes its place, and an R2 or P at 2x can be the major. He chose that over
# keeping today's pick and filtering it. "5x or more" counts exactly 5.00x as
# passing, the way the desk already reads "skew above 4x".
#
#   - Setup B's cross candidates are unchanged: it still counts a cross of any
#     confirmed level at any skew. The support it holds above is the major
#     support, so that follows the new pick.
#   - Everything else is the live ADR rule: ADR retrace, 550 stop, 1:2 -> +1R.
PIVOT_SKEW_TAG = "ADR, skew 5x R1/R3/S1/S3"

# Break-even (2026-11-23, as Gaurav specified it): once a trade is up 1.5R the
# stop moves to the entry price - cost to cost. Then 1:2 -> +1R as before.
# Added to -SK in place (v2; its v1 runs predate it), -CAP and -35K (v2).
# position.move_to_cost. Backtest only - the live desk does not do this.
BREAKEVEN_AT_R = 1.5

PIVOT_SKEW_PARAMS = {
    # The per-side bars are dropped rather than left in, so the record of this
    # rule does not show a 4x / 5x it never applies.
    **{k: v for k, v in ADR_PARAMS.items() if k not in ("resistanceSkew", "supportSkew")},
    "pivotMinSkew": {"R1": 5, "R3": 5, "S1": 5, "S3": 5, "R2": 0, "S2": 0, "P": 0},
}

BREAKOUT_RETRACE_21EMA_SK = {
    "id": "breakout-retrace-21ema-adr-pskew",
    "version": 2,
    "name": f"Level Break -> 21 EMA Retrace [{PIVOT_SKEW_TAG}]",
    "backtestOnly": True,
    "book": "adr-pivot-skew",
    "setups": ["A-SK", "B-SK"],
    "setupLabels": {"A-SK": f"Break & retrace [{PIVOT_SKEW_TAG}]",
                    "B-SK": f"Support hold & level cross [{PIVOT_SKEW_TAG}]"},
    "sides": {"A-SK": "LONG", "B-SK": "LONG"},
    "legs": {"A-SK": "A", "B-SK": "B"},
    "params": dict(PIVOT_SKEW_PARAMS),
    "risk": dict(ADR_RISK, breakevenAtR=BREAKEVEN_AT_R),
}

BREAKDOWN_RETRACE_21EMA_SK = {
    "id": "breakdown-retrace-21ema-adr-pskew",
    "version": 2,
    "name": f"Support Break -> 21 EMA Retrace (Short) [{PIVOT_SKEW_TAG}]",
    "backtestOnly": True,
    "book": "adr-pivot-skew",
    "setups": ["C-SK"],
    "setupLabels": {"C-SK": f"Breakdown & retrace [{PIVOT_SKEW_TAG}]"},
    "sides": {"C-SK": "SHORT"},
    "legs": {"C-SK": "C"},
    "params": dict(PIVOT_SKEW_PARAMS),
    "risk": dict(ADR_RISK, breakevenAtR=BREAKEVEN_AT_R),
}

# The live A, B and C traded on NIFTY instead of the stocks - as Gaurav specified
# it on 2026-11-21. Backtest only; the desk never trades NIFTY.
#
# The live long v11 / short v7 rule, run on one instrument: NIFTY's weekly
# options (nearest expiry, so the expiring contract on expiry day - 0 DTE). The
# overnight scan is the same, on the index: Fibonacci pivots from NIFTY's
# previous session, confirmed by the NIFTY weekly option chain's OI (1.8x, ATM+-8,
# 0.8% band, per-pivot 5x for R1/R3/S1/S3), ADR from NIFTY's own 14 sessions, the
# 21 EMA on 5-minute bars. What differs:
#   - R is Rs 650 a trade (1 lot), so the 1:2 target is Rs 1,300 and the ladder
#     steps in Rs 650 - his number, not the stocks' Rs 550
#   - v2 (2026-11-23): one trade of each setup a day - A, B and C each at most
#     once, and only when its own setup forms. A leg that fires (taken or
#     refused) is spent for the day, exactly as live; A firing does not use up
#     B, because there is no per-symbol cap across legs. Max 3 open still holds.
#     (v1 re-armed a leg straight after each signal: any number a day.)
#   - the gate's monthly stock-liquidity proxies do not apply to an index and are
#     skipped; its exact checks (volume, strike OI >= 3% of the chain's heaviest)
#     run on the index options
NIFTY_ABC_TAG = "NIFTY weekly, R 650, 1 per setup/day"

NIFTY_ABC_PARAMS = {
    **BREAKOUT_RETRACE_21EMA["params"],
    "instrument": "NIFTY",
    "maxTradesPerDay": None,
    "maxTradesPerSymbolPerDay": None,
    "skipStockLiquidity": True,
}

NIFTY_ABC_RISK = dict(SHARED_RISK, rupeesPerTrade=650)

NIFTY_BREAKOUT_RETRACE_21EMA = {
    "id": "nifty-breakout-retrace-21ema",
    "version": 2,
    "name": f"NIFTY Level Break -> 21 EMA Retrace [{NIFTY_ABC_TAG}]",
    "backtestOnly": True,
    "instrument": "NIFTY",
    "book": "nifty-abc",
    "setups": ["A-NIFTY", "B-NIFTY"],
    "setupLabels": {"A-NIFTY": "NIFTY break & retrace",
                    "B-NIFTY": "NIFTY support hold & level cross"},
    "sides": {"A-NIFTY": "LONG", "B-NIFTY": "LONG"},
    "legs": {"A-NIFTY": "A", "B-NIFTY": "B"},
    "params": dict(NIFTY_ABC_PARAMS),
    "risk": dict(NIFTY_ABC_RISK),
}

NIFTY_BREAKDOWN_RETRACE_21EMA = {
    "id": "nifty-breakdown-retrace-21ema",
    "version": 2,
    "name": f"NIFTY Support Break -> 21 EMA Retrace (Short) [{NIFTY_ABC_TAG}]",
    "backtestOnly": True,
    "instrument": "NIFTY",
    "book": "nifty-abc",
    "setups": ["C-NIFTY"],
    "setupLabels": {"C-NIFTY": "NIFTY breakdown & retrace"},
    "sides": {"C-NIFTY": "SHORT"},
    "legs": {"C-NIFTY": "C"},
    "params": dict(NIFTY_ABC_PARAMS),
    "risk": dict(NIFTY_ABC_RISK),
}

# Fewer trades, less drawdown (2026-11-23), as Gaurav specified it. Two
# alternatives, both on the live long v11 / short v7 rule unchanged, both under
# a Rs 35,000 budget:
#
#   -CAP   A, B and C, at most 3 entries a day across all three (first come,
#          first taken), and no new entry from 10:30. Trades already open run on
#          to their own exit.
#   -35K   setup B only, the normal day (entries till 13:00, the usual 15 per
#          rule a day).
#
# The budget: a signal whose premium (price x qty) plus the premium already in
# open trades would go over Rs 35,000 is skipped - open trades are never closed
# to make room. The money comes back when a trade closes. A skipped signal does
# not count toward the 3 a day. Max 3 open still holds.
# v2: plus the break-even at 1.5R (BREAKEVEN_AT_R, above).
BUDGET_RUPEES = 35000

CAP_TAG = "3 a day till 10:30, Rs 35k"
CAP_PARAMS = dict(SHARED_PARAMS, pivotMinSkew=dict(PIVOT_MIN_SKEW),
                  entryCutoffIst="10:30", maxTradesPerDayBook=3)
BUDGET_RISK = dict(SHARED_RISK, capitalRupees=BUDGET_RUPEES, breakevenAtR=BREAKEVEN_AT_R)

BREAKOUT_RETRACE_21EMA_CAP = {
    "id": "breakout-retrace-21ema-cap",
    "version": 2,
    "name": f"Level Break -> 21 EMA Retrace [{CAP_TAG}]",
    "backtestOnly": True,
    "book": "cap-35k",
    "setups": ["A-CAP", "B-CAP"],
    "setupLabels": {"A-CAP": f"Break & retrace [{CAP_TAG}]",
                    "B-CAP": f"Support hold & level cross [{CAP_TAG}]"},
    "sides": {"A-CAP": "LONG", "B-CAP": "LONG"},
    "legs": {"A-CAP": "A", "B-CAP": "B"},
    "params": dict(CAP_PARAMS),
    "risk": dict(BUDGET_RISK),
}

BREAKDOWN_RETRACE_21EMA_CAP = {
    "id": "breakdown-retrace-21ema-cap",
    "version": 2,
    "name": f"Support Break -> 21 EMA Retrace (Short) [{CAP_TAG}]",
    "backtestOnly": True,
    "book": "cap-35k",
    "setups": ["C-CAP"],
    "setupLabels": {"C-CAP": f"Breakdown & retrace [{CAP_TAG}]"},
    "sides": {"C-CAP": "SHORT"},
    "legs": {"C-CAP": "C"},
    "params": dict(CAP_PARAMS),
    "risk": dict(BUDGET_RISK),
}

B_ONLY_TAG = "B only, Rs 35k"

BREAKOUT_RETRACE_21EMA_B35K = {
    "id": "breakout-retrace-21ema-b35k",
    "version": 2,
    "name": f"Support Hold -> Level Cross [{B_ONLY_TAG}]",
    "backtestOnly": True,
    "book": "b-35k",
    "setups": ["B-35K"],
    "setupLabels": {"B-35K": f"Support hold & level cross [{B_ONLY_TAG}]"},
    "sides": {"B-35K": "LONG"},
    "legs": {"B-35K": "B"},
    "params": dict(SHARED_PARAMS, pivotMinSkew=dict(PIVOT_MIN_SKEW)),
    "risk": dict(BUDGET_RISK),
}

# The -SK legs with the stop sized by the stock's ATR, as Gaurav specified it
# (2026-11-25). Backtest only.
#
#   - Entries are A-SK / B-SK / C-SK v2 exactly: per-pivot skew, ADR retrace,
#     13:00 cutoff, 1 lot of the ATM option.
#   - The stop is the stock's ATR(14) on 5-minute bars / 3, applied straight to
#     the option premium in points: ATR 14.40 puts it 4.80 under the fill. R is
#     that x the lot quantity. No 550, no floor, no ceiling. atr_stop.py has the
#     ATR's exact definition.
#   - -ATR    stop to cost at +1.5R, at +2R the stop goes to +1R, then one rung
#             behind - all in the trade's own R.
#   - -ATR600 the same ladder in fixed Rs 600 steps: cost at +900, +600 locked at
#             +1,200, then every +600 - whatever the ATR stop is.
#   - The spread-of-risk check he was asked about does not exist here: the
#     archive holds no quotes (gate.py), and the -SK params carry no step-cost
#     gate, so nothing else reads R before entry.
ATR_TAG = "ATR/3 SL, ladder in own R"
ATR600_TAG = "ATR/3 SL, ladder Rs 600"

ATR_STOP_RISK = {
    "lots": 1,
    "moneyness": "ATM",
    "rewardMultiple": 2,
    "trailStartMultiple": 2,
    "trailLockMultiple": 1,
    "trail": "ladder",
    "breakevenAtR": BREAKEVEN_AT_R,
    "stopBasis": "atr",
    "atrPeriod": 14,
    "atrIntervalMinutes": 5,
    "atrStopDivisor": 3,
    "ladderBasis": "own-r",
}

ATR600_RISK = dict(ATR_STOP_RISK, ladderBasis="fixed", rupeesPerTrade=600)

BREAKOUT_RETRACE_21EMA_ATR = {
    "id": "breakout-retrace-21ema-atr",
    "version": 1,
    "name": f"Level Break -> 21 EMA Retrace [{ATR_TAG}]",
    "backtestOnly": True,
    "book": "atr-stop",
    "setups": ["A-ATR", "B-ATR"],
    "setupLabels": {"A-ATR": f"Break & retrace [{ATR_TAG}]",
                    "B-ATR": f"Support hold & level cross [{ATR_TAG}]"},
    "sides": {"A-ATR": "LONG", "B-ATR": "LONG"},
    "legs": {"A-ATR": "A", "B-ATR": "B"},
    "params": dict(PIVOT_SKEW_PARAMS),
    "risk": dict(ATR_STOP_RISK),
}

BREAKDOWN_RETRACE_21EMA_ATR = {
    "id": "breakdown-retrace-21ema-atr",
    "version": 1,
    "name": f"Support Break -> 21 EMA Retrace (Short) [{ATR_TAG}]",
    "backtestOnly": True,
    "book": "atr-stop",
    "setups": ["C-ATR"],
    "setupLabels": {"C-ATR": f"Breakdown & retrace [{ATR_TAG}]"},
    "sides": {"C-ATR": "SHORT"},
    "legs": {"C-ATR": "C"},
    "params": dict(PIVOT_SKEW_PARAMS),
    "risk": dict(ATR_STOP_RISK),
}

BREAKOUT_RETRACE_21EMA_ATR600 = {
    "id": "breakout-retrace-21ema-atr600",
    "version": 1,
    "name": f"Level Break -> 21 EMA Retrace [{ATR600_TAG}]",
    "backtestOnly": True,
    "book": "atr-stop-600",
    "setups": ["A-ATR600", "B-ATR600"],
    "setupLabels": {"A-ATR600": f"Break & retrace [{ATR600_TAG}]",
                    "B-ATR600": f"Support hold & level cross [{ATR600_TAG}]"},
    "sides": {"A-ATR600": "LONG", "B-ATR600": "LONG"},
    "legs": {"A-ATR600": "A", "B-ATR600": "B"},
    "params": dict(PIVOT_SKEW_PARAMS),
    "risk": dict(ATR600_RISK),
}

BREAKDOWN_RETRACE_21EMA_ATR600 = {
    "id": "breakdown-retrace-21ema-atr600",
    "version": 1,
    "name": f"Support Break -> 21 EMA Retrace (Short) [{ATR600_TAG}]",
    "backtestOnly": True,
    "book": "atr-stop-600",
    "setups": ["C-ATR600"],
    "setupLabels": {"C-ATR600": f"Breakdown & retrace [{ATR600_TAG}]"},
    "sides": {"C-ATR600": "SHORT"},
    "legs": {"C-ATR600": "C"},
    "params": dict(PIVOT_SKEW_PARAMS),
    "risk": dict(ATR600_RISK),
}

# Two changes to setup A, each on the -ATR600 rule (2026-11-26, as Gaurav
# specified them). Backtest only. B and C are -ATR600's, unchanged, in each run
# so the three legs share the three-position cap as they do live.
#
#   -2X    A may trade a stock twice a day. After the first A trade on a stock
#          closes, A re-arms on it and needs a *fresh* setup - price back under
#          the level, a new break, a new retrace - before it can enter again. B
#          and C keep one trade a stock, and a stock B or C has traded still
#          cannot be taken by A (the per-stock limit, as before).
#   -OEMA  At the moment A would enter, the ATM option it would buy must be
#          trading above its own 21 EMA on 1-minute bars; if not, the setup is
#          lost for the day, as a gate rejection spends it. The EMA is the
#          option's closes before the entry minute today (SMA of the first 21,
#          then EMA, as the stock's), against the entry minute's close. Fewer
#          than 21 printed minutes before the signal: no EMA, no trade.
#          B and C are not checked.
A2X_TAG = "ATR600, A twice a stock"
AOEMA_TAG = "ATR600, A needs option > 1-min 21 EMA"

A2X_PARAMS = dict(PIVOT_SKEW_PARAMS, maxATradesPerSymbolPerDay=2, rearmAAfterClose=True)
AOEMA_PARAMS = dict(PIVOT_SKEW_PARAMS,
                    optionEmaGate={"legs": ["A"], "period": 21, "intervalMinutes": 1})


def _atr600_variant(sid, name, tag, book, suffix, params, side):
    legs = {"LONG": ("A", "B"), "SHORT": ("C",)}[side]
    labels = {"A": "Break & retrace", "B": "Support hold & level cross", "C": "Breakdown & retrace"}
    setups = [f"{leg}-{suffix}" for leg in legs]
    return {
        "id": sid,
        "version": 1,
        "name": f"{name} [{tag}]",
        "backtestOnly": True,
        "book": book,
        "setups": setups,
        "setupLabels": {s: f"{labels[s[0]]} [{tag}]" for s in setups},
        "sides": {s: side for s in setups},
        "legs": {s: s[0] for s in setups},
        "params": dict(params),
        "risk": dict(ATR600_RISK),
    }


BREAKOUT_RETRACE_21EMA_A2X = _atr600_variant(
    "breakout-retrace-21ema-atr600-a2x", "Level Break -> 21 EMA Retrace", A2X_TAG, "atr600-a2x", "2X",
    A2X_PARAMS, "LONG")
BREAKDOWN_RETRACE_21EMA_A2X = _atr600_variant(
    "breakdown-retrace-21ema-atr600-a2x", "Support Break -> 21 EMA Retrace (Short)", A2X_TAG, "atr600-a2x",
    "2X", A2X_PARAMS, "SHORT")
BREAKOUT_RETRACE_21EMA_AOEMA = _atr600_variant(
    "breakout-retrace-21ema-atr600-aoema", "Level Break -> 21 EMA Retrace", AOEMA_TAG, "atr600-aoema", "OEMA",
    AOEMA_PARAMS, "LONG")
BREAKDOWN_RETRACE_21EMA_AOEMA = _atr600_variant(
    "breakdown-retrace-21ema-atr600-aoema", "Support Break -> 21 EMA Retrace (Short)", AOEMA_TAG,
    "atr600-aoema", "OEMA", AOEMA_PARAMS, "SHORT")

# Setup A with a wider ATR stop (2026-11-26, as Gaurav specified it), after the
# A analysis showed half of A's trades stopped inside the pullback's own wiggle.
# Backtest only. Two versions, identical but for the divisor:
#
#   -ATR2  A's SL = the stock's 5-min ATR / 2, in premium points
#   -ATR1  A's SL = the full ATR
#
# and in both, for A only: no new A entry from 12:00, and no move to cost at
# +900 (the Rs 600 ladder from +1,200 is kept). B and C are -ATR600's exactly -
# ATR/3, cost at +900, entries till 13:00 - in each run so the legs share the
# three slots. `legRisk` / `legCutoffIst` carry the A-only changes.
def _a_wide(divisor):
    return {"atrStopDivisor": divisor, "breakevenAtR": None}


ATR2_TAG = "ATR600, A: SL ATR/2, no cost move, none after 12:00"
ATR1_TAG = "ATR600, A: SL ATR/1, no cost move, none after 12:00"
A_WIDE_PARAMS = dict(PIVOT_SKEW_PARAMS, legCutoffIst={"A": "12:00"})

BREAKOUT_RETRACE_21EMA_ATR2 = dict(
    _atr600_variant("breakout-retrace-21ema-atr600-a2", "Level Break -> 21 EMA Retrace", ATR2_TAG, "atr600-a-atr2",
                    "ATR2", A_WIDE_PARAMS, "LONG"), legRisk={"A": _a_wide(2)})
BREAKDOWN_RETRACE_21EMA_ATR2 = _atr600_variant(
    "breakdown-retrace-21ema-atr600-a2", "Support Break -> 21 EMA Retrace (Short)", ATR2_TAG, "atr600-a-atr2",
    "ATR2", A_WIDE_PARAMS, "SHORT")
BREAKOUT_RETRACE_21EMA_ATR1 = dict(
    _atr600_variant("breakout-retrace-21ema-atr600-a1", "Level Break -> 21 EMA Retrace", ATR1_TAG, "atr600-a-atr1",
                    "ATR1", A_WIDE_PARAMS, "LONG"), legRisk={"A": _a_wide(1)})
BREAKDOWN_RETRACE_21EMA_ATR1 = _atr600_variant(
    "breakdown-retrace-21ema-atr600-a1", "Support Break -> 21 EMA Retrace (Short)", ATR1_TAG, "atr600-a-atr1",
    "ATR1", A_WIDE_PARAMS, "SHORT")

ALL_STRATEGIES = (BREAKOUT_RETRACE_21EMA, BREAKDOWN_RETRACE_21EMA, NIFTY_ORB_15M,
                  BREAKOUT_RETRACE_21EMA_ADR, BREAKDOWN_RETRACE_21EMA_ADR,
                  BREAKOUT_RETRACE_21EMA_PB, BREAKDOWN_RETRACE_21EMA_PB,
                  BREAKOUT_RETRACE_21EMA_DL, BREAKDOWN_RETRACE_21EMA_DL,
                  BREAKOUT_RETRACE_21EMA_SK, BREAKDOWN_RETRACE_21EMA_SK,
                  NIFTY_BREAKOUT_RETRACE_21EMA, NIFTY_BREAKDOWN_RETRACE_21EMA,
                  BREAKOUT_RETRACE_21EMA_CAP, BREAKDOWN_RETRACE_21EMA_CAP,
                  BREAKOUT_RETRACE_21EMA_B35K,
                  BREAKOUT_RETRACE_21EMA_ATR, BREAKDOWN_RETRACE_21EMA_ATR,
                  BREAKOUT_RETRACE_21EMA_ATR600, BREAKDOWN_RETRACE_21EMA_ATR600,
                  BREAKOUT_RETRACE_21EMA_A2X, BREAKDOWN_RETRACE_21EMA_A2X,
                  BREAKOUT_RETRACE_21EMA_AOEMA, BREAKDOWN_RETRACE_21EMA_AOEMA,
                  BREAKOUT_RETRACE_21EMA_ATR2, BREAKDOWN_RETRACE_21EMA_ATR2,
                  BREAKOUT_RETRACE_21EMA_ATR1, BREAKDOWN_RETRACE_21EMA_ATR1)
STRATEGIES = {s["id"]: s for s in ALL_STRATEGIES}


def leg_of(strategy, setup):
    """The state-machine leg a setup runs: "A-ADR" is leg A measured with the ADR ruler."""
    return strategy.get("legs", {}).get(setup, setup)


def risk_of(strategy, setup):
    """The risk a setup trades under: the strategy's, with that leg's own
    overrides (`legRisk`) on top. A None override removes the key - e.g. no
    break-even for that leg. Every rule without `legRisk` is unchanged."""
    over = strategy.get("legRisk", {}).get(leg_of(strategy, setup))
    if not over:
        return strategy["risk"]
    risk = dict(strategy["risk"])
    for key, value in over.items():
        if value is None:
            risk.pop(key, None)
        else:
            risk[key] = value
    return risk


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
    # The variants (ADR, pullback stop, daily loss limit, pivot skew) are other
    # versions of the desk's legs, so no two of those books ever share a run.
    if len({book_of(STRATEGIES[sid]) for sid in chosen}) > 1:
        raise SystemExit("A/B/C, its variants (-ADR, -PB, -DL, -SK, -CAP, -35K, -ATR, -ATR600, -2X, -OEMA, -ATR2, -ATR1) and the -NIFTY legs are alternatives, not "
                         "additions - replay each set in a run of its own")
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


def _ts_pivot_table(text, const_name):
    """A `const NAME ... = { R1: 5, P: 0 }` table, as {pivot: float}. None when absent."""
    m = re.search(r"const %s\b[^=]*=\s*\{([^}]*)\}" % re.escape(const_name), text)
    if not m:
        return None
    return {k: float(v) for k, v in re.findall(r"\b([RSP]\d?)\s*:\s*(-?[\d.]+)", m.group(1))}


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
        # The skew bar the major pick uses. Up to v9 / v5 one number per side;
        # from v10 / v6 a table per pivot, shared through PIVOT_MIN_SKEW.
        for key in ("resistanceSkew", "supportSkew"):
            theirs = _ts_number(block, key)
            if key in mine["params"]:
                if theirs is None or float(theirs) != float(mine["params"][key]):
                    bad.append(f"{const}.params.{key}: registry.ts has {theirs}, "
                               f"mirror has {mine['params'][key]}")
            elif theirs is not None:
                bad.append(f"{const}.params.{key}: registry.ts sets {theirs}, which the mirror "
                           f"does not apply")
        if "pivotMinSkew" in mine["params"]:
            if not re.search(r"\bpivotMinSkew\s*:\s*PIVOT_MIN_SKEW\b", block):
                bad.append(f"{const}.params.pivotMinSkew: registry.ts does not use PIVOT_MIN_SKEW")
            theirs = _ts_pivot_table(text, "PIVOT_MIN_SKEW")
            if theirs != {k: float(v) for k, v in mine["params"]["pivotMinSkew"].items()}:
                bad.append(f"{const}.params.pivotMinSkew: registry.ts has {theirs}, "
                           f"mirror has {mine['params']['pivotMinSkew']}")

        # v6 excluded R3 and v7 took it back. If an excludedPivots list reappears
        # in registry.ts, this mirror is silently trading a pivot the desk does not.
        if "excludedPivots" in block:
            bad.append(f"{const}: registry.ts sets excludedPivots, which this mirror does not model")

    return bad


if __name__ == "__main__":
    problems = check_against_registry()
    print("\n".join(problems) if problems else "mirror matches registry.ts")
