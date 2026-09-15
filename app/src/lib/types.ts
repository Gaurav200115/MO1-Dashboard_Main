export type Variant = "consolidated" | "standalone";

/** Row-level shape shipped in index.json — everything the table and leaders need. */
export interface CompanySummary {
  symbol: string;
  name: string;
  sector: string;
  variant: Variant;
  isBank: boolean;

  latestQuarter: string | null;
  nextQuarterEnd: string | null;
  /** SEBI LODR Reg 33 filing deadline — always known. */
  resultsDueBy: string | null;
  /** Confirmed board-meeting date from the NSE calendar; null until the poller runs. */
  resultsDate: string | null;

  price: number | null;
  mcap: number | null;
  bv: number | null;
  fv: number | null;
  hl: string | null;

  pe: number | null;
  pb: number | null;
  ps: number | null;
  pfcf: number | null;
  pocf: number | null;
  dy: number | null;
  ey: number | null;
  fcfy: number | null;
  roce: number | null;
  roe: number | null;

  /** Null for lenders — EV multiples are not meaningful there. */
  evEbitda: number | null;
  evEbitdaNet: number | null;
  evSales: number | null;

  shares: number | null;
}

export interface Statement {
  periods: string[];
  rows: Record<string, (number | null)[]>;
}

/** Full record in companies/{SYMBOL}.json — loaded on demand. */
export interface CompanyDetail extends CompanySummary {
  growth: Record<string, number | null>;
  series: Record<string, Statement>;
}

export interface DeskIndex {
  meta: {
    snapshot: string;
    source: string;
    latestQuarter: string;
    companies: number;
    sectors: number;
    calendarEntries: number;
  };
  sectors: Record<string, string[]>;
  companies: CompanySummary[];
}

/**
 * Live quote shape for the streaming layer, populated by the Zerodha KiteTicker
 * feed through /api/quotes/stream.
 *
 * `change` is in rupees and `changePct` in percent, both measured against the
 * previous close that quote mode carries in its OHLC block.
 */
export interface Quote {
  symbol: string;
  ltp: number;
  change: number;
  changePct: number;
  /** Exchange timestamp where the packet carried one, else time of receipt. */
  ts: number;
  /** Present in quote and full modes. `close` is the *previous* session close. */
  ohlc: { open: number; high: number; low: number; close: number } | null;
  volume: number | null;
  /** Volume-weighted average price for the day, used for sector turnover. */
  atp: number | null;
}

/**
 * A table row once the live feed has been folded in. `price` is overwritten with
 * the streaming LTP and `chg` added; every valuation multiple stays at its
 * screener.in snapshot value, so nothing on screen mixes a live numerator with
 * stale fundamentals.
 */
export interface LiveRow extends CompanySummary {
  chg?: number | null;
  live?: boolean;
}

export type MetricKey = keyof Pick<
  CompanySummary,
  "mcap" | "pe" | "pb" | "ps" | "evEbitda" | "dy" | "roce" | "roe" | "price" | "fcfy"
>;

export type SortKey = MetricKey | "symbol" | "name" | "due" | "chg";
