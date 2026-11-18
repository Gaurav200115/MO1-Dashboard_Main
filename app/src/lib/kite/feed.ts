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

/** How often the feed checks the stored Kite session is still good. */
const SESSION_CHECK_MS = 60_000;
/** Reconnect backoff: 5s, 10s, 20s, 40s, then every 60s. */
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;

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

  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;

  constructor() {
    // All unreffed so they never hold the process open by themselves.
    setInterval(() => this.flush(), FLUSH_MS).unref();
    setInterval(() => void this.persist(), PERSIST_MS).unref();
    setInterval(() => void this.watchSession(), SESSION_CHECK_MS).unref();
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
    this.reconnectAttempts = 0;
    return this.ensureStarted();
  }

  /**
   * Kite kills every token at 06:00 IST, but a socket opened the day before can
   * stay up past it - and the status only ever came from the socket, so the
   * desk went on showing "Live" and never offered the sign-in. Checked once a
   * minute: with no valid session the socket is closed and the status says so,
   * which is what puts "Connect Kite" back on the desk.
   */
  private async watchSession(): Promise<void> {
    if (this.status === "no-session" || this.status === "unconfigured") return;
    // Never started in this process: the first request will start it and read
    // the session then.
    if (!this.ticker && !this.reconnectTimer && this.status === "stopped") return;
    if (await readSession()) return;
    this.teardown("Kite session expired");
    this.setStatus("no-session", "The Kite session expired at 06:00 IST — sign in again");
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

    /*
     * Never the library's own reconnect. Its retry path ends in
     * `process.exit(1)` - once it runs out of attempts, and at once after any
     * deliberate disconnect, because disconnect() clears a module-wide flag that
     * nothing ever sets back. That is what took the whole desk down on every
     * Kite sign-in (the sign-in closes the old socket) and on any later blip.
     * The feed reconnects itself instead, and re-reads the session each time.
     */
    ticker.autoReconnect(false);

    /*
     * The library keeps its listeners in one module-wide list, so every socket
     * the process has ever opened is still listening. Each handler checks it
     * belongs to the current one; a late event from an old socket does nothing.
     */
    ticker.on("connect", () => {
      if (this.ticker !== ticker) return;
      this.reconnectAttempts = 0;
      ticker.subscribe(this.tokens);
      ticker.setMode("quote", this.tokens);
      this.setStatus("live", null);
    });

    ticker.on("ticks", (ticks: Tick[]) => {
      if (this.ticker === ticker) this.ingest(ticks);
    });

    // A 403 from an expired token surfaces here, not as a clean close.
    ticker.on("error", (err) => {
      if (this.ticker === ticker) this.setStatus("error", message(err));
    });

    /*
     * "disconnect", not "close". The library fires "close" to every listener for
     * every socket - including the old one a sign-in has just shut, which would
     * read as the new socket dropping. It fires "disconnect" only for the socket
     * that is current, and also when its read timer gives up on a silent one.
     */
    ticker.on("disconnect", () => this.dropped(ticker, "Socket dropped"));

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

  /**
   * The current socket went away on its own. Reconnects with backoff, through a
   * fresh start - which re-reads the session, so an expired token ends at
   * "no-session" and the desk's Connect Kite rather than retrying forever.
   */
  private dropped(ticker: Ticker, reason: string): void {
    if (this.ticker !== ticker) return;
    this.ticker = null;
    this.scheduleReconnect(reason);
  }

  private scheduleReconnect(reason: string): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.setStatus("reconnecting", `${reason} — retrying in ${Math.round(delay / 1000)}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureStarted().then((state) => {
        if (state.status === "error") this.scheduleReconnect(state.detail ?? "Start failed");
      });
    }, delay);
    this.reconnectTimer.unref();
  }

  private teardown(reason: string): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Detached before it is closed, so the close this causes is a late event
    // from a socket that is no longer ours, and is ignored.
    const ticker = this.ticker;
    this.ticker = null;
    if (ticker) {
      try {
        ticker.disconnect();
      } catch {
        // already down
      }
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
