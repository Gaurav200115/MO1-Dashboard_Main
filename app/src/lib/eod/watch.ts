import { gapPct, inBand } from "./confluence";
import type { PivotLabel } from "./pivots";
import type { EodReport, SpecialStock } from "./types";

/**
 * Stocks that produced at least one confirmed level. The report also carries the
 * ones that produced none, which only the verification pass cares about.
 */
export function confirmedStocks(report: EodReport | null): SpecialStock[] {
  return report ? report.stocks.filter((stock) => stock.levels.length > 0) : [];
}

/** The key a level is tracked and deduped by, in one place so it cannot drift. */
export function levelId(symbol: string, pivot: PivotLabel): string {
  return `${symbol}:${pivot}`;
}

/**
 * The second stage of the funnel: of the stocks that survived the overnight
 * confluence test, the ones live price has actually arrived at — within
 * BAND_MAX_PCT of a confirmed level right now.
 *
 * This is measured against the live tape, not the previous close, so membership
 * changes through the session as price moves.
 */
export function currentStocks(report: EodReport | null, armed: Set<string>): SpecialStock[] {
  if (!report) return [];
  return report.stocks.filter((stock) =>
    stock.levels.some((level) => armed.has(levelId(stock.symbol, level.pivot)))
  );
}

/**
 * One confirmed level, flattened out of the report so the live tape can be
 * checked against it without walking the nested shape on every batch.
 *
 * The level being watched is the *pivot*, not the option strike. The strike is
 * what corroborated it; the pivot is the precise price the level sits at.
 */
export interface WatchLevel {
  /** Stable across renders and reports — also the alert dedupe key. */
  id: string;
  symbol: string;
  name: string;
  sector: string;
  pivot: PivotLabel;
  kind: "support" | "resistance";
  value: number;
  strike: number;
}

export function watchLevels(report: EodReport | null): WatchLevel[] {
  if (!report) return [];

  const levels: WatchLevel[] = [];
  for (const stock of report.stocks) {
    for (const level of stock.levels) {
      levels.push({
        id: levelId(stock.symbol, level.pivot),
        symbol: stock.symbol,
        name: stock.name,
        sector: stock.sector,
        pivot: level.pivot,
        kind: level.kind,
        value: level.pivotValue,
        strike: level.strike,
      });
    }
  }
  return levels;
}

/**
 * The same band the EOD confluence test used, now measured from live price to
 * the confirmed level. Being a band rather than a ceiling makes this an
 * approach warning: it arms while price is closing in and falls quiet once
 * price is effectively at the level.
 */
export function isArmed(ltp: number, level: number): boolean {
  if (!Number.isFinite(ltp) || ltp <= 0 || !Number.isFinite(level) || level <= 0) return false;
  return inBand(gapPct(ltp, level));
}
