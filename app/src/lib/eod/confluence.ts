import type { OiLevel } from "./oi";
import type { PivotLabel, PivotLevel } from "./pivots";

/**
 * Two independent methods agreeing on the same price is the whole signal here.
 * A Fibonacci pivot is derived purely from the last session's range; an OI
 * strike is derived purely from where writers placed their risk. Neither knows
 * about the other, so when they land on the same price the level is worth more
 * than either alone.
 *
 * Measured against the pivot value. Past BAND_MAX the two are describing
 * different levels; below that, closer is strictly better — a strike sitting
 * almost exactly on a pivot is the strongest form of the agreement, not a
 * degenerate case, so there is no lower floor.
 */
export const BAND_MIN_PCT = 0;
export const BAND_MAX_PCT = 0.8;

/**
 * Inside this, the pivot and the strike are effectively the same price. Those
 * are flagged rather than filtered — the two methods have landed on one number.
 */
export const PRECIOUS_PCT = 0.3;

export interface ConfirmedLevel {
  pivot: PivotLabel;
  pivotValue: number;
  kind: "support" | "resistance";
  strike: number;
  callOi: number;
  putOi: number;
  ratio: number | null;
  /** Distance from the strike to the pivot, as a percentage of the pivot. */
  gapPct: number;
  /** Pivot and strike agree to within PRECIOUS_PCT — the tightest class of match. */
  precious: boolean;
  /**
   * Distance from the last close to the level. The confluence test says a level
   * is real; this says whether it is within reach of being tested — a level 5%
   * away cannot be touched in one session, and the live alert band (0.3-0.8%
   * from price) cannot even arm until price has travelled most of the way there.
   */
  reachPct: number;
}

/** Absolute distance from `value` to `reference`, as a percentage of the reference. */
export function gapPct(value: number, reference: number): number {
  return (Math.abs(value - reference) / reference) * 100;
}

export function inBand(gap: number): boolean {
  return gap >= BAND_MIN_PCT && gap <= BAND_MAX_PCT;
}

/**
 * Greedy tightest-first pairing, where each pivot and each strike may be used
 * once.
 *
 * The one-use-per-strike half matters: Fibonacci levels sit close together (R1
 * and R2 are only 0.236 of the range apart), so a single strike routinely falls
 * in band of two of them. Letting it confirm both would report one piece of
 * evidence as two independent signals.
 *
 * Sides never cross — a call-heavy strike can only confirm a resistance, a
 * put-heavy strike only a support.
 */
export function confirmLevels(
  pivots: PivotLevel[],
  levels: OiLevel[],
  close: number
): ConfirmedLevel[] {
  const pairs: { pivot: PivotLevel; level: OiLevel; gap: number }[] = [];

  for (const pivot of pivots) {
    if (!Number.isFinite(pivot.value) || pivot.value <= 0) continue;
    for (const level of levels) {
      if (level.kind !== pivot.kind) continue;
      const gap = gapPct(level.strike, pivot.value);
      if (inBand(gap)) pairs.push({ pivot, level, gap });
    }
  }

  pairs.sort((a, b) => a.gap - b.gap);

  const usedPivots = new Set<string>();
  const usedStrikes = new Set<number>();
  const confirmed: ConfirmedLevel[] = [];

  for (const { pivot, level, gap } of pairs) {
    if (usedPivots.has(pivot.label) || usedStrikes.has(level.strike)) continue;
    usedPivots.add(pivot.label);
    usedStrikes.add(level.strike);

    confirmed.push({
      pivot: pivot.label,
      pivotValue: pivot.value,
      kind: pivot.kind,
      strike: level.strike,
      callOi: level.callOi,
      putOi: level.putOi,
      ratio: level.ratio,
      gapPct: gap,
      precious: gap < PRECIOUS_PCT,
      reachPct: gapPct(pivot.value, close),
    });
  }

  return confirmed;
}
