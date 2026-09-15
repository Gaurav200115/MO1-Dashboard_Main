import { KiteConnect } from "kiteconnect";
import { requireConfig } from "@/lib/kite/config";
import { quoteGate } from "@/lib/kite/gate";
import type { StrikeOi } from "./oi";

/**
 * How far either side of at-the-money to read. Counted in ladder positions, not
 * rupees: NSE thins its strike spacing out in the wings (RELIANCE lists every
 * ₹10 near the money and every ₹40 far from it), so a fixed price band would
 * cover a different number of live strikes for every stock.
 */
export const STRIKE_WINDOW = 8;

/** Kite caps /quote at 500 instruments; 400 leaves room and still needs ~16 calls. */
const QUOTE_BATCH = 400;

export interface OptionContract {
  tradingsymbol: string;
  strike: number;
  type: "CE" | "PE";
  /** ISO date, from the UTC-midnight expiry the dump carries. */
  expiry: string;
  /**
   * Contract multiplier. Unused by the confluence scan, which only reads open
   * interest, but load-bearing for the strategy layer: a rupee risk budget only
   * becomes a premium stop once you know how many units a lot is.
   */
  lotSize: number;
  /**
   * Needed only by the backfill. Live open interest comes from `/quote`, keyed
   * by tradingsymbol, but a past session's OI can only be read from the
   * historical endpoint, which is keyed by token.
   */
  token: number;
}

export interface ChainPlan {
  expiry: string;
  atmStrike: number;
  /** One entry per strike that lists both a call and a put. */
  pairs: { strike: number; callKey: string; putKey: string }[];
}

/**
 * Every option contract in the NFO segment, grouped by underlying. One request —
 * the dump is a single CSV and the instruments endpoint is on the 10 req/sec
 * tier, so it needs no gating.
 */
export async function loadOptionUniverse(
  accessToken: string
): Promise<Map<string, OptionContract[]>> {
  const { apiKey } = requireConfig();
  const kc = new KiteConnect({ api_key: apiKey });
  kc.setAccessToken(accessToken);

  const dump = await kc.getInstruments("NFO");
  const byUnderlying = new Map<string, OptionContract[]>();

  for (const row of dump) {
    if (row.instrument_type !== "CE" && row.instrument_type !== "PE") continue;
    const strike = Number(row.strike);
    if (!Number.isFinite(strike) || strike <= 0) continue;

    const contract: OptionContract = {
      tradingsymbol: row.tradingsymbol,
      strike,
      type: row.instrument_type,
      expiry: new Date(row.expiry).toISOString().slice(0, 10),
      lotSize: Number(row.lot_size) || 0,
      token: Number(row.instrument_token),
    };

    const bucket = byUnderlying.get(row.name);
    if (bucket) bucket.push(contract);
    else byUnderlying.set(row.name, [contract]);
  }

  return byUnderlying;
}

/**
 * Nearest expiry still outstanding *after* the session we are reading. Strictly
 * after, not on: a scan running the evening of expiry day would otherwise read
 * the series that settled hours earlier, whose open interest says nothing about
 * the next session.
 *
 * Individual stock options are monthly only — the weekly ladder is an index
 * product — so this is the current series for all but the last day or two of
 * the month, when positioning has begun rolling into the next one.
 */
function nearestExpiry(contracts: OptionContract[], session: string): string | null {
  let nearest: string | null = null;
  for (const contract of contracts) {
    if (contract.expiry <= session) continue;
    if (!nearest || contract.expiry < nearest) nearest = contract.expiry;
  }
  return nearest;
}

/**
 * Which contracts to read for one stock. Strikes listing only one side are
 * dropped rather than treated as zero on the other — a missing put is unknown
 * open interest, and calling it zero would manufacture a call-dominant strike.
 */
export function planChain(
  contracts: OptionContract[],
  reference: number,
  session: string,
  window = STRIKE_WINDOW
): ChainPlan | null {
  const expiry = nearestExpiry(contracts, session);
  if (!expiry) return null;

  const sides = new Map<number, { call?: string; put?: string }>();
  for (const contract of contracts) {
    if (contract.expiry !== expiry) continue;
    const entry = sides.get(contract.strike) ?? {};
    if (contract.type === "CE") entry.call = contract.tradingsymbol;
    else entry.put = contract.tradingsymbol;
    sides.set(contract.strike, entry);
  }

  const ladder = [...sides.keys()].sort((a, b) => a - b);
  if (ladder.length === 0) return null;

  let atm = 0;
  for (let i = 1; i < ladder.length; i++) {
    if (Math.abs(ladder[i] - reference) < Math.abs(ladder[atm] - reference)) atm = i;
  }

  const band = ladder.slice(Math.max(0, atm - window), atm + window + 1);
  const pairs: ChainPlan["pairs"] = [];
  for (const strike of band) {
    const entry = sides.get(strike);
    if (!entry?.call || !entry.put) continue;
    pairs.push({
      strike,
      callKey: `NFO:${entry.call}`,
      putKey: `NFO:${entry.put}`,
    });
  }

  if (pairs.length === 0) return null;
  return { expiry, atmStrike: ladder[atm], pairs };
}

export interface OiFetchResult {
  oiByKey: Map<string, number>;
  /** Batches that failed outright, so the caller can report partial coverage. */
  failedBatches: number;
}

/**
 * Open interest for every requested contract, in batches of QUOTE_BATCH through
 * the 1 req/sec quote gate at background priority.
 *
 * A failed batch is recorded and skipped rather than aborting the scan: losing
 * 400 contracts costs a few stocks, losing the run costs the whole evening.
 */
export async function fetchOpenInterest(
  keys: string[],
  accessToken: string,
  onProgress?: (done: number, total: number) => void
): Promise<OiFetchResult> {
  const { apiKey } = requireConfig();
  const kc = new KiteConnect({ api_key: apiKey });
  kc.setAccessToken(accessToken);

  const oiByKey = new Map<string, number>();
  let failedBatches = 0;

  for (let start = 0; start < keys.length; start += QUOTE_BATCH) {
    const batch = keys.slice(start, start + QUOTE_BATCH);
    try {
      const quotes = await quoteGate.run(() => kc.getQuote(batch), { background: true });
      for (const [key, quote] of Object.entries(quotes)) {
        const oi = typeof quote.oi === "number" ? quote.oi : 0;
        oiByKey.set(key, oi);
      }
    } catch {
      failedBatches += 1;
    }
    onProgress?.(Math.min(start + QUOTE_BATCH, keys.length), keys.length);
  }

  return { oiByKey, failedBatches };
}

/** Pairs plus fetched open interest, in the shape the ratio test consumes. */
export function toStrikeOi(plan: ChainPlan, oiByKey: Map<string, number>): StrikeOi[] {
  const strikes: StrikeOi[] = [];
  for (const pair of plan.pairs) {
    const callOi = oiByKey.get(pair.callKey);
    const putOi = oiByKey.get(pair.putKey);
    if (callOi == null || putOi == null) continue;
    strikes.push({ strike: pair.strike, callOi, putOi });
  }
  return strikes;
}
