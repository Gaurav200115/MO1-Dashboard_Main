import { dailyCandles, istDateString } from "@/lib/kite/history";
import { confirmLevels } from "./confluence";
import { oiLevels } from "./oi";
import { fibPivots, pivotLevels } from "./pivots";
import type { EodReport, SpecialStock } from "./types";

/**
 * Re-reads the settled session's OHLC once the exchange has finalised it and
 * recomputes every pivot that moved.
 *
 * Why this exists: the daily candle Kite serves on the evening of a session is
 * not final. It carries the last trade of the continuous session, and only
 * overnight does it consolidate to the official close, which is set in the
 * closing auction. Measured across the 10 Sep scan, 154 of 163 closes were
 * revised, median 0.31% — the same size as the 0.3-0.8% confluence band, and
 * enough to change the confirmed levels for half the universe.
 *
 * Open interest is deliberately *not* re-read. A finished session's OI is
 * already final, and by the time the candles are final the option chain has
 * either not moved or has started reflecting the next session — so the archived
 * chain is both cheaper and more correct than a fresh read.
 */
export async function verifyReport(report: EodReport): Promise<EodReport> {
  const stocks: SpecialStock[] = [];
  let revised = 0;

  for (const stock of report.stocks) {
    try {
      const candles = await dailyCandles(stock.symbol, { background: true });
      const candle = candles.find((c) => istDateString(c.t) === report.basedOn);

      if (
        !candle ||
        (candle.h === stock.session.high &&
          candle.l === stock.session.low &&
          candle.c === stock.session.close)
      ) {
        stocks.push(stock);
        continue;
      }

      const session = {
        date: stock.session.date,
        high: candle.h,
        low: candle.l,
        close: candle.c,
      };

      const pivots = fibPivots(session.high, session.low, session.close);
      if (!pivots) {
        stocks.push({ ...stock, session, levels: [] });
        revised += 1;
        continue;
      }

      const levels = confirmLevels(
        pivotLevels(pivots, session.close),
        oiLevels(stock.chain),
        session.close
      );
      levels.sort((a, b) => a.reachPct - b.reachPct);

      stocks.push({ ...stock, session, pivots, levels });
      revised += 1;
    } catch {
      // A symbol we cannot re-read keeps its provisional figures rather than
      // dropping out of the report entirely.
      stocks.push(stock);
    }
  }

  stocks.sort((a, b) => nearestReach(a) - nearestReach(b));

  return { ...report, stocks, verifiedAt: Date.now(), revised };
}

function nearestReach(stock: SpecialStock): number {
  if (stock.levels.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(...stock.levels.map((level) => level.reachPct));
}
