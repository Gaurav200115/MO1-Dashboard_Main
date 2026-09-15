/**
 * The report shape, kept apart from report.ts because that module reaches for
 * node:fs. The desk imports these types into client components, and a value
 * import from the filesystem layer would break the browser bundle.
 */

import type { ConfirmedLevel } from "./confluence";
import type { PivotSet } from "./pivots";

export interface SessionOhlc {
  date: string;
  high: number;
  low: number;
  close: number;
}

/** One strike's two-sided open interest, as read at the close. */
export interface ChainStrike {
  strike: number;
  callOi: number;
  putOi: number;
}

/**
 * Every stock the scan reached, whether or not it produced a confirmed level —
 * `levels` is empty for most of them.
 *
 * Non-qualifiers are kept because the verification pass needs them: a corrected
 * close moves the pivots, and a stock that confirmed nothing against provisional
 * pivots can confirm against final ones. Dropping them would make the repair
 * able only to remove levels, never to find the ones we missed.
 */
export interface SpecialStock {
  symbol: string;
  name: string;
  sector: string;
  session: SessionOhlc;
  pivots: PivotSet;
  /** Option expiry the open interest was read from. */
  expiry: string;
  atmStrike: number;
  levels: ConfirmedLevel[];
  /**
   * The full scanned ladder, not just the confirmed strikes. Open interest for a
   * finished session never changes, so this is what lets the pivots be corrected
   * later without re-spending 6,000 quote calls — and without reading an OI that
   * has since been contaminated by the next session's trading.
   */
  chain: ChainStrike[];
}

export interface EodReport {
  /** IST date of the completed session the levels were derived from. */
  basedOn: string;
  /** The session the levels are meant to be traded against — the next weekday. */
  computedFor: string;
  generatedAt: number;
  /**
   * When the session's OHLC was re-read after the exchange finalised it, and the
   * pivots recomputed if it had moved.
   *
   * Null means provisional. Kite's daily candle is still being consolidated on
   * the evening of the session — measured on 10 Sep, the close it served at
   * 23:00 differed from the official close for 154 of 163 stocks, by a median of
   * 0.31%, which is the width of the confluence band itself. So an evening scan
   * has to be treated as a draft until this pass has run.
   */
  verifiedAt: number | null;
  /** How many stocks the verification pass actually moved. */
  revised: number;
  params: {
    oiRatio: number;
    bandMinPct: number;
    bandMaxPct: number;
    /** Gap below which a pivot/strike match counts as precious. */
    preciousPct: number;
    strikeWindow: number;
  };
  stats: {
    withOptions: number;
    scanned: number;
    qualified: number;
    oiLevelsFound: number;
    failed: string[];
    durationMs: number;
  };
  stocks: SpecialStock[];
}
