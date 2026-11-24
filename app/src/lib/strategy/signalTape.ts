import { getFeed, type TickWatcher, type WireTick } from "@/lib/kite/feed";
import { getDb, isConfigured } from "@/lib/mongo";
import type { StrategyTrade } from "./types";

/**
 * The 60 seconds of an option's prices after every signal, tick by tick.
 *
 * A measurement, nothing else: it places, changes and cancels no order, and
 * sends no request to Kite. It rides the websocket the desk already has open
 * (KiteFeed.watch) - never the /quote API, whose 1-request-a-second budget the
 * entry price and the stop watch depend on. Every failure is swallowed here.
 *
 * Why (24 Nov 2026): live IOC entries were being cancelled mostly on the trades
 * that went on to win. Before choosing a resting limit (TTL) and its cancel
 * levels - cancel once the price is X above our limit, or Y below the signal's
 * ask - this records what the book actually did in the minute a TTL order would
 * have been waiting, for paper and live alike. One document per trade in
 * `signal_ticks`, keyed by the trade id, beside its row in `live_orders`.
 */

export const TAPE_MS = 60_000;
/** A ceiling, not an expectation: a busy option prints a few hundred ticks a minute. */
const MAX_TICKS = 3_000;
const COLLECTION = "signal_ticks";

export interface TapeTick {
  /** When the desk received it. */
  at: number;
  /** The exchange's own stamp, when Kite sends one. */
  ex: number | null;
  ltp: number;
  bid: number | null;
  ask: number | null;
  volume: number | null;
}

export interface SignalTape {
  _id: string;
  tradeId: string;
  tradingDate: string;
  symbol: string;
  setup: string;
  tradingsymbol: string;
  token: number;
  /** What the entry was priced from: the ask at the signal, and the trade's R per unit. */
  signalAsk: number | null;
  riskPerUnit: number;
  qty: number;
  startedAt: number;
  endedAt: number;
  ticks: TapeTick[];
  truncated: boolean;
}

export interface TapeDeps {
  watch: (token: number, onTick: TickWatcher) => () => void;
  now: () => number;
  later: (ms: number, run: () => void) => void;
  save: (tape: SignalTape) => Promise<void>;
}

async function saveToMongo(tape: SignalTape): Promise<void> {
  if (!isConfigured()) return;
  const db = await getDb();
  if (!db) return;
  await db.collection<SignalTape>(COLLECTION).replaceOne({ _id: tape._id }, tape, { upsert: true });
}

const defaultDeps: TapeDeps = {
  watch: (token, onTick) => getFeed().watch(token, onTick),
  now: () => Date.now(),
  later: (ms, run) => {
    const timer = setTimeout(run, ms);
    timer.unref?.();
  },
  save: saveToMongo,
};

function positive(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) && x > 0 ? x : null;
}

export function toTapeTick(tick: WireTick, at: number): TapeTick | null {
  const ltp = positive(tick.last_price);
  if (ltp == null) return null;
  const ex = tick.exchange_timestamp ? new Date(tick.exchange_timestamp).getTime() : NaN;
  return {
    at,
    ex: Number.isFinite(ex) ? ex : null,
    ltp,
    bid: positive(tick.depth?.buy?.[0]?.price),
    ask: positive(tick.depth?.sell?.[0]?.price),
    volume: typeof tick.volume_traded === "number" ? tick.volume_traded : null,
  };
}

/**
 * Starts recording the trade's option for 60 seconds. Synchronous and cheap -
 * one websocket subscribe - so it can sit next to the entry without delaying
 * it, and it never throws.
 */
export function recordSignal(trade: StrategyTrade, signalAsk: number | null, deps: TapeDeps = defaultDeps): void {
  try {
    const token = trade.instrument.token;
    if (!token) return;
    const startedAt = deps.now();
    const ticks: TapeTick[] = [];
    let truncated = false;

    const stop = deps.watch(token, (tick) => {
      if (ticks.length >= MAX_TICKS) {
        truncated = true;
        return;
      }
      const row = toTapeTick(tick, deps.now());
      if (row) ticks.push(row);
    });

    deps.later(TAPE_MS, () => {
      try {
        stop();
      } catch {
        // nothing to undo
      }
      const tape: SignalTape = {
        _id: trade._id,
        tradeId: trade._id,
        tradingDate: trade.tradingDate,
        symbol: trade.symbol,
        setup: trade.setup,
        tradingsymbol: trade.instrument.tradingsymbol,
        token,
        signalAsk,
        riskPerUnit: trade.riskPerUnit,
        qty: trade.qty,
        startedAt,
        endedAt: deps.now(),
        ticks,
        truncated,
      };
      deps.save(tape).catch(() => {
        // a lost tape is a lost measurement, nothing more
      });
    });
  } catch {
    // never let the measurement touch the trade
  }
}
