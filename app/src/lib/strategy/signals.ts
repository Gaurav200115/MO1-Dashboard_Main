import type { ConfirmedLevel } from "@/lib/eod/confluence";
import { nearEma } from "./ema";
import { crossCandidates, type SymbolPlan } from "./levels";
import type { PhaseA, PhaseB, SetupId, StrategyParams } from "./types";

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

  /** Setup B — holding above the major support, crossing some other level. */
  phaseB: PhaseB;
  /** Pivot label -> was price below this level on the previous read. */
  below: Map<string, boolean>;

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
  return {
    symbol: plan.symbol,
    phaseA: resistance ? (plan.close < resistance.pivotValue ? "below" : "idle") : "idle",
    crossedAt: null,
    crossPrice: null,
    highSinceCross: 0,
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
  if (resistance && state.phaseA !== "spent") {
    const level = resistance.pivotValue;

    if (state.phaseA === "idle" && ltp < level) {
      // Price came back under the level, so a fresh break is now observable.
      state.phaseA = "below";
    } else if (state.phaseA === "below" && ltp > level) {
      state.phaseA = "crossed";
      state.crossedAt = at;
      state.crossPrice = ltp;
      state.highSinceCross = ltp;
    } else if (state.phaseA === "crossed") {
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
        input.lastBarClose < ema * (1 - params.emaProximityPct / 100);

      if (broke) {
        state.phaseA = ltp < level ? "below" : "idle";
        state.crossedAt = null;
        state.crossPrice = null;
        state.highSinceCross = 0;
      } else if (ema == null) {
        state.note = "EMA warming";
      } else if (!nearEma(ltp, ema, params.emaProximityPct)) {
        state.note = "waiting for retrace";
      } else if (!retraced(state, ltp, params)) {
        /*
         * Price at the EMA is not the same event as price having come back to
         * it. If a break stalls and goes sideways, the EMA rises into the price
         * and the proximity test starts passing without any retrace having
         * happened. Requiring price to be a band below its own post-break high
         * is what separates "pulled back" from "was caught up with".
         */
        state.note = "EMA caught up, no pullback";
      } else if (input.entriesOpen && canTrade(state, params)) {
        state.phaseA = "spent";
        return {
          setup: "A",
          symbol: plan.symbol,
          spot: ltp,
          ema,
          level: resistance,
          basis: null,
          crossedAt: state.crossedAt,
          at,
        };
      }
    }
  }

  // --- Setup B: hold above the major support, cross another marked level ----
  const support = plan.majorSupport;
  let fired: Signal | null = null;

  if (support && state.phaseB === "watching") {
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

  return fired;
}

/**
 * Did price actually come back down to the EMA, as opposed to the EMA rising to
 * meet a price that never moved? Measured against the high since the break, one
 * proximity band's worth — the smallest move that is not just noise at the scale
 * the rest of the rule works at.
 */
function retraced(state: SymbolState, ltp: number, params: StrategyParams): boolean {
  if (state.highSinceCross <= 0) return false;
  const pullback = ((state.highSinceCross - ltp) / state.highSinceCross) * 100;
  return pullback >= params.emaProximityPct;
}

function canTrade(state: SymbolState, params: StrategyParams): boolean {
  return state.tradesToday < params.maxTradesPerSymbolPerDay;
}
