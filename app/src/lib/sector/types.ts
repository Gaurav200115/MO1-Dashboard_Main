/**
 * The stored sector index — types only, so client components can import them
 * without dragging node:fs into the browser bundle (same split as eod/types.ts).
 */

/** The whole-universe index the sectors are measured against. */
export const BENCHMARK = "Nifty 200";

/** Level every series starts at on its base date, and nothing resets it after. */
export const BASE_LEVEL = 1000;

/** One session of one index. */
export interface SectorBar {
  /** IST date of the session, YYYY-MM-DD. */
  date: string;
  /** Chained level — continues from the previous session, never rebased. */
  level: number;
  /** Session return in percent, the thing the chain is built from. */
  changePct: number;
  /** Constituents that carried a usable close on both this day and the last. */
  priced: number;
  /** Constituents in the sector on that day, priced or not. */
  members: number;
  advances: number;
  declines: number;
  /** Members trading above their own 50 / 200 session average. Null until deep enough. */
  above50: number | null;
  above200: number | null;
  /** Traded value for the session in rupees crore, summed over constituents. */
  turnover: number | null;
}

export interface SeriesMeta {
  /** Where the chain starts. Every level in the file descends from this. */
  base: { date: string; level: number };
  from: string;
  to: string;
  builtAt: number;
  /** Symbols that carried an index weight at least once. */
  universe: number;
  /**
   * Constituent-days rejected by the corporate-action guard. Kite adjusts its
   * daily candles for splits and bonuses, so a number above zero here is worth
   * looking at rather than ignoring.
   */
  droppedOutliers: number;
  method: string;
  /**
   * What the chain was built from.
   *
   * "candles" is the real thing — a year of daily candles for the whole
   * universe. "eod-reports" is the provisional seed seen while waiting for a
   * Kite session: it reaches back only as far as the stored EOD reports and
   * covers only the F&O names those reports scanned, so it is a working chain
   * rather than a history. The daily job replaces a provisional chain outright
   * instead of extending it, so this field decides whether the next signed-in
   * run appends or rebuilds.
   */
  source: "candles" | "eod-reports";
}

export interface SectorSeries {
  meta: SeriesMeta;
  /** The trading calendar the bars are aligned to, oldest first. */
  dates: string[];
  /** Sector name -> bars, oldest first. Includes BENCHMARK. */
  sectors: Record<string, SectorBar[]>;
}

/** Closing level per index on the last stored session — what the live desk chains from. */
export interface ChainAnchor {
  date: string;
  levels: Record<string, number>;
}
