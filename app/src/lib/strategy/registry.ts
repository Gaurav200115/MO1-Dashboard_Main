import type { PivotLabel } from "@/lib/eod/pivots";
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
  | "entryBasis"
  | "adrPeriod"
  | "adrZoneMultiple"
  | "adrTurnMultiple"
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
  | "maxStepCostOfRiskPct"
> = {
  emaPeriod: 21,
  emaIntervalMinutes: 5,
  /*
   * The retrace is measured in the stock's own daily range (long v9 / short v5).
   *
   * Up to v8 / v4 it was a fixed percent of price — within 0.4% of the 21 EMA to
   * arm, a 0.2% turn off the pullback's extreme to enter — which is the same
   * ruler for a stock that moves 1.5% a day and one that moves 4%. Now both are
   * fractions of the stock's 14-session average daily range (eod/adr.ts):
   *
   *   zone  0.15 ADR    how close to the 21 EMA counts as a retrace, either side,
   *                     and how far a closed bar may sit through it before the
   *                     setup is dead
   *   turn  0.075 ADR   the turn off the pullback's extreme that takes the trade,
   *                     and the minimum pullback off the post-break extreme
   *
   * Calibrated so the median stock behaves as the percent rule did: the median
   * 14-session ADR across the desk's 186 stocks (daily_levels, 7 Sep – 13 Nov
   * 2026) is 2.716%, so 0.4% = 0.147 ADR and 0.2% = 0.074 ADR. A stock at
   * ₹1,000 with that ADR gets a ₹4.07 zone and a ₹2.04 turn; at a 1.5% ADR,
   * ₹2.25 and ₹1.13; at 4%, ₹6.00 and ₹3.00. In rupees for the day, from the
   * previous official close.
   *
   * Backtested as A-ADR / B-ADR / C-ADR before going live. A stock with under 14
   * sessions of history has no ADR: its A and C legs cannot arm (B is untouched).
   */
  entryBasis: "adr",
  adrPeriod: 14,
  adrZoneMultiple: 0.15,
  adrTurnMultiple: 0.075,
  /*
   * Entries stop at 13:00 and positions already open are left alone.
   *
   * These are two different clocks and they are deliberately no longer the same
   * one. 13:00 is when the strategies stop *looking* — the cutoff is exclusive,
   * so it has stopped by 13:00 rather than trading through that minute. A trade
   * taken at 12:59 then runs on under the ordinary rules and can only be closed
   * by its stop or its trailing stop.
   *
   * 15:15 is not a strategy rule; it is the backstop. A bought option has to be
   * out before the close or it is marked to settlement with no say in the
   * matter, so something has to flatten whatever is still running.
   */
  entryCutoffIst: "13:00",
  flattenIst: "15:15",
  maxOpenTrades: MAX_OPEN_POSITIONS,
  /*
   * Mine, not specified. A ceiling has to exist or a choppy morning can churn;
   * with the window now closing at 13:00 this binds far less often than it did.
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
  /*
   * Long v11 / short v7: skip a contract where one price step, across the lot,
   * costs more than 20% of the risk - 110 of the 550. Measured on the contract's
   * own tick (five paise, or one paisa on cheap options of low-priced stocks), so
   * it bites only on very large lots on a five-paisa tick (ETERNAL 2,425, LTF
   * 2,250): there one tick of slippage is a fifth of the risk before anything
   * else has gone wrong.
   */
  maxStepCostOfRiskPct: 20,
};

/** The money side, identical for both rules — same budget, same ladder. */
const SHARED_RISK: StrategyRisk = {
  rupeesPerTrade: 550,
  lots: 1,
  moneyness: "ATM",
  rewardMultiple: 2,
  /*
   * The stop first moves at 1:2, straight to +1R, and follows one checkpoint
   * behind from there — so the gap is 550 the whole way up and a trade that has
   * touched 1:2 can no longer end in a loss.
   *
   *   +1100 (1:2)  stop -> +550      the first move
   *   +1650 (1:3)  stop -> +1100
   *   +2200 (1:4)  stop -> +1650
   *   +2750 (1:5)  stop -> +2200
   *
   * This was 1:3 / +1R until v8. The trade-off it accepts, in both directions:
   * protecting at 1:2 cannot be free, because the same move that stops a winner
   * giving back two R also ends the trades that dip after 1:2 and would have
   * run. The exit study measured 7 trades that reached 2R and still closed red,
   * which is what this is aimed at.
   */
  trailStartMultiple: 2,
  trailLockMultiple: 1,
  trail: "ladder",
};

/**
 * The skew a level needs to be picked as major, per pivot (long v10 / short v6).
 *
 * Up to v9 / v5 there was one bar per side — 4x for any resistance, 5x for any
 * support. Now each pivot has its own: R1, R3, S1 and S3 need 5x or more; R2, S2
 * and P qualify at any skew (a confirmed level is already 1.8x by construction).
 * The least-gap pick is unchanged, so an R1 under 5x gives way to the closest
 * level that qualifies, and an R2 or P at 2x can be the major. Setup B's cross
 * candidates are not filtered by it. Backtested as A-SK / B-SK / C-SK first.
 */
const PIVOT_MIN_SKEW: Partial<Record<PivotLabel, number>> = {
  R1: 5,
  R3: 5,
  S1: 5,
  S3: 5,
  R2: 0,
  S2: 0,
  P: 0,
};

/** Strategy 1 — level break, pull back to the 21 EMA, long the ATM call. */
export const BREAKOUT_RETRACE_21EMA: StrategyDefinition = {
  id: "breakout-retrace-21ema",
  version: 11,
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
    "v5: both strategies end at 1:00 PM — no entries after that. A trade already running is left open and managed by the ordinary rules; 15:15 stays only as the end-of-day backstop.",
    "v6: stop the long trades that we take for the R3 pivot point, whatever the skew or anything else is. R2, R1 and P are still traded as before; nothing takes R3's place.",
    "v7: take the R3 trades again. The v6 block is removed, so R3 is traded like any other pivot — it can be the major resistance for setup A and is back among setup B's cross candidates.",
    "v8: the SL starts trailing at 1:2 instead of 1:3. Once 1:2 is achieved the SL moves to 550, and from then on it follows one step behind — 1650 trails it to 1100, 2200 to 1650, 2750 to 2200.",
    "v9: instead of fixed percentage change, we get the Daily Average Range of the stock and based on it we conclude the retracement %, and only if it is met do we take the entry. Both numbers use it — the zone near the 21 EMA (was 0.4%) is 0.15 × the 14-day ADR, the turn to enter (was 0.2%) is 0.075 × ADR — calibrated so the typical stock (ADR 2.72%) behaves as before. Backtested as A-ADR / B-ADR / C-ADR before going live.",
    "v10: for the R1, R3, S1, S3 we only take trades whose skew is 5x or more; less than that we won't take it. For R2, S2 and P any skew. The major level is still the closest-gap one, among the levels that qualify. Setup B's crossed levels are unchanged. Backtested as A-SK / B-SK / C-SK before going live.",
    "v11: skip the trade when one price step of the contract, across the lot, costs more than 110 (a fifth of the 550 risk) - one tick of slippage there is too large a share of the risk.",
  ],

  setups: [
    {
      id: "A",
      label: "Break & retrace",
      side: "LONG",
      requires: "majorResistance",
      description:
        "Price crossed above the major resistance (least gap; call skew ≥ 5x if R1 or R3, any skew if R2 or P), pulled back to within 0.15 ADR of the 21 EMA, then turned up 0.075 ADR off that low (ADR = the stock's 14-session average daily range).",
    },
    {
      id: "B",
      label: "Support hold & level cross",
      side: "LONG",
      requires: "majorSupport",
      description:
        "Price is holding above the major support (least gap; put skew ≥ 5x if S1 or S3, any skew if S2 or P), crossed up through another confirmed level, and is above the 21 EMA.",
    },
  ],

  params: {
    ...SHARED_PARAMS,
    /*
     * v10: the major level's skew bar is per pivot (PIVOT_MIN_SKEW above). The
     * 4x / 5x per-side bars are gone rather than left in, so the stored record
     * never shows a threshold this version does not apply.
     *
     * v7 removed the v6 R3 block. R3 is traded like any other pivot — it can win
     * the major-resistance pick for setup A and it is among setup B's cross
     * candidates. No `excludedPivots` means none.
     */
    pivotMinSkew: PIVOT_MIN_SKEW,
  },

  risk: SHARED_RISK,
};

/** Strategy 2 — the short. Break the major support, rally to the 21 EMA, roll over. */
export const BREAKDOWN_RETRACE_21EMA: StrategyDefinition = {
  id: "breakdown-retrace-21ema",
  version: 7,
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
    "v3: ends at 1:00 PM — no entries after that. A trade already running is left open and managed by the ordinary rules; 15:15 stays only as the end-of-day backstop.",
    "v4: the SL starts trailing at 1:2 instead of 1:3. Once 1:2 is achieved the SL moves to 550, and from then on it follows one step behind — same ladder as the long rule.",
    "v5: instead of fixed percentage change, we get the Daily Average Range of the stock and based on it we conclude the retracement %, and only if it is met do we take the entry. The rally into the 21 EMA zone (was 0.4%) is 0.15 × the 14-day ADR, the roll-over to enter (was 0.2%) is 0.075 × ADR — same as the long rule.",
    "v6: the major support needs a put skew of 5x or more if it is S1 or S3; S2 and P qualify at any skew. The closest-gap qualifying level is the major — same per-pivot rule as the long. Backtested as C-SK before going live.",
    "v7: skip the trade when one price step of the contract, across the lot, costs more than 110 - same as the long rule.",
  ],

  setups: [
    {
      id: "C",
      label: "Breakdown & retrace",
      side: "SHORT",
      requires: "majorSupport",
      description:
        "Price broke below the major support (least gap; put skew ≥ 5x if S1 or S3, any skew if S2 or P), rallied back to within 0.15 ADR of the 21 EMA, then rolled over 0.075 ADR off that high (ADR = the stock's 14-session average daily range).",
    },
  ],

  params: {
    ...SHARED_PARAMS,
    /*
     * "Major support with highest priority point" is the same level the long
     * rule calls major: least gap between pivot and strike, among the supports
     * that clear their pivot's skew bar (v6: PIVOT_MIN_SKEW, shared with the long
     * so the two cannot drift).
     */
    pivotMinSkew: PIVOT_MIN_SKEW,
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
