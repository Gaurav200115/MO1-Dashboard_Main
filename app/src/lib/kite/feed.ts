import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { KiteTicker } from "kiteconnect";
import type { Tick, Ticker } from "kiteconnect";
import type { Quote } from "@/lib/types";
import { FLUSH_MS, readConfig, RUNTIME_DIR } from "./config";
import { resolveInstruments } from "./instruments";
import { readSession } from "./session";

export type FeedStatus =
  | "unconfigured"
  | "no-session"
  | "connecting"
  | "live"
  | "reconnecting"
  | "stopped"
  | "error";

export interface FeedState {
  status: FeedStatus;
  detail: string | null;
  subscribed: number;
  unresolved: string[];
  lastTickAt: number | null;
}

export type FeedEvent =
  | { type: "quotes"; quotes: Quote[] }
  | { type: "state"; state: FeedState };

type Listener = (event: FeedEvent) => void;

/**
 * Fields quote mode actually delivers, which is more than the library type
 * admits — its QuoteTick declares neither volume nor average traded price, but
 * the 44-byte packet carries both at offsets 16 and 12.
 */
type WireTick = Tick & {
  ohlc?: { open: number; high: number; low: number; close: number };
  change?: number;
  volume_traded?: number;
  average_traded_price?: number;
  exchange_timestamp?: Date | null;
};

const PERSIST_MS = 30_000;

function quotesFile(): string {
  return path.resolve(process.cwd(), RUNTIME_DIR, "last-quotes.json");
}

function toQuote(symbol: string, tick: WireTick, now: number): Quote | null {
  const ltp = tick.last_price;
  if (typeof ltp !== "number" || !Number.isFinite(ltp)) return null;

  const ohlc = tick.ohlc;
  const close = ohlc && Number.isFinite(ohlc.close) && ohlc.close > 0 ? ohlc.close : null;

  // Derived from the previous close rather than trusting the library own
  // `change` field, so the number in the table always agrees with the price
  // sitting beside it.
  const change = close != null ? ltp - close : 0;
  const changePct = close != null ? (change / close) * 100 : 0;

  const stamped = tick.exchange_timestamp ? new Date(tick.exchange_timestamp).getTime() : NaN;

  return {
    symbol,
    ltp,
    change,
    changePct,
    ts: Number.isFinite(stamped) ? stamped : now,
    ohlc: ohlc ? { open: ohlc.open, high: ohlc.high, low: ohlc.low, close: ohlc.close } : null,
    volume: typeof tick.volume_traded === "number" ? tick.volume_traded : null,
    atp: typeof tick.average_traded_price === "number" ? tick.average_traded_price : null,
  };
}

/**
 * Owns the one upstream Kite socket for this process and fans it out to every
 * connected browser. Pinned to globalThis by `getFeed()` so Next dev-mode hot
 * reload re-attaches to the existing socket instead of opening a second one —
 * the API key only allows three.
 */
class KiteFeed {
  private ticker: Ticker | null = null;
  private starting: Promise<FeedState> | null = null;

  /** Latest quote per symbol. Overwritten freely; nothing re-renders on write. */
  private quotes = new Map<string, Quote>();
  /** Symbols touched since the last flush — the only thing we send downstream. */
  private dirty = new Set<string>();
  private listeners = new Set<Listener>();

  private tokenToSymbol = new Map<number, string>();
  private tokens: number[] = [];

  private status: FeedStatus = "stopped";
  private detail: string | null = null;
  private unresolved: string[] = [];
  private lastTickAt: number | null = null;

  private persistPending = false;
  private loadedCache = false;

  constructor() {
    // Both are unreffed so they never hold the process open by themselves.
    setInterval(() => this.flush(), FLUSH_MS).unref();
    setInterval(() => void this.persist(), PERSIST_MS).unref();
  }

  state(): FeedState {
    return {
      status: this.status,
      detail: this.detail,
      subscribed: this.tokens.length,
      unresolved: this.unresolved,
      lastTickAt: this.lastTickAt,
    };
  }

  snapshot(): Quote[] {
    return [...this.quotes.values()];
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Idempotent and safe to call from every request — concurrent callers await
   * the same start rather than racing to build competing tickers.
   */
  async ensureStarted(): Promise<FeedState> {
    if (this.ticker) return this.state();
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Called after a fresh login, when the old token is stale by definition. */
  async restart(): Promise<FeedState> {
    this.teardown("Restarting after sign-in");
    return this.ensureStarted();
  }

  private async start(): Promise<FeedState> {
    await this.loadCache();

    const config = readConfig();
    if (!config) {
      return this.setStatus("unconfigured", "Credentials missing from .env.local");
    }

    const session = await readSession();
    if (!session) {
      return this.setStatus("no-session", "Sign in to Kite to start the feed");
    }

    let map;
    try {
      map = await resolveInstruments(session.accessToken);
    } catch (err) {
      return this.setStatus("error", `Instrument lookup failed: ${message(err)}`);
    }

    this.unresolved = map.unresolved;
    this.tokenToSymbol = new Map(
      Object.entries(map.bySymbol).map(([symbol, token]) => [token, symbol])
    );
    this.tokens = Object.values(map.bySymbol);

    if (this.tokens.length === 0) {
      return this.setStatus("error", "No desk symbols resolved to NSE instruments");
    }

    const ticker = new KiteTicker({
      api_key: config.apiKey,
      access_token: session.accessToken,
    });
    ticker.autoReconnect(true, 50, 60);

    ticker.on("connect", () => {
      ticker.subscribe(this.tokens);
      ticker.setMode("quote", this.tokens);
      this.setStatus("live", null);
    });

    ticker.on("ticks", (ticks: Tick[]) => this.ingest(ticks));

    ticker.on("reconnect", (count, interval) => {
      this.setStatus("reconnecting", `Attempt ${count}, retrying in ${interval}s`);
    });

    ticker.on("noreconnect", () => {
      this.setStatus("error", "Reconnection attempts exhausted");
    });

    // A 403 from an expired token surfaces here, not as a clean close.
    ticker.on("error", (err) => this.setStatus("error", message(err)));

    ticker.on("close", () => {
      if (this.status !== "error") this.setStatus("stopped", "Socket closed");
    });

    this.ticker = ticker;
    this.setStatus("connecting", null);
    ticker.connect();
    return this.state();
  }

  private ingest(ticks: Tick[]): void {
    const now = Date.now();
    for (const tick of ticks) {
      const symbol = this.tokenToSymbol.get(tick.instrument_token);
      if (!symbol) continue;

      const quote = toQuote(symbol, tick as WireTick, now);
      if (!quote) continue;

      // Kite re-sends unchanged quotes; forwarding one would spend a render on a
      // table that would look identical.
      const previous = this.quotes.get(symbol);
      if (previous && previous.ltp === quote.ltp && previous.changePct === quote.changePct) {
        continue;
      }

      this.quotes.set(symbol, quote);
      this.dirty.add(symbol);
    }
    this.lastTickAt = now;
    this.persistPending = true;
  }

  /**
   * The coalescer. Ticks land on `quotes` at whatever rate the exchange sends
   * them; this hands the browser one batch of only-what-changed every FLUSH_MS,
   * capping the desk at two renders a second instead of a few hundred.
   */
  private flush(): void {
    if (this.dirty.size === 0 || this.listeners.size === 0) {
      this.dirty.clear();
      return;
    }
    const batch: Quote[] = [];
    for (const symbol of this.dirty) {
      const quote = this.quotes.get(symbol);
      if (quote) batch.push(quote);
    }
    this.dirty.clear();
    this.emit({ type: "quotes", quotes: batch });
  }

  private emit(event: FeedEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // one wedged listener must not stall the others
      }
    }
  }

  private setStatus(status: FeedStatus, detail: string | null): FeedState {
    this.status = status;
    this.detail = detail;
    const state = this.state();
    this.emit({ type: "state", state });
    return state;
  }

  private teardown(reason: string): void {
    if (this.ticker) {
      try {
        this.ticker.disconnect();
      } catch {
        // already down
      }
      this.ticker = null;
    }
    this.status = "stopped";
    this.detail = reason;
  }

  /** Lets the desk paint real prices after-hours and straight after a restart. */
  private async loadCache(): Promise<void> {
    if (this.loadedCache) return;
    this.loadedCache = true;
    try {
      const cached = JSON.parse(await readFile(quotesFile(), "utf8")) as Quote[];
      for (const quote of cached) {
        if (!this.quotes.has(quote.symbol)) this.quotes.set(quote.symbol, quote);
      }
    } catch {
      // no cache yet
    }
  }

  private async persist(): Promise<void> {
    if (!this.persistPending || this.quotes.size === 0) return;
    this.persistPending = false;
    try {
      await mkdir(path.dirname(quotesFile()), { recursive: true });
      await writeFile(quotesFile(), JSON.stringify(this.snapshot()));
    } catch {
      // the cache is a convenience; losing it costs one blank first paint
    }
  }
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "Unknown error";
}

const globalRef = globalThis as typeof globalThis & { __kiteFeed?: KiteFeed };

export function getFeed(): KiteFeed {
  globalRef.__kiteFeed ??= new KiteFeed();
  return globalRef.__kiteFeed;
}

export type { KiteFeed };
