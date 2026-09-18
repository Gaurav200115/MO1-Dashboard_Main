import type { StrategyDefinition, StrategyParams, StrategyRisk } from "./types";

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

/**
 * Positions open at once, across the whole desk.
 *
 * Deliberately not a per-strategy number. The long rule and the short rule are
 * separate strategies but they are not separate money — one account running
 * three longs and three shorts is running six positions and six times the risk.
 * The engines share one book and check it before every entry.
 */
export const MAX_OPEN_POSITIONS = 3;

/** Session bounds and geometry shared by both rules, so the two cannot drift. */
const SHARED_PARAMS: Pick<
  StrategyParams,
  | "emaPeriod"
  | "emaIntervalMinutes"
  | "emaZonePct"
  | "entryReboundPct"
  | "entryCutoffIst"
  | "flattenIst"
  | "maxOpenTrades"
  | "maxTradesPerDay"
  | "maxTradesPerSymbolPerDay"
  | "maxSpreadPct"
  | "maxSpreadOfRiskPct"
  | "maxAskOverLastPct"
  | "staleQuoteSec"
  | "minStrikeOiShare"
> = {
  emaPeriod: 21,
  emaIntervalMinutes: 5,
  /*
   * The retracement zone. Price must come back within 0.4% of the 21 EMA for the
   * pullback to count — the worked example is an EMA of 1200 and a pullback to
   * 1204.5, which is 0.375% above it. Measured either side, so a wick through
   * the line is the same event as a pullback that stops exactly on it.
   */
  emaZonePct: 0.4,
  /*
   * The confirmation leg. Reaching the EMA arms the setup; turning back off it
   * is what takes the trade. From a long's retracement low of 1204.5 that puts
   * the entry at 1206.91 — 0.2% of the low, not of the EMA, so the trigger sits
   * the same distance from the pullback wherever in the zone it stopped.
   */
  entryReboundPct: 0.2,
  /*
   * Both rules now run to 15:15, and 15:15 is also when everything is closed:
   * entries stop and any position still open is flattened in the same minute.
   * The cutoff is the moment the strategy stops, not the last minute it trades.
   */
  entryCutoffIst: "15:15",
  flattenIst: "15:15",
  maxOpenTrades: MAX_OPEN_POSITIONS,
  /*
   * Mine, not specified. With entries now running all session rather than
   * stopping at 11:30, some ceiling has to exist or a choppy day can churn.
   */
  maxTradesPerDay: 15,
  maxTradesPerSymbolPerDay: 1,

  /*
   * Book checks, added after the first three sessions. 9 of 36 trades died
   * inside ten seconds and accounted for the whole net loss; every one had been
   * filled at an ask far above where the contract was trading. The other 27
   * netted positive. See tradeable.ts.
   *
   * The thresholds are set to clear the observed damage with room, not tuned —
   * the worst survivors were 3% and 4% over the last print, so 2% rejects them
   * with margin while leaving a normal ATM book (well under 1%) alone. Every
   * rejection is counted and logged so these can be moved on evidence.
   */
  maxSpreadPct: 2.0,
  maxSpreadOfRiskPct: 30,
  maxAskOverLastPct: 2.0,
  staleQuoteSec: 120,
  minStrikeOiShare: 3,
};

/** The money side, identical for both rules — same budget, same ladder. */
const SHARED_RISK: StrategyRisk = {
  rupeesPerTrade: 550,
  lots: 1,
  moneyness: "ATM",
  rewardMultiple: 2,
  /*
   * The stop does not move at 1:2 any more. It first moves at 1:3, straight to
   * +1R, which leaves a 1100 gap; from 1:4 on it follows one checkpoint behind
   * and the gap settles at 550.
   *
   *   +1100 (1:2)  stop stays at -550
   *   +1650 (1:3)  stop -> +550
   *   +2200 (1:4)  stop -> +1650
   *   +2750 (1:5)  stop -> +2200
   */
  trailStartMultiple: 3,
  trailLockMultiple: 1,
  trail: "ladder",
};

/** Strategy 1 — level break, pull back to the 21 EMA, long the ATM call. */
export const BREAKOUT_RETRACE_21EMA: StrategyDefinition = {
  id: "breakout-retrace-21ema",
  version: 4,
  name: "Level Break → 21 EMA Retrace",
  createdAt: "2026-09-16",

  spec: [
    "Entry: Price is below the major Resistance point (point with least gap and the skew should be above 4x) and crosses it, then when prices Retraces back to near 21 EMA then plan a LONG trade.",
    "v2: the retracement must bring price within 0.4% of the 21 EMA — if the 21 EMA is 1200 and price comes back to 1204.5, that is a proper retracement level. Entry is not taken there: as soon as price then moves 0.2% up off that retracement low, take the LONG.",
    "OR",
    "Price is above major Support (point with less gap and skew above 5x) and crosses another support or the resistance point (that we have marked as important from the OI and pivots) and also crossed 21 EMA, make entry.",
    "v3: runs till 3:15 PM — entries stop and anything still open is closed at 15:15. Was 11:30 AM.",
    "v3: no more than 3 trades live at a time, counted across every running strategy. A 4th cannot be placed until one closes on its SL or trailing SL.",
    "Risk of 550 rupees per trade, one lot of each stock, on the ATM strike.",
    "v3: the SL no longer moves at 1:2. Once 1:3 is achieved the SL trails to 550, and from then on it follows one step behind — 2200 hit trails the SL to 1650, 2750 trails it to 2200.",
    "v4: a signal is skipped unless the option's book is tradeable — two-sided, ask within 2% of a fresh print, spread under 2% and under 30% of the stop distance, and the strike carrying at least 3% of its chain's heaviest OI. The 550 stop itself is unchanged.",
  ],

  setups: [
    {
      id: "A",
      label: "Break & retrace",
      side: "LONG",
      requires: "majorResistance",
      description:
        "Price crossed above the major resistance (least gap, call skew ≥ 4x), pulled back to within 0.4% of the 21 EMA, then turned up 0.2% off that low.",
    },
    {
      id: "B",
      label: "Support hold & level cross",
      side: "LONG",
      requires: "majorSupport",
      description:
        "Price is holding above the major support (least gap, put skew ≥ 5x), crossed up through another confirmed level, and is above the 21 EMA.",
    },
  ],

  params: {
    ...SHARED_PARAMS,
    resistanceSkew: 4,
    supportSkew: 5,
  },

  risk: SHARED_RISK,
};

/** Strategy 2 — the short. Break the major support, rally to the 21 EMA, roll over. */
export const BREAKDOWN_RETRACE_21EMA: StrategyDefinition = {
  id: "breakdown-retrace-21ema",
  version: 2,
  name: "Support Break → 21 EMA Retrace (Short)",
  createdAt: "2026-09-16",

  spec: [
    "Entry: If price breaks major support with highest priority point and when it retraces back to 21 EMA till 0.4% after crossing support we will make short entry.",
    "Mirrors the long: the rally back to within 0.4% of the 21 EMA arms the setup, and the entry is taken once price rolls back over 0.2% off the high of that rally.",
    "Runs till 3:15 PM — entries stop and anything still open is closed at 15:15.",
    "No more than 3 trades live at a time, counted across every running strategy.",
    "Risk of 550 rupees per trade, one lot of each stock, on the ATM strike.",
    "The SL does not move at 1:2. Once 1:3 is achieved the SL trails to 550, and from then on it follows one step behind.",
    "v2: a signal is skipped unless the option's book is tradeable — same checks as the long rule. The 550 stop itself is unchanged.",
  ],

  setups: [
    {
      id: "C",
      label: "Breakdown & retrace",
      side: "SHORT",
      requires: "majorSupport",
      description:
        "Price broke below the major support (least gap, put skew ≥ 5x), rallied back to within 0.4% of the 21 EMA, then rolled over 0.2% off that high.",
    },
  ],

  params: {
    ...SHARED_PARAMS,
    /*
     * "Major support with highest priority point" is the same level the long
     * rule already calls major: least gap between pivot and strike, among
     * supports whose put skew clears 5x. `resistanceSkew` is carried only so the
     * stored record is comparable across strategies — setup C never reads it.
     */
    resistanceSkew: 4,
    supportSkew: 5,
  },

  risk: SHARED_RISK,
};

const ALL: StrategyDefinition[] = [BREAKOUT_RETRACE_21EMA, BREAKDOWN_RETRACE_21EMA];

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
export const ACTIVE_STRATEGY_IDS: string[] = [
  BREAKOUT_RETRACE_21EMA.id,
  BREAKDOWN_RETRACE_21EMA.id,
];

export function activeStrategies(): StrategyDefinition[] {
  return ACTIVE_STRATEGY_IDS.map((id) => STRATEGIES.get(id)).filter(
    (s): s is StrategyDefinition => s != null
  );
}
