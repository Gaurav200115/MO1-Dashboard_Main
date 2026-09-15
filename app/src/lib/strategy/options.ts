import { KiteConnect } from "kiteconnect";
import { loadOptionUniverse, type OptionContract } from "@/lib/eod/chain";
import { requireConfig } from "@/lib/kite/config";
import { quoteGate } from "@/lib/kite/gate";
import { readSession } from "@/lib/kite/session";
import { istDate } from "./ist";
import type { OptionType, TradeInstrument } from "./types";

/**
 * Resolving the contract a signal actually buys, and pricing it.
 *
 * The overnight scan already reads the option chain, but it reads open interest
 * off yesterday's close. A trade needs two different things from the chain: the
 * strike nearest *live* spot at the moment of the signal, and the premium being
 * quoted for it right now.
 */

const UNIVERSE_TTL_MS = 6 * 60 * 60 * 1000;
/** Kite caps /quote at 500 instruments. Open positions never approach this. */
const QUOTE_BATCH = 400;

interface UniverseCache {
  asOf: string;
  loadedAt: number;
  byUnderlying: Map<string, OptionContract[]>;
}

const globalRef = globalThis as typeof globalThis & {
  __strategyOptionUniverse?: UniverseCache | null;
  __strategyUniverseInFlight?: Promise<UniverseCache> | null;
};

/**
 * The NFO dump, cached for the trading day.
 *
 * Kite regenerates instrument tokens daily, so the cache is keyed on the IST
 * date rather than a bare TTL — an overnight process that never restarts must
 * not keep yesterday's contracts. Single-flighted because the engine can resolve
 * several signals in the same second and the dump is a multi-megabyte CSV.
 */
async function universe(): Promise<UniverseCache> {
  const today = istDate();
  const cached = globalRef.__strategyOptionUniverse;
  if (cached && cached.asOf === today && Date.now() - cached.loadedAt < UNIVERSE_TTL_MS) {
    return cached;
  }
  if (globalRef.__strategyUniverseInFlight) return globalRef.__strategyUniverseInFlight;

  const load = (async (): Promise<UniverseCache> => {
    const session = await readSession();
    if (!session) throw new Error("No Kite session — cannot resolve option contracts");
    const byUnderlying = await loadOptionUniverse(session.accessToken);
    const fresh: UniverseCache = { asOf: today, loadedAt: Date.now(), byUnderlying };
    globalRef.__strategyOptionUniverse = fresh;
    return fresh;
  })().finally(() => {
    globalRef.__strategyUniverseInFlight = null;
  });

  globalRef.__strategyUniverseInFlight = load;
  return load;
}

/** Discard the cache — used when a fresh login invalidates the old token. */
export function resetOptionUniverse(): void {
  globalRef.__strategyOptionUniverse = null;
}

/**
 * Nearest expiry on or after the trading day.
 *
 * On or after, not strictly after: on expiry day the series is still the live
 * one, and rolling to the next month early would price the trade off contracts
 * nobody is trading yet. It differs from the EOD scan's rule, which excludes the
 * session it was computed from because that series had already settled.
 */
function nearestExpiry(contracts: OptionContract[], onOrAfter: string): string | null {
  let nearest: string | null = null;
  for (const contract of contracts) {
    if (contract.expiry < onOrAfter) continue;
    if (!nearest || contract.expiry < nearest) nearest = contract.expiry;
  }
  return nearest;
}

export class NoContractError extends Error {
  constructor(symbol: string, detail: string) {
    super(`${symbol}: ${detail}`);
    this.name = "NoContractError";
  }
}

/**
 * The at-the-money contract on one side, chosen against live spot.
 *
 * `preferExpiry` lets the caller pin the series the overnight scan measured open
 * interest on, so the level analysis and the contract traded describe the same
 * book. It is a preference rather than a requirement: if that expiry has since
 * settled, the nearest live one is used instead.
 */
export async function resolveAtm(
  symbol: string,
  spot: number,
  type: OptionType,
  preferExpiry?: string
): Promise<TradeInstrument> {
  if (!Number.isFinite(spot) || spot <= 0) {
    throw new NoContractError(symbol, `spot price is not usable (${spot})`);
  }

  const { byUnderlying } = await universe();
  const contracts = byUnderlying.get(symbol);
  if (!contracts || contracts.length === 0) {
    throw new NoContractError(symbol, "has no listed options");
  }

  const today = istDate();
  const live = nearestExpiry(contracts, today);
  if (!live) throw new NoContractError(symbol, "has no unexpired series");

  const expiry = preferExpiry && preferExpiry >= today ? preferExpiry : live;

  let best: OptionContract | null = null;
  for (const contract of contracts) {
    if (contract.expiry !== expiry || contract.type !== type) continue;
    if (!best || Math.abs(contract.strike - spot) < Math.abs(best.strike - spot)) {
      best = contract;
    }
  }

  if (!best) throw new NoContractError(symbol, `has no ${type} on ${expiry}`);
  if (best.lotSize <= 0) {
    // Without the multiplier the rupee risk cannot be converted to a premium
    // stop, and a trade with no stop is worse than no trade.
    throw new NoContractError(symbol, `lot size missing for ${best.tradingsymbol}`);
  }

  return {
    tradingsymbol: best.tradingsymbol,
    strike: best.strike,
    type: best.type,
    expiry: best.expiry,
    lotSize: best.lotSize,
  };
}

export function quoteKey(instrument: Pick<TradeInstrument, "tradingsymbol">): string {
  return `NFO:${instrument.tradingsymbol}`;
}

export interface PremiumQuote {
  key: string;
  last: number;
  /** Best bid and ask from the depth book. Null when the book came back empty. */
  bid: number | null;
  ask: number | null;
  at: number;
}

/**
 * Live premiums for a set of contracts, in one batched call per 400.
 *
 * Goes through the shared 1 req/sec quote gate at foreground priority: an open
 * position waiting on its stop is the most time-critical read the desk makes,
 * and it must not queue behind an EOD scan's background batches.
 */
export async function fetchPremiums(keys: string[]): Promise<Map<string, PremiumQuote>> {
  const out = new Map<string, PremiumQuote>();
  if (keys.length === 0) return out;

  const session = await readSession();
  if (!session) throw new Error("No Kite session — cannot price options");

  const { apiKey } = requireConfig();
  const kc = new KiteConnect({ api_key: apiKey });
  kc.setAccessToken(session.accessToken);

  const unique = [...new Set(keys)];

  for (let start = 0; start < unique.length; start += QUOTE_BATCH) {
    const batch = unique.slice(start, start + QUOTE_BATCH);
    const quotes = await quoteGate.run(() => kc.getQuote(batch));
    const at = Date.now();

    for (const [key, quote] of Object.entries(quotes)) {
      const last = typeof quote.last_price === "number" ? quote.last_price : NaN;
      if (!Number.isFinite(last)) continue;
      out.set(key, {
        key,
        last,
        bid: topOf(quote.depth?.buy),
        ask: topOf(quote.depth?.sell),
        at,
      });
    }
  }

  return out;
}

function topOf(side: { price: number }[] | undefined): number | null {
  const price = side?.[0]?.price;
  return typeof price === "number" && price > 0 ? price : null;
}

/**
 * The price a paper fill is booked at.
 *
 * Crossing the spread rather than assuming a fill at the last traded price.
 * Stock option books are wide — a 2% spread on an ATM premium is ordinary — and
 * a blotter that buys and sells at the mid quietly manufactures a return the
 * strategy never earned. Falls back to the last price only when the book is
 * empty, which is where the optimism is genuinely unavoidable.
 */
export function fillPrice(quote: PremiumQuote, action: "buy" | "sell"): number {
  if (action === "buy") return quote.ask ?? quote.last;
  return quote.bid ?? quote.last;
}
