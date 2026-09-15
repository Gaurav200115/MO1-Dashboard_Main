import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNTIME_DIR } from "@/lib/kite/config";
import type { StrategyTrade, TradeDaySummary } from "./types";

/**
 * An on-disk journal of every trade, written before Mongo is touched.
 *
 * The desk already treats disk as the durable copy and Mongo as the queryable
 * one — that is what `.kite/eod` is to `daily_levels` — and trades need the same
 * arrangement for a sharper reason. A level lost to a database outage can be
 * recomputed from the report; a fill cannot be recomputed from anything. The
 * premium that was quoted at 10:47 is gone the moment the session moves on.
 *
 * So the write order is journal first, Mongo second. If Atlas is unreachable —
 * an expired access-list entry is enough to do it — the session still produces a
 * complete record, and the blotter reads it without noticing the difference.
 */

function dir(): string {
  return path.resolve(process.cwd(), RUNTIME_DIR, "trades");
}

function file(tradingDate: string): string {
  return path.join(dir(), `${tradingDate}.json`);
}

/**
 * Writes are serialised through one chain.
 *
 * The file is rewritten whole on every change, and two trades ratcheting their
 * stops in the same tracking pass would otherwise interleave a read-modify-write
 * and lose one of them.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialise<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  // Keep the chain alive after a rejection, without swallowing it for the caller.
  queue = next.catch(() => undefined);
  return next;
}

/** Dates survive JSON as strings; the blotter's types say Date, so revive them. */
function revive(trade: StrategyTrade): StrategyTrade {
  return {
    ...trade,
    openedAt: new Date(trade.openedAt),
    closedAt: trade.closedAt ? new Date(trade.closedAt) : null,
  };
}

async function readRaw(tradingDate: string): Promise<StrategyTrade[]> {
  try {
    const body = await readFile(file(tradingDate), "utf8");
    const parsed = JSON.parse(body) as StrategyTrade[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function readJournal(tradingDate: string): Promise<StrategyTrade[]> {
  return (await readRaw(tradingDate)).map(revive);
}

export async function appendJournal(trade: StrategyTrade): Promise<void> {
  await serialise(async () => {
    const existing = await readRaw(trade.tradingDate);
    // Replace on re-write rather than duplicate — a replayed open is a bug, but
    // it must not leave two rows claiming to be the same position.
    const next = existing.filter((row) => row._id !== trade._id);
    next.push(trade);
    await mkdir(dir(), { recursive: true });
    await writeFile(file(trade.tradingDate), JSON.stringify(next, null, 2));
  });
}

export async function patchJournal(
  tradingDate: string,
  id: string,
  patch: Partial<StrategyTrade>
): Promise<boolean> {
  return serialise(async () => {
    const existing = await readRaw(tradingDate);
    const index = existing.findIndex((row) => row._id === id);
    if (index < 0) return false;
    existing[index] = { ...existing[index], ...patch };
    await mkdir(dir(), { recursive: true });
    await writeFile(file(tradingDate), JSON.stringify(existing, null, 2));
    return true;
  });
}

export async function journalDates(): Promise<string[]> {
  try {
    const files = await readdir(dir());
    return files
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .map((name) => name.slice(0, 10))
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

export async function journalOpenTrades(strategyIds?: string[]): Promise<StrategyTrade[]> {
  const out: StrategyTrade[] = [];
  for (const date of await journalDates()) {
    for (const trade of await readJournal(date)) {
      if (trade.status !== "open") continue;
      if (strategyIds?.length && !strategyIds.includes(trade.strategyId)) continue;
      out.push(trade);
    }
  }
  return out;
}

/** The same shape the Mongo aggregation produces, computed over the journal. */
export async function journalDays(limit = 60): Promise<TradeDaySummary[]> {
  const summaries: TradeDaySummary[] = [];

  for (const date of (await journalDates()).slice(0, limit)) {
    const byStrategy = new Map<string, TradeDaySummary>();

    for (const trade of await readJournal(date)) {
      let entry = byStrategy.get(trade.strategyId);
      if (!entry) {
        entry = {
          tradingDate: date,
          strategyId: trade.strategyId,
          strategyName: trade.strategyName,
          trades: 0,
          open: 0,
          wins: 0,
          losses: 0,
          profit: 0,
        };
        byStrategy.set(trade.strategyId, entry);
      }
      entry.trades += 1;
      if (trade.status === "open") entry.open += 1;
      if (trade.profit != null) {
        entry.profit += trade.profit;
        if (trade.profit > 0) entry.wins += 1;
        else if (trade.profit < 0) entry.losses += 1;
      }
    }

    summaries.push(...byStrategy.values());
  }

  return summaries;
}
