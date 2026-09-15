import {
  BAND_MAX_PCT,
  BAND_MIN_PCT,
  confirmLevels,
  PRECIOUS_PCT,
} from "./confluence";
import { OI_RATIO, oiLevels } from "./oi";
import { fibPivots, pivotLevels } from "./pivots";
import { STRIKE_WINDOW } from "./chain";
import type { EodReport, SpecialStock } from "./types";

/**
 * Re-runs the pivots and the confluence test over a stored report using the
 * rule as it stands now, and nothing else.
 *
 * Pure — no network. Both inputs are already archived and neither can change
 * after the fact: the session's OHLC is settled, and a finished session's option
 * open interest is fixed. So when the rule moves (the band, the ratio, the
 * strike window), past days can be brought onto the new rule exactly, rather
 * than leaving a backtest sample spliced together from two different rules.
 *
 * The limit is coverage, not correctness: only stocks whose chain was archived
 * can be recomputed. A report written before the scan began keeping
 * non-qualifying stocks cannot gain stocks a wider band would now admit.
 */
export function recomputeReport(report: EodReport): EodReport {
  const stocks: SpecialStock[] = report.stocks.map((stock) => {
    if (!stock.chain || stock.chain.length === 0) return stock;

    const pivots = fibPivots(stock.session.high, stock.session.low, stock.session.close);
    if (!pivots) return { ...stock, levels: [] };

    const levels = confirmLevels(
      pivotLevels(pivots, stock.session.close),
      oiLevels(stock.chain),
      stock.session.close
    );
    levels.sort((a, b) => a.reachPct - b.reachPct);

    return { ...stock, pivots, levels };
  });

  stocks.sort((a, b) => nearestReach(a) - nearestReach(b));

  return {
    ...report,
    stocks,
    params: {
      oiRatio: OI_RATIO,
      bandMinPct: BAND_MIN_PCT,
      bandMaxPct: BAND_MAX_PCT,
      preciousPct: PRECIOUS_PCT,
      strikeWindow: STRIKE_WINDOW,
    },
    stats: {
      ...report.stats,
      qualified: stocks.filter((stock) => stock.levels.length > 0).length,
    },
  };
}

function nearestReach(stock: SpecialStock): number {
  if (stock.levels.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(...stock.levels.map((level) => level.reachPct));
}
