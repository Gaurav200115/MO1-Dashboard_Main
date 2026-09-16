import type { ConfirmedLevel } from "@/lib/eod/confluence";
import { nearEma } from "./ema";
import { crossCandidates, type SymbolPlan } from "./levels";
import type {
  PhaseA,
  PhaseB,
  PhaseC,
  Retracement,
  SetupId,
  StrategyParams,
} from "./types";

/**
 * The entry rules, as a state machine per stock.
 *
 * A machine rather than a predicate because both legs of the rule are about
 * *sequence*, not about a condition being true right now. "Below the level, then
 * crosses it, then retraces" cannot be answered from a single tick — price
 * sitting above a level says nothing about whether it ever crossed from below,
 * and the difference between those two is the whole setup.
 */

export interface SymbolState {
  symbol: string;

  /** Setup A — break the major resistance, then pull back to the EMA. */
  phaseA: PhaseA;
  crossedAt: number | null;
  crossPrice: number | null;
  /** Highest price seen since the break, so a real pullback can be required. */
  highSinceCross: number;
  /**
   * Lowest price reached since price entered the EMA zone, and when it got
   * there. This is the pivot the entry rebound is measured off, and it keeps
   * falling for as long as the pullback deepens — so the trigger always sits
   * 0.2% above wherever the retracement actually bottomed, not above wherever it
   * first happened to touch the zone.
   */
  zoneLow: number | null;
  zoneAt: number | null;

  /** Setup B — holding above the major support, crossing some other level. */
  phaseB: PhaseB;
  /** Pivot label -> was price below this level on the previous read. */
  below: Map<string, boolean>;

  /**
   * Setup C — the short. Mirror of A: break the major support downward, rally
   * back to the 21 EMA, then roll over off the high of that rally.
   */
  phaseC: PhaseC;
  brokeAt: number | null;
  /** Lowest price since the breakdown, so a real rally back can be required. */
  lowSinceBreak: number;
  /** Highest price reached inside the EMA zone — what the drop is measured off. */
  zoneHigh: number | null;
  zoneHighAt: number | null;

  lastLtp: number | null;
  tradesToday: number;
  /** Why the last evaluation did not produce a signal, for the status panel. */
  note: string | null;
}

export interface Signal {
  setup: SetupId;
  symbol: string;
  spot: number;
  ema: number;
  /** Setup A: the resistance broken. Setup B: the level crossed. */
  level: ConfirmedLevel;
  /** Setup B: the major support being held above. Null for setup A. */
  basis: ConfirmedLevel | null;
  /** Setup A: the pullback this entry was taken off. Null for setup B. */
  retracement: Retracement | null;
  crossedAt: number | null;
  at: number;
}

/**
 * Seeded from the previous session's official close rather than from the first
 * tick of the day.
 *
 * This is deliberate and it changes what the rule does. A stock that closed
 * below its major resistance and gaps open above it has crossed that level —
 * the cross happened in the auction — and seeding from the first tick would
 * class it as "was never below" and sit out the entire move. Seeding from the
 * close treats the gap as the break it is.
 */
export function initialState(plan: SymbolPlan): SymbolState {
  const below = new Map<string, boolean>();
  for (const level of plan.marked) below.set(level.pivot, plan.close < level.pivotValue);

  const resistance = plan.majorResistance;
  const support = plan.majorSupport;
  return {
    symbol: plan.symbol,
    phaseA: resistance ? (plan.close < resistance.pivotValue ? "below" : "idle") : "idle",
    crossedAt: null,
    crossPrice: null,
    highSinceCross: 0,
    zoneLow: null,
    zoneAt: null,
    phaseC: support ? (plan.close > support.pivotValue ? "above" : "idle") : "idle",
    brokeAt: null,
    lowSinceBreak: 0,
    zoneHigh: null,
    zoneHighAt: null,
    phaseB: plan.majorSupport ? "watching" : "idle",
    below,
    lastLtp: null,
    tradesToday: 0,
    note: null,
  };
}

export interface EvaluateInput {
  plan: SymbolPlan;
  state: SymbolState;
  params: StrategyParams;
  ltp: number;
  /** EMA from the last closed bar, or null while it is still warming. */
  ema: number | null;
  /** Close of the last bar to have closed, for the invalidation test. */
  lastBarClose: number | null;
  at: number;
  /** False after the entry cutoff — tracking continues, entries do not. */
  entriesOpen: boolean;
  /**
   * Which legs this strategy runs. The long rule and the short rule are separate
   * strategies with separate state, and each must only be able to fire its own.
   */
  setups: ReadonlySet<SetupId>;
}

/**
 * Advances one stock's state by one tick and returns a signal if one fired.
 *
 * Level tracking runs even when entries are closed or the EMA is still warming.
 * Skipping it would leave the machine in the wrong phase the moment it *is*
 * allowed to trade — a break that happened during warm-up is still a break.
 */
export function evaluateSymbol(input: EvaluateInput): Signal | null {
  const { plan, state, params, ltp, ema, at } = input;
  if (!Number.isFinite(ltp) || ltp <= 0) return null;

  state.lastLtp = ltp;
  state.note = null;

  // --- Setup A: break the major resistance, then retrace to the EMA ----------
  const resistance = plan.majorResistance;
  if (input.setups.has("A") && resistance && state.phaseA !== "spent") {
    const level = resistance.pivotValue;

    if (state.phaseA === "idle" && ltp < level) {
      // Price came back under the level, so a fresh break is now observable.
      state.phaseA = "below";
    } else if (state.phaseA === "below" && ltp > level) {
      state.phaseA = "crossed";
      state.crossedAt = at;
      state.crossPrice = ltp;
      state.highSinceCross = ltp;
    } else if (state.phaseA === "crossed" || state.phaseA === "retraced") {
      state.highSinceCross = Math.max(state.highSinceCross, ltp);

      /*
       * A closed bar decisively under the EMA ends the setup rather than
       * arming it. The rule wants a pullback that the EMA holds; price closing
       * through it is the pullback failing, and re-requiring a fresh break is
       * what stops one dead break from arming all afternoon.
       */
      const broke =
        ema != null &&
        input.lastBarClose != null &&
        input.lastBarClose < ema * (1 - params.emaZonePct / 100);

      if (broke) {
        state.phaseA = ltp < level ? "below" : "idle";
        state.crossedAt = null;
        state.crossPrice = null;
        state.highSinceCross = 0;
        state.zoneLow = null;
        state.zoneAt = null;
      } else if (ema == null) {
        state.note = "EMA warming";
      } else {
        /*
         * Two separate events, in order. Reaching the zone is the setup; turning
         * back up off the low of it is the trigger. Splitting them is the whole
         * point of the v2 change — entering on the touch buys into a pullback
         * that is still falling, and waiting for the rebound means the trade is
         * only taken once the EMA has actually held.
         */
        if (state.phaseA === "crossed") {
          if (!nearEma(ltp, ema, params.emaZonePct)) {
            state.note = "waiting for retrace";
          } else if (!retraced(state, ltp, params)) {
            /*
             * Price at the EMA is not the same event as price having come back
             * to it. If a break stalls and goes sideways, the EMA rises into the
             * price and the zone test starts passing without any retrace having
             * happened. Requiring price to be a band below its own post-break
             * high separates "pulled back" from "was caught up with".
             */
            state.note = "EMA caught up, no pullback";
          } else {
            state.phaseA = "retraced";
            state.zoneLow = ltp;
            state.zoneAt = at;
          }
        }

        if (state.phaseA === "retraced" && state.zoneLow != null) {
          // The pullback may deepen after it first reaches the zone; the rebound
          // is always measured from the lowest point it actually reached.
          if (ltp < state.zoneLow) state.zoneLow = ltp;

          const low = state.zoneLow;
          const trigger = low * (1 + params.entryReboundPct / 100);

          if (ltp < trigger) {
            state.note = `retraced to ${low.toFixed(2)}, needs ${showTrigger(trigger, "up")}`;
          } else if (ltp <= ema) {
            /*
             * The zone is two-sided so a wick through the EMA still counts as
             * reaching it, which means a rebound can trigger from below the
             * line. Requiring the entry itself to be above the EMA keeps a long
             * from being opened while price is still under it.
             */
            state.note = "rebounded but still under the EMA";
          } else if (input.entriesOpen && canTrade(state, params)) {
            state.phaseA = "spent";
            return {
              setup: "A",
              symbol: plan.symbol,
              spot: ltp,
              ema,
              level: resistance,
              basis: null,
              retracement: {
                extreme: low,
                emaGapPct: (Math.abs(low - ema) / ema) * 100,
                at: state.zoneAt ?? at,
                turnPct: ((ltp - low) / low) * 100,
              },
              crossedAt: state.crossedAt,
              at,
            };
          }
        }
      }
    }
  }

  // --- Setup B: hold above the major support, cross another marked level ----
  const support = plan.majorSupport;
  let fired: Signal | null = null;

  if (input.setups.has("B") && support && state.phaseB === "watching") {
    const holding = ltp > support.pivotValue;

    for (const level of crossCandidates(plan)) {
      const wasBelow = state.below.get(level.pivot) ?? plan.close < level.pivotValue;

      if (
        !fired &&
        holding &&
        wasBelow &&
        ltp > level.pivotValue &&
        ema != null &&
        ltp > ema &&
        input.entriesOpen &&
        canTrade(state, params)
      ) {
        fired = {
          setup: "B",
          symbol: plan.symbol,
          spot: ltp,
          ema,
          level,
          basis: support,
          retracement: null,
          crossedAt: at,
          at,
        };
      }

      state.below.set(level.pivot, ltp < level.pivotValue);
    }

    if (fired) state.phaseB = "spent";
    else if (!holding) state.note = state.note ?? "below major support";
  }

  // Keep the ladder's own memory current even when setup B is spent, so a later
  // strategy reading this state is not looking at a snapshot frozen at entry.
  if (!fired && state.phaseB !== "watching") {
    for (const level of plan.marked) state.below.set(level.pivot, ltp < level.pivotValue);
  }

  /* --- Setup C: break the major support, rally to the EMA, roll over --------
   *
   * The mirror image of setup A, and deliberately written as one rather than
   * folded into it with sign flips. Every comparison reverses — a break is
   * downward, the pullback is a rally, the confirmation is a drop, and the
   * invalidation is a close back *above* the EMA — and the version of this with
   * a `direction` multiplier scattered through it is the version where one
   * missed flip silently shorts a stock that is going up.
   */
  const shortBasis = plan.majorSupport;
  if (!fired && input.setups.has("C") && shortBasis && state.phaseC !== "spent") {
    const level = shortBasis.pivotValue;

    if (state.phaseC === "idle" && ltp > level) {
      state.phaseC = "above";
    } else if (state.phaseC === "above" && ltp < level) {
      state.phaseC = "broken";
      state.brokeAt = at;
      state.lowSinceBreak = ltp;
    } else if (state.phaseC === "broken" || state.phaseC === "retraced") {
      state.lowSinceBreak = Math.min(state.lowSinceBreak, ltp);

      // A bar closing back above the EMA is the breakdown failing.
      const reclaimed =
        ema != null &&
        input.lastBarClose != null &&
        input.lastBarClose > ema * (1 + params.emaZonePct / 100);

      if (reclaimed) {
        state.phaseC = ltp > level ? "above" : "idle";
        state.brokeAt = null;
        state.lowSinceBreak = 0;
        state.zoneHigh = null;
        state.zoneHighAt = null;
      } else if (ema == null) {
        state.note = "EMA warming";
      } else {
        if (state.phaseC === "broken") {
          if (!nearEma(ltp, ema, params.emaZonePct)) {
            state.note = "waiting for retrace";
          } else if (!rallied(state, ltp, params)) {
            state.note = "EMA came down, no rally";
          } else {
            state.phaseC = "retraced";
            state.zoneHigh = ltp;
            state.zoneHighAt = at;
          }
        }

        if (state.phaseC === "retraced" && state.zoneHigh != null) {
          if (ltp > state.zoneHigh) state.zoneHigh = ltp;

          const high = state.zoneHigh;
          const trigger = high * (1 - params.entryReboundPct / 100);

          if (ltp > trigger) {
            state.note = `retraced to ${high.toFixed(2)}, needs ${showTrigger(trigger, "down")}`;
          } else if (ltp >= ema) {
            state.note = "rolled over but still above the EMA";
          } else if (input.entriesOpen && canTrade(state, params)) {
            state.phaseC = "spent";
            return {
              setup: "C",
              symbol: plan.symbol,
              spot: ltp,
              ema,
              level: shortBasis,
              basis: null,
              retracement: {
                extreme: high,
                emaGapPct: (Math.abs(high - ema) / ema) * 100,
                at: state.zoneHighAt ?? at,
                turnPct: ((high - ltp) / high) * 100,
              },
              crossedAt: state.brokeAt,
              at,
            };
          }
        }
      }
    }
  }

  return fired;
}

/**
 * Renders a trigger price so the number shown would actually fire.
 *
 * Rounding to the nearest paise is wrong here in one direction: a long needing
 * 1206.909 displayed as "1206.91" is fine, but a short needing 1193.109 shown as
 * "1193.11" names a price a paise *above* the threshold, which would not
 * trigger. Round away from the level in each case instead.
 */
function showTrigger(price: number, towards: "up" | "down"): string {
  const rounded =
    towards === "up" ? Math.ceil(price * 100) / 100 : Math.floor(price * 100) / 100;
  return rounded.toFixed(2);
}

/**
 * The short's mirror of `retraced`: did price actually rally back up to the EMA,
 * as opposed to the EMA falling to meet a price that never moved?
 */
function rallied(state: SymbolState, ltp: number, params: StrategyParams): boolean {
  if (state.lowSinceBreak <= 0) return false;
  const rally = ((ltp - state.lowSinceBreak) / state.lowSinceBreak) * 100;
  return rally >= params.entryReboundPct;
}

/**
 * Did price actually come back down to the EMA, as opposed to the EMA rising to
 * meet a price that never moved? Measured against the high since the break, and
 * held to the same size as the entry rebound — a pullback smaller than the move
 * that would confirm it is not a pullback worth arming on.
 */
function retraced(state: SymbolState, ltp: number, params: StrategyParams): boolean {
  if (state.highSinceCross <= 0) return false;
  const pullback = ((state.highSinceCross - ltp) / state.highSinceCross) * 100;
  return pullback >= params.entryReboundPct;
}

function canTrade(state: SymbolState, params: StrategyParams): boolean {
  return state.tradesToday < params.maxTradesPerSymbolPerDay;
}
