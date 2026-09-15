import type { ConfirmedLevel } from "@/lib/eod/confluence";
import type { EodReport, SpecialStock } from "@/lib/eod/types";
import type { StrategyParams, TriggerLevel } from "./types";

/**
 * Turning the overnight report into the handful of prices one strategy watches.
 *
 * The report already holds the levels both methods agreed on. What the rule adds
 * on top is a notion of which of them is *major*: the one with the least gap
 * between pivot and strike, among those whose option skew clears a threshold.
 * "Least gap" is the tightest agreement between the two methods; the skew is how
 * lopsidedly writers have committed to that side.
 */

/**
 * Dominant side over the other, always >= 0 and oriented to the level's own kind.
 *
 * ConfirmedLevel.ratio is always calls/puts, which reads the wrong way round for
 * a support — a strong support has a ratio near zero, not a large one. Inverting
 * it here keeps "skew above 5x" meaning the same thing on both sides, which is
 * what the rule says.
 *
 * Infinity for a one-sided strike: no open interest at all on the losing side is
 * the strongest form of the imbalance, not a missing measurement.
 */
export function skewOf(level: Pick<ConfirmedLevel, "kind" | "callOi" | "putOi">): number {
  const dominant = level.kind === "support" ? level.putOi : level.callOi;
  const other = level.kind === "support" ? level.callOi : level.putOi;
  if (other <= 0) return dominant > 0 ? Number.POSITIVE_INFINITY : 0;
  return dominant / other;
}

/** Infinity does not survive JSON, so a one-sided strike is stored as null. */
export function storableSkew(level: ConfirmedLevel): number | null {
  const skew = skewOf(level);
  return Number.isFinite(skew) ? skew : null;
}

export function toTriggerLevel(level: ConfirmedLevel): TriggerLevel {
  return {
    pivot: level.pivot,
    kind: level.kind,
    value: level.pivotValue,
    strike: level.strike,
    skew: storableSkew(level),
    gapPct: level.gapPct,
  };
}

/**
 * The prices one stock is watched at for one strategy.
 *
 * `marked` is every level the overnight scan confirmed — the rule's phrase "that
 * we have marked as important from the OI and pivots" is exactly this set, so it
 * is not re-filtered by skew. Only the two *major* levels carry the threshold.
 */
export interface SymbolPlan {
  symbol: string;
  name: string;
  sector: string;
  /** Previous session's official close — where price started the day relative to each level. */
  close: number;
  majorResistance: ConfirmedLevel | null;
  majorSupport: ConfirmedLevel | null;
  marked: ConfirmedLevel[];
}

/**
 * Least gap wins; skew is the gate, not the ranking.
 *
 * Taking the tightest agreement rather than the strongest skew is the rule as
 * written, and it is also the more defensible of the two: the gap is a distance
 * between two independent estimates of the same price, while the skew is a raw
 * open-interest ratio that runs to 10x or more on thin strikes for reasons that
 * have nothing to do with conviction.
 */
function pickMajor(levels: ConfirmedLevel[], kind: ConfirmedLevel["kind"], minSkew: number) {
  let best: ConfirmedLevel | null = null;
  for (const level of levels) {
    if (level.kind !== kind) continue;
    if (skewOf(level) < minSkew) continue;
    if (!best || level.gapPct < best.gapPct) best = level;
  }
  return best;
}

export function planForStock(stock: SpecialStock, params: StrategyParams): SymbolPlan | null {
  if (stock.levels.length === 0) return null;

  const majorResistance = pickMajor(stock.levels, "resistance", params.resistanceSkew);
  const majorSupport = pickMajor(stock.levels, "support", params.supportSkew);

  // Neither leg of the rule can arm without a major level to anchor on.
  if (!majorResistance && !majorSupport) return null;

  return {
    symbol: stock.symbol,
    name: stock.name,
    sector: stock.sector,
    close: stock.session.close,
    majorResistance,
    majorSupport,
    marked: stock.levels,
  };
}

export interface WatchPlan {
  /** Session the levels were derived from. */
  basedOn: string;
  /** Session they are meant to be traded on. */
  tradingFor: string;
  plans: SymbolPlan[];
}

export function buildWatchPlan(report: EodReport, params: StrategyParams): WatchPlan {
  const plans: SymbolPlan[] = [];
  for (const stock of report.stocks) {
    const plan = planForStock(stock, params);
    if (plan) plans.push(plan);
  }
  return { basedOn: report.basedOn, tradingFor: report.computedFor, plans };
}

/**
 * Setup B's cross candidates: every marked level except the major support the
 * setup is standing on. Excluding it matters — "crosses another support or the
 * resistance point" is explicit that the level crossed is a different one, and
 * without the exclusion price merely wobbling around its own support would
 * register as a break of it.
 */
export function crossCandidates(plan: SymbolPlan): ConfirmedLevel[] {
  const basis = plan.majorSupport;
  if (!basis) return plan.marked;
  return plan.marked.filter((level) => level.pivot !== basis.pivot);
}
