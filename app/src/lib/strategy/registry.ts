import type { StrategyDefinition } from "./types";

/**
 * Every strategy the desk knows, defined in code and mirrored into Mongo.
 *
 * Code is the source of truth rather than the database, for the same reason the
 * EOD reports on disk are: a rule is something to review in a diff. Mongo holds
 * a copy so a stored trade can be joined back to the exact wording and
 * thresholds it ran under, even after the definition here has moved on.
 *
 * Adding a strategy means adding an entry to STRATEGIES. Changing one means
 * bumping `version` — never editing a released version in place, because trades
 * already reference it and rewriting it would retroactively relabel results that
 * were produced by different rules.
 */

/** Strategy 1 — level break, pull back to the 21 EMA, long the ATM call. */
export const BREAKOUT_RETRACE_21EMA: StrategyDefinition = {
  id: "breakout-retrace-21ema",
  version: 1,
  name: "Level Break → 21 EMA Retrace",
  createdAt: "2026-09-14",

  spec: [
    "Entry: Price is below the major Resistance point (point with least gap and the skew should be above 4x) and crosses it, then when prices Retraces back to near 21 EMA then plan a LONG trade.",
    "OR",
    "Price is above major Support (point with less gap and skew above 5x) and crosses another support or the resistance point (that we have marked as important from the OI and pivots) and also crossed 21 EMA, make entry.",
    "This would be active till 11:30 AM. After this this wont run.",
    "Risk of 550 rupees per trade, one lot of each stock, on the ATM strike.",
    "Trail the target once 1:2 is achieved and make the SL trail to 1 i.e. 550 profit, and the target by the same i.e. now target would be 1650.",
  ],

  setups: [
    {
      id: "A",
      label: "Break & retrace",
      side: "LONG",
      description:
        "Price crossed above the major resistance (least gap, call skew ≥ 4x), then pulled back to within range of the 21 EMA.",
    },
    {
      id: "B",
      label: "Support hold & level cross",
      side: "LONG",
      description:
        "Price is holding above the major support (least gap, put skew ≥ 5x), crossed up through another confirmed level, and is above the 21 EMA.",
    },
  ],

  params: {
    emaPeriod: 21,
    emaIntervalMinutes: 5,
    /**
     * "Near" the EMA. Measured either side, so a wick through it still counts as
     * a touch — a retrace that undershoots by a tick is the same event as one
     * that stops exactly on the line.
     */
    emaProximityPct: 0.25,
    resistanceSkew: 4,
    supportSkew: 5,
    entryCutoffIst: "11:30",
    /**
     * Not part of the stated rule. An options position has to be closed before
     * the close or it is marked to the settlement price with no say in the
     * matter, so something has to flatten it; 15:20 leaves ten minutes of
     * liquidity. Entries stop at 11:30, but a trade opened at 11:29 runs on.
     */
    flattenIst: "15:20",
    /**
     * Also not part of the stated rule, and the number most worth arguing with.
     * The overnight scan confirms levels on ~163 of 184 stocks, so an uncapped
     * run could open dozens of positions in the first hour — 550 x 40 is 22,000
     * of risk on the table at once. These are the knobs to change, not the rule.
     */
    maxOpenTrades: 5,
    maxTradesPerDay: 15,
    maxTradesPerSymbolPerDay: 1,
  },

  risk: {
    rupeesPerTrade: 550,
    lots: 1,
    moneyness: "ATM",
    rewardMultiple: 2,
    trail: "ladder",
  },
};

const ALL: StrategyDefinition[] = [BREAKOUT_RETRACE_21EMA];

export const STRATEGIES: ReadonlyMap<string, StrategyDefinition> = new Map(
  ALL.map((strategy) => [strategy.id, strategy])
);

/** Stable key for one released version — also the `_id` of the stored copy. */
export function strategyKey(id: string, version: number): string {
  return `${id}@${version}`;
}

export function listStrategies(): StrategyDefinition[] {
  return [...STRATEGIES.values()];
}

export function getStrategy(id: string): StrategyDefinition | null {
  return STRATEGIES.get(id) ?? null;
}

/** Which strategies the live engine runs. Separate from the catalogue so a rule can be parked without deleting it. */
export const ACTIVE_STRATEGY_IDS: string[] = [BREAKOUT_RETRACE_21EMA.id];

export function activeStrategies(): StrategyDefinition[] {
  return ACTIVE_STRATEGY_IDS.map((id) => STRATEGIES.get(id)).filter(
    (s): s is StrategyDefinition => s != null
  );
}
