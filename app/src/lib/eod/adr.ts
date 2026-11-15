import { istDate } from "@/lib/strategy/ist";
import type { StockAdr } from "./types";

/**
 * Average Daily Range, from daily candles.
 *
 * The ADR-measured retrace (long v9 / short v5) sizes its EMA zone and its entry
 * turn in units of each stock's own daily range rather than a fixed percent of
 * price. This is the one place that range is computed, and it is the same
 * definition the backtest used to justify the change (app/scripts/backtest/
 * backtest/adr.py):
 *
 *   ADR% = mean over the last 14 completed sessions of (high − low) / close
 *
 * Taken in percent of each day's own close, not in rupees, so a split or bonus
 * inside the window cannot distort it — every day's range is on that day's own
 * scale. The strategy turns it into rupees with the previous official close.
 *
 * Pure and dependency-free, so the scan, the verification pass and the engine's
 * own fallback all compute it identically.
 */

/** Sessions in the window. A strategy that asks for another period computes its own. */
export const ADR_PERIOD = 14;

export interface DailyCandle {
  /** Epoch ms. */
  t: number;
  h: number;
  l: number;
  c: number;
}

/** One session's range as a percent of its close; null for a row that cannot be one. */
export function dailyRangePct(high: number, low: number, close: number): number | null {
  if (![high, low, close].every(Number.isFinite)) return null;
  if (close <= 0 || low <= 0 || high < low) return null;
  return ((high - low) / close) * 100;
}

/**
 * The ADR over the `period` sessions ending on `upTo` (an IST date, inclusive).
 *
 * `upTo` is always the session the levels were built from, never "today": during
 * market hours Kite serves the session in progress as a daily candle, and its
 * range so far is not a completed session's range. Filtering by date rather than
 * dropping "the last candle" is what keeps that true at any hour.
 *
 * Null unless there are `period` usable sessions — a stock with less history than
 * the window has no ADR, and is not given an invented one.
 */
export function adrFromCandles(
  candles: readonly DailyCandle[],
  upTo: string,
  period: number = ADR_PERIOD
): StockAdr | null {
  const rows: { date: string; range: number }[] = [];
  for (const candle of candles) {
    const date = istDate(candle.t);
    if (date > upTo) continue;
    const range = dailyRangePct(candle.h, candle.l, candle.c);
    if (range != null) rows.push({ date, range });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (rows.length < period) return null;

  const window = rows.slice(-period);
  const pct = window.reduce((sum, row) => sum + row.range, 0) / window.length;
  return { pct, period, from: window[0].date, to: window[window.length - 1].date };
}
