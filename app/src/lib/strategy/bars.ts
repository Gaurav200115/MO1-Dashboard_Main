import type { Candle } from "@/lib/kite/history";
import { intradayCandles, NoSessionError } from "@/lib/kite/history";
import { getFeed } from "@/lib/kite/feed";
import { Ema } from "./ema";
import { IST_OFFSET_MS, istDate } from "./ist";

/**
 * Intraday bars for the tracked symbols, and the EMA that rides on them.
 *
 * Built from the live tick stream rather than polled from the historical
 * endpoint. Polling would be the obvious route and is the wrong one: the rule
 * needs a current 21 EMA on every stock it is watching, and refreshing ~100
 * symbols against Kite's 3 req/sec history limit takes 35 seconds a round — so
 * the EMA the signal reads would be up to half a bar stale, on a 5-minute bar,
 * in the one hour of the day the strategy is allowed to trade. The ticks are
 * already arriving for all 200 symbols at no extra cost; bucketing them is free.
 *
 * History is still used, once per symbol per day, to seed the EMA. A 21-period
 * average cannot be built out of a session that is nine bars old, so the warm-up
 * reaches back across previous sessions exactly as a chart would.
 */

const MINUTE_MS = 60_000;

/**
 * IST bar boundaries coincide with plain epoch boundaries, so no timezone maths
 * is needed to cut them: the offset is 5h30m, and 330 minutes divides by 5, 15
 * and 30. NSE's 09:15 open lands on an exact boundary for all three.
 */
function bucketStart(ms: number, intervalMinutes: number): number {
  const size = intervalMinutes * MINUTE_MS;
  return Math.floor(ms / size) * size;
}

/**
 * How long after a bucket ends before its bar is treated as closed. Exchange
 * timestamps arrive a beat behind the wall clock, and closing a bar early would
 * drop the last trades of it into the next one.
 */
const BAR_SETTLE_MS = 4_000;

export interface SymbolBars {
  symbol: string;
  /** Closed bars only, oldest first. The forming bar is never in here. */
  closed: Candle[];
  forming: Candle | null;
  ema: Ema;
  /** Null until the EMA has enough bars. */
  emaValue: number | null;
  /** EMA as at the previous closed bar — what a cross is measured against. */
  prevEmaValue: number | null;
  /** True once history has warmed the EMA. Signals must not fire before this. */
  seeded: boolean;
  seedError: string | null;
  /** IST date the seed was taken for, so a stale overnight seed is replaced. */
  seededFor: string | null;
}

export class BarEngine {
  private readonly symbols = new Map<string, SymbolBars>();
  private unsubscribe: (() => void) | null = null;
  private sweeper: NodeJS.Timeout | null = null;
  private readonly seeding = new Set<string>();

  constructor(
    private readonly intervalMinutes: number,
    private readonly emaPeriod: number
  ) {}

  /** How many bars of history to pull for the seed — comfortably over the period. */
  private get seedBars(): number {
    return this.emaPeriod * 4;
  }

  start(): void {
    if (this.unsubscribe) return;

    this.unsubscribe = getFeed().subscribe((event) => {
      if (event.type !== "quotes") return;
      for (const quote of event.quotes) this.ingest(quote.symbol, quote.ltp, quote.ts);
    });

    // A bucket that saw no trades is not a bar — Kite omits those too — so this
    // only closes buckets that actually printed. Without it an illiquid stock
    // that stops ticking would hold its bar open and freeze its EMA.
    this.sweeper = setInterval(() => this.sweep(), MINUTE_MS / 4);
    this.sweeper.unref();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  track(symbol: string): SymbolBars {
    let entry = this.symbols.get(symbol);
    if (!entry) {
      entry = {
        symbol,
        closed: [],
        forming: null,
        ema: new Ema(this.emaPeriod),
        emaValue: null,
        prevEmaValue: null,
        seeded: false,
        seedError: null,
        seededFor: null,
      };
      this.symbols.set(symbol, entry);
    }
    return entry;
  }

  get(symbol: string): SymbolBars | null {
    return this.symbols.get(symbol) ?? null;
  }

  tracked(): string[] {
    return [...this.symbols.keys()];
  }

  /** Tracked symbols whose EMA is warm and therefore safe to signal on. */
  readyCount(): number {
    let n = 0;
    for (const entry of this.symbols.values()) {
      if (entry.seeded && entry.emaValue != null) n += 1;
    }
    return n;
  }

  /**
   * Warms one symbol's EMA from history.
   *
   * Runs at background priority so it never sits in front of a chart request,
   * and is guarded against concurrent calls: the engine seeds its whole
   * watchlist at start-up, and a signal check arriving mid-warm-up must not
   * queue a second identical fetch.
   */
  async seed(symbol: string): Promise<SymbolBars> {
    const entry = this.track(symbol);
    const today = istDate();
    if (entry.seeded && entry.seededFor === today) return entry;
    if (this.seeding.has(symbol)) return entry;

    this.seeding.add(symbol);
    try {
      const candles = await intradayCandles(symbol, { background: true });

      // Anything still forming has to be excluded — its close is the last trade
      // so far, not the bar's close, and folding it in would put a provisional
      // value into the EMA that the next tick silently changes.
      const cutoff = bucketStart(Date.now(), this.intervalMinutes);
      const settled = candles.filter((candle) => candle.t < cutoff);
      if (settled.length < this.emaPeriod) {
        entry.seedError = `only ${settled.length} settled bars, need ${this.emaPeriod}`;
        return entry;
      }

      const warm = settled.slice(-this.seedBars);
      const ema = new Ema(this.emaPeriod);
      let previous: number | null = null;
      let value: number | null = null;
      for (const candle of warm) {
        previous = value;
        value = ema.push(candle.c);
      }

      entry.ema = ema;
      entry.emaValue = value;
      entry.prevEmaValue = previous;
      entry.closed = warm;
      entry.forming = null;
      entry.seeded = value != null;
      entry.seededFor = value != null ? today : null;
      entry.seedError = value == null ? "EMA did not warm" : null;
      return entry;
    } catch (err) {
      entry.seedError = err instanceof NoSessionError ? "no Kite session" : message(err);
      return entry;
    } finally {
      this.seeding.delete(symbol);
    }
  }

  private ingest(symbol: string, ltp: number, ts: number): void {
    const entry = this.symbols.get(symbol);
    if (!entry) return;
    if (!Number.isFinite(ltp) || ltp <= 0) return;

    // Exchange timestamps are used for bucketing but not trusted blindly: a
    // stale or absent stamp would file a live trade into a bar that has already
    // closed, which silently corrupts the EMA rather than failing.
    const now = Date.now();
    const stamp = Number.isFinite(ts) && Math.abs(now - ts) < 5 * MINUTE_MS ? ts : now;
    const start = bucketStart(stamp, this.intervalMinutes);

    const forming = entry.forming;
    if (forming && forming.t === start) {
      forming.h = Math.max(forming.h, ltp);
      forming.l = Math.min(forming.l, ltp);
      forming.c = ltp;
      return;
    }

    if (forming && start > forming.t) this.close(entry, forming);
    entry.forming = { t: start, o: ltp, h: ltp, l: ltp, c: ltp, v: 0 };
  }

  private sweep(): void {
    const boundary = bucketStart(Date.now() - BAR_SETTLE_MS, this.intervalMinutes);
    for (const entry of this.symbols.values()) {
      const forming = entry.forming;
      if (forming && forming.t < boundary) {
        this.close(entry, forming);
        entry.forming = null;
      }
    }
  }

  private close(entry: SymbolBars, bar: Candle): void {
    entry.closed.push(bar);
    // Only the last few bars are ever read, and an unbounded array across a
    // session for 100+ symbols is real memory.
    if (entry.closed.length > this.seedBars * 2) {
      entry.closed = entry.closed.slice(-this.seedBars);
    }
    entry.prevEmaValue = entry.emaValue;
    entry.emaValue = entry.ema.push(bar.c);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Bar timestamps are epoch ms; this is the IST label for one. */
export function barLabel(t: number): string {
  return new Date(t + IST_OFFSET_MS).toISOString().slice(11, 16);
}
