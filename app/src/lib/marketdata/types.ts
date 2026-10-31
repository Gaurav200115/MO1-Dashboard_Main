/**
 * Shapes the /api/explorer route returns, shared by the route and the History analysis pages.
 * Prices are rupees. Bar times are seconds with IST folded in (a 09:15 IST bar reads 09:15 on a
 * chart axis that shows UTC), which is what lightweight-charts expects for a local-time axis.
 */

export type Timeframe = "1" | "5" | "15" | "60" | "D";

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface MonthSummary {
  /** "YYYY-MM" */
  month: string;
  selected: number;
  tradingDays: number;
}

export interface ExplorerOverview {
  months: MonthSummary[];
  /** First and last day with India VIX bars, null before the first download. */
  vix: { from: string; to: string } | null;
  /** First and last trading day of the downloaded range. */
  range: { from: string; to: string } | null;
}

export interface RankedStock {
  symbol: string;
  company: string | null;
  industry: string | null;
  rank: number;
  /** Median daily turnover, rupees, nearest monthly expiry ATM-3..ATM+3, over the ranking days. */
  turnover: number | null;
  atmOiLots: number | null;
  rankedFrom: string | null;
  rankedTo: string | null;
  /** Trading days of this month with option minute data. */
  optionDays: number;
}

export interface MonthDetail {
  month: string;
  days: string[];
  stocks: RankedStock[];
}

export interface OptionContract {
  expiry: string;
  strike: number;
  type: "CE" | "PE";
  bars: number;
  /** Minutes this strike was the at-the-money one. */
  atmMinutes: number;
  first: string;
  last: string;
}

export interface ChainRow {
  strike: number;
  ce: ChainSide | null;
  pe: ChainSide | null;
}

export interface ChainSide {
  close: number | null;
  oi: number;
  chgOi: number;
  contracts: number;
  turnover: number | null;
}

export interface ChainDay {
  symbol: string;
  date: string;
  expiry: string | null;
  expiries: string[];
  spot: number | null;
  future: { expiry: string; close: number | null; oi: number; chgOi: number } | null;
  lotSize: number | null;
  rows: ChainRow[];
  maxPain: number | null;
}

export type BuildUp = "Long build-up" | "Short build-up" | "Short covering" | "Long unwinding";

export interface OiDay {
  date: string;
  expiry: string | null;
  spot: number | null;
  ceOi: number;
  peOi: number;
  ceChg: number;
  peChg: number;
  pcr: number | null;
  maxPain: number | null;
  futClose: number | null;
  futOi: number | null;
  futChgOi: number | null;
  buildUp: BuildUp | null;
}

export type Reply<T> = { available: true; data: T } | { available: false; reason: string };
