import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { KiteConnect } from "kiteconnect";
import type { DeskIndex } from "@/lib/types";
import { requireConfig, RUNTIME_DIR } from "./config";

export interface InstrumentMap {
  /** IST date the dump was resolved on. Kite regenerates the CSV daily. */
  asOf: string;
  bySymbol: Record<string, number>;
  /** Desk symbols with no matching NSE equity — renames and fresh listings. */
  unresolved: string[];
}

function cacheFile(): string {
  return path.resolve(process.cwd(), RUNTIME_DIR, "instruments.json");
}

function istDate(now = Date.now()): string {
  return new Date(now + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * The desk's own index is the universe of record — whatever the table renders is
 * exactly what we stream, so the two can never drift apart.
 */
async function deskSymbols(): Promise<string[]> {
  const file = path.join(process.cwd(), "public", "data", "index.json");
  const index = JSON.parse(await readFile(file, "utf8")) as DeskIndex;
  return index.companies.map((c) => c.symbol);
}

/**
 * Kite's docs are explicit that numeric instrument tokens are not stable across
 * the daily regeneration, so the cache is keyed on the IST date and the symbol
 * is our only durable identifier.
 */
export async function resolveInstruments(accessToken: string): Promise<InstrumentMap> {
  const today = istDate();

  try {
    const cached = JSON.parse(await readFile(cacheFile(), "utf8")) as InstrumentMap;
    if (cached.asOf === today && Object.keys(cached.bySymbol).length > 0) return cached;
  } catch {
    // no usable cache, fall through and fetch
  }

  const { apiKey } = requireConfig();
  const kc = new KiteConnect({ api_key: apiKey });
  kc.setAccessToken(accessToken);

  const dump = await kc.getInstruments("NSE");
  const tokenBySymbol = new Map<string, number>();
  for (const row of dump) {
    // Equity only — the same tradingsymbol also appears as futures and options.
    if (row.instrument_type !== "EQ") continue;
    const token = Number(row.instrument_token);
    if (!Number.isFinite(token)) continue;
    tokenBySymbol.set(row.tradingsymbol, token);
  }

  const bySymbol: Record<string, number> = {};
  const unresolved: string[] = [];
  for (const symbol of await deskSymbols()) {
    const token = tokenBySymbol.get(symbol);
    if (token == null) unresolved.push(symbol);
    else bySymbol[symbol] = token;
  }

  const map: InstrumentMap = { asOf: today, bySymbol, unresolved };
  await mkdir(path.dirname(cacheFile()), { recursive: true });
  await writeFile(cacheFile(), JSON.stringify(map, null, 2));
  return map;
}
