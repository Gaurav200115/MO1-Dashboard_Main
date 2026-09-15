/**
 * Fibonacci pivot points, computed from one completed session's range.
 *
 *   P  = (H + L + C) / 3
 *   R1 = P + 0.382 * (H - L)      S1 = P - 0.382 * (H - L)
 *   R2 = P + 0.618 * (H - L)      S2 = P - 0.618 * (H - L)
 *   R3 = P + 1.000 * (H - L)      S3 = P - 1.000 * (H - L)
 *
 * The close must be the exchange's official close, which is the last daily
 * candle's `c` — not a quote's `last_price`. Post-close trades move last_price
 * off the official close by a few tenths of a percent, and the confluence test
 * downstream resolves at 0.3%, so the two are not interchangeable here.
 */

export type PivotLabel = "R3" | "R2" | "R1" | "P" | "S1" | "S2" | "S3";

export interface PivotSet {
  p: number;
  r1: number;
  r2: number;
  r3: number;
  s1: number;
  s2: number;
  s3: number;
}

export interface PivotLevel {
  label: PivotLabel;
  value: number;
  /** Which side of the last close the level sits on. */
  kind: "support" | "resistance";
}

const R1_FIB = 0.382;
const R2_FIB = 0.618;

/**
 * Null when the session has no range — a stock locked at a circuit limit all
 * day collapses every level onto P, which would then "confirm" seven times over
 * against a single strike.
 */
export function fibPivots(high: number, low: number, close: number): PivotSet | null {
  if (![high, low, close].every((v) => Number.isFinite(v) && v > 0)) return null;
  const range = high - low;
  if (range <= 0) return null;

  const p = (high + low + close) / 3;
  return {
    p,
    r1: p + R1_FIB * range,
    r2: p + R2_FIB * range,
    r3: p + range,
    s1: p - R1_FIB * range,
    s2: p - R2_FIB * range,
    s3: p - range,
  };
}

/**
 * The central pivot has no fixed side: above it P acts as support, below it as
 * resistance. Every other level's role is fixed by construction.
 */
export function pivotLevels(set: PivotSet, close: number): PivotLevel[] {
  return [
    { label: "R3", value: set.r3, kind: "resistance" },
    { label: "R2", value: set.r2, kind: "resistance" },
    { label: "R1", value: set.r1, kind: "resistance" },
    { label: "P", value: set.p, kind: close >= set.p ? "support" : "resistance" },
    { label: "S1", value: set.s1, kind: "support" },
    { label: "S2", value: set.s2, kind: "support" },
    { label: "S3", value: set.s3, kind: "support" },
  ];
}
