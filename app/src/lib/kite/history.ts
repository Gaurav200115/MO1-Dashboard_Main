import { KiteConnect } from "kiteconnect";
import { requireConfig } from "./config";
import { historyGate } from "./gate";
import { resolveInstruments } from "./instruments";
import { readSession } from "./session";

export type Range = "1D" | "1W" | "1M" | "1Y";

export const RANGES: Range[] = ["1D", "1W", "1M", "1Y"];

type Interval = "5minute" | "day";

export interface Candle {
  /** Epoch ms, so it survives JSON without a Date revive step. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface HistoryResult {
  symbol: string;
  range: Range;
  interval: Interval;
  candles: Candle[];
  /** IST date of the session shown, for the 1D header. */
  session: string | null;
  cachedAt: number;
}

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const INTERVAL_FOR: Record<Range, Interval> = {
  "1D": "5minute",
  "1W": "day",
  "1M": "day",
  "1Y": "day",
};

/**
 * 1W, 1M and 1Y all want one point per day, so they share a single upstream
 * fetch of a year of daily candles and differ only in how far back they slice.
 * Switching between those three costs no network call at all.
 */
const SLICE_DAYS: Partial<Record<Range, number>> = { "1W": 7, "1M": 31 };

const FETCH_DAYS: Record<Interval, number> = { "5minute": 7, day: 365 };

/** Intraday moves all session; a year of daily candles changes once a day. */
const TTL_MS: Record<Interval, number> = { "5minute": 60_000, day: 6 * 60 * 60 * 1000 };

type CacheEntry = { candles: Candle[]; expires: number };

const globalRef = globalThis as typeof globalThis & {
  __kiteHistoryCache?: Map<string, CacheEntry>;
};

globalRef.__kiteHistoryCache ??= new Map();

const cache = globalRef.__kiteHistoryCache;

export function istDateString(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Kite wants naive IST wall-clock strings, not UTC or offsets. */
function istStamp(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 19).replace("T", " ");
}

export class NoSessionError extends Error {
  constructor() {
    super("Sign in to Kite to load charts");
    this.name = "NoSessionError";
  }
}

async function loadSeries(
  symbol: string,
  interval: Interval,
  opts?: { background?: boolean }
): Promise<Candle[]> {
  const key = `${symbol}:${interval}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.candles;

  const session = await readSession();
  if (!session) throw new NoSessionError();

  const map = await resolveInstruments(session.accessToken);
  const token = map.bySymbol[symbol];
  if (token == null) throw new Error(`${symbol} has no NSE instrument token`);

  const { apiKey } = requireConfig();
  const kc = new KiteConnect({ api_key: apiKey });
  kc.setAccessToken(session.accessToken);

  const now = Date.now();
  // Intraday reaches back a week rather than asking for "today": on a weekend, a
  // holiday, or before the 09:15 open, today alone would come back empty.
  const from = now - FETCH_DAYS[interval] * DAY_MS;

  const raw = await historyGate.run(
    () => kc.getHistoricalData(token, interval, istStamp(from), istStamp(now)),
    { background: opts?.background }
  );

  const candles: Candle[] = raw.map((row) => ({
    t: new Date(row.date).getTime(),
    o: row.open,
    h: row.high,
    l: row.low,
    c: row.close,
    v: row.volume,
  }));

  cache.set(key, { candles, expires: Date.now() + TTL_MS[interval] });
  return candles;
}

export async function fetchHistory(symbol: string, range: Range): Promise<HistoryResult> {
  const interval = INTERVAL_FOR[range];
  const series = await loadSeries(symbol, interval);

  let candles = series;
  let session: string | null = null;

  if (candles.length > 0) {
    if (interval === "5minute") {
      // Keep only the most recent session present, so 1D always means one day.
      session = istDateString(candles[candles.length - 1].t);
      candles = candles.filter((candle) => istDateString(candle.t) === session);
    } else {
      const window = SLICE_DAYS[range];
      if (window != null) {
        // Measured back from the last candle rather than from now, so a Monday
        // morning still shows the previous week instead of a single session.
        const cutoff = candles[candles.length - 1].t - window * DAY_MS;
        candles = candles.filter((candle) => candle.t >= cutoff);
      }
    }
  }

  return { symbol, range, interval, candles, session, cachedAt: Date.now() };
}

/**
 * A year of daily candles, oldest first. Shares the cache and the rate-limit
 * gate with the charts, so the EOD scan warms exactly what a chart would ask
 * for next — and runs at background priority so it never delays one.
 */
export function dailyCandles(
  symbol: string,
  opts?: { background?: boolean }
): Promise<Candle[]> {
  return loadSeries(symbol, "day", opts);
}

/**
 * A week of 5-minute candles, oldest first and *not* sliced to one session.
 *
 * fetchHistory("1D") keeps only the latest session because that is what a 1D
 * chart means. A moving average cannot be seeded that way — at 09:20 the current
 * session has one bar — so the strategy warm-up needs the unsliced series, which
 * reaches back across previous sessions the way a chart's own indicator does.
 */
export function intradayCandles(
  symbol: string,
  opts?: { background?: boolean }
): Promise<Candle[]> {
  return loadSeries(symbol, "5minute", opts);
}
