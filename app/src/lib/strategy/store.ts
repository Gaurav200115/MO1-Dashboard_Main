import type { Collection } from "mongodb";
import { getDb, isConfigured, mongoMessage } from "@/lib/mongo";
import {
  appendJournal,
  journalDays,
  journalOpenTrades,
  patchJournal,
  readJournal,
} from "./journal";
import { strategyKey } from "./registry";
import type { StrategyDefinition, StrategyTrade, TradeDaySummary } from "./types";

/**
 * Persistence for strategies and the trades taken on them.
 *
 * Two collections rather than one document per strategy with trades nested. A
 * season of trades is the thing that gets queried — by day, by symbol, by
 * outcome — and nesting them under the rule would make every one of those
 * questions a scan through an array that only grows.
 *
 * `strategies` is a mirror of the code in registry.ts, keyed on id *and*
 * version. Nothing reads it to decide how to trade; it exists so that a trade
 * taken in September can still be read against the exact thresholds it ran
 * under after the rule has been tuned twice.
 *
 * Every trade path here is backed by the on-disk journal, which is written first
 * and read from whenever Mongo cannot be reached. See journal.ts for why a fill
 * gets that treatment when a level does not.
 */

const STRATEGIES = "strategies";
const TRADES = "strategy_trades";

export { isConfigured };

export interface StoredStrategy extends StrategyDefinition {
  _id: string;
  syncedAt: Date;
}

async function strategies(): Promise<Collection<StoredStrategy> | null> {
  const db = await getDb();
  return db ? db.collection<StoredStrategy>(STRATEGIES) : null;
}

async function trades(): Promise<Collection<StrategyTrade> | null> {
  const db = await getDb();
  return db ? db.collection<StrategyTrade>(TRADES) : null;
}

/** Indexes are idempotent and cheap; created on the paths that boot the engine. */
export async function ensureIndexes(): Promise<void> {
  const collection = await trades();
  if (!collection) return;
  await collection.createIndex({ tradingDate: -1, strategyId: 1 });
  await collection.createIndex({ status: 1 });
  await collection.createIndex({ symbol: 1, tradingDate: -1 });
}

/**
 * Mirrors the code-defined catalogue into Mongo.
 *
 * `$setOnInsert` on everything but `syncedAt`, because a released version is
 * immutable by construction: if the rule changed, the version changed, and this
 * is a different document. Overwriting in place would rewrite the definition
 * under trades that had already been taken against it.
 */
export async function syncStrategies(
  definitions: StrategyDefinition[]
): Promise<{ synced: number; skipped: "not-configured" | null }> {
  const collection = await strategies();
  if (!collection) return { synced: 0, skipped: "not-configured" };
  if (definitions.length === 0) return { synced: 0, skipped: null };

  const operations = definitions.map((definition) => ({
    updateOne: {
      filter: { _id: strategyKey(definition.id, definition.version) },
      update: {
        $setOnInsert: definition,
        $set: { syncedAt: new Date() },
      },
      upsert: true,
    },
  }));

  const result = await collection.bulkWrite(operations, { ordered: false });
  return { synced: result.upsertedCount + result.matchedCount, skipped: null };
}

export async function listStoredStrategies(): Promise<StoredStrategy[]> {
  const collection = await strategies();
  if (!collection) return [];
  return collection.find({}).sort({ id: 1, version: -1 }).toArray();
}

/** Stable, human-readable and idempotent — a replayed open cannot double-book. */
export function tradeId(
  trade: Pick<StrategyTrade, "tradingDate" | "strategyId" | "symbol" | "setup">,
  sequence: number
): string {
  return `${trade.tradingDate}:${trade.strategyId}:${trade.symbol}:${trade.setup}:${sequence}`;
}

/**
 * Writes a new trade. The journal write is the one that must succeed — a fill
 * that reaches neither is a position the engine is about to manage without any
 * record of, which is the one outcome worth refusing to proceed from.
 *
 * `insertOne` rather than an upsert on purpose: a duplicate key means the engine
 * tried to open a position it had already opened, and that should surface rather
 * than silently overwrite a live fill with a second one.
 */
export async function insertTrade(trade: StrategyTrade): Promise<boolean> {
  await appendJournal(trade);

  const collection = await trades().catch(() => null);
  if (!collection) return true;
  try {
    await collection.insertOne(trade);
  } catch (err) {
    console.warn(`[strategy] Mongo insert failed, journal holds it: ${mongoMessage(err)}`);
  }
  return true;
}

export async function updateTrade(
  trade: Pick<StrategyTrade, "_id" | "tradingDate">,
  patch: Partial<StrategyTrade>
): Promise<boolean> {
  const written = await patchJournal(trade.tradingDate, trade._id, patch);

  const collection = await trades().catch(() => null);
  if (collection) {
    try {
      await collection.updateOne({ _id: trade._id }, { $set: patch });
    } catch (err) {
      console.warn(`[strategy] Mongo update failed, journal holds it: ${mongoMessage(err)}`);
    }
  }
  return written;
}

export interface BackfillResult {
  tradingDate: string;
  journal: number;
  upserted: number;
  matched: number;
  skipped: "no-journal" | "not-configured" | null;
}

/**
 * Pushes a day's journal into Mongo.
 *
 * `insertTrade` is journal-first and Mongo-second with the Mongo half allowed to
 * fail, so an outage leaves days that exist on disk and nowhere else. Nothing
 * reconciled them afterwards: the blotter reads disk first and never noticed the
 * difference, so the gap only surfaces when something queries Mongo directly —
 * a backtest, an aggregate, anything that does not go through `tradesOn`. This
 * is that reconciliation, run for the days that need it.
 *
 * `replaceOne` upserts rather than `insertOne`: re-running a day that is already
 * mirrored has to be a no-op, and a day that was half-written before the
 * connection dropped has to end up matching disk rather than throwing on the
 * first duplicate key. Disk wins every field, because disk is what the session
 * actually produced.
 */
export async function backfillTrades(tradingDate: string): Promise<BackfillResult> {
  const fromDisk = await readJournal(tradingDate);
  const empty = { tradingDate, journal: fromDisk.length, upserted: 0, matched: 0 };
  if (fromDisk.length === 0) return { ...empty, skipped: "no-journal" };

  const collection = await trades();
  if (!collection) return { ...empty, skipped: "not-configured" };

  // A day being backfilled is often the first thing to touch this collection on
  // a fresh cluster, so the indexes may not exist yet.
  await ensureIndexes();

  const result = await collection.bulkWrite(
    fromDisk.map((trade) => ({
      replaceOne: { filter: { _id: trade._id }, replacement: trade, upsert: true },
    })),
    { ordered: false }
  );

  return {
    ...empty,
    upserted: result.upsertedCount,
    matched: result.matchedCount,
    skipped: null,
  };
}

/** Every day the journal holds, oldest first — the "catch Mongo up" path. */
export async function backfillAllTrades(): Promise<BackfillResult[]> {
  const days = await journalDays(365);
  const dates = [...new Set(days.map((day) => day.tradingDate))].sort();

  // Serial on purpose. These run against one cluster that has just proved it can
  // be unreachable, and a day at a time makes a partial failure legible.
  const results: BackfillResult[] = [];
  for (const date of dates) results.push(await backfillTrades(date));
  return results;
}

/**
 * Trades still open, so a server restart mid-session picks up positions it does
 * not otherwise remember. Without this a restart at 10:30 would leave a live
 * position untracked and unstoppped for the rest of the day.
 */
export async function openTrades(strategyIds?: string[]): Promise<StrategyTrade[]> {
  // The journal is authoritative here. Mongo could only ever hold a subset —
  // anything written while it was unreachable exists on disk alone — and an
  // unadopted open position is one nothing would stop out.
  return journalOpenTrades(strategyIds);
}

export async function tradesOn(
  tradingDate: string,
  strategyId?: string
): Promise<StrategyTrade[]> {
  const fromDisk = await readJournal(tradingDate);
  const filtered = strategyId
    ? fromDisk.filter((trade) => trade.strategyId === strategyId)
    : fromDisk;
  if (filtered.length > 0) return filtered.sort((a, b) => a.buy.at - b.buy.at);

  // Nothing on disk for that day: it may predate the journal, so fall through.
  const collection = await trades().catch(() => null);
  if (!collection) return [];
  const filter: Record<string, unknown> = { tradingDate };
  if (strategyId) filter.strategyId = strategyId;
  return collection.find(filter).sort({ "buy.at": 1 }).toArray();
}
/** The mirror's view of the same question. Split out so `tradeDays` can merge. */
async function mongoDays(limit: number): Promise<TradeDaySummary[]> {
  const collection = await trades().catch(() => null);
  if (!collection) return [];

  return collection
    .aggregate<TradeDaySummary>([
      {
        $group: {
          _id: { tradingDate: "$tradingDate", strategyId: "$strategyId" },
          strategyName: { $first: "$strategyName" },
          trades: { $sum: 1 },
          open: { $sum: { $cond: [{ $eq: ["$status", "open"] }, 1, 0] } },
          wins: { $sum: { $cond: [{ $gt: ["$profit", 0] }, 1, 0] } },
          losses: { $sum: { $cond: [{ $lt: ["$profit", 0] }, 1, 0] } },
          // Null while a trade is open, and $sum ignores nulls — so this is
          // realised profit, not a mark-to-market of the whole book.
          profit: { $sum: "$profit" },
        },
      },
      {
        $project: {
          _id: 0,
          tradingDate: "$_id.tradingDate",
          strategyId: "$_id.strategyId",
          strategyName: 1,
          trades: 1,
          open: 1,
          wins: 1,
          losses: 1,
          profit: 1,
        },
      },
      { $sort: { tradingDate: -1, strategyId: 1 } },
      { $limit: limit },
    ])
    .toArray();
}

/**
 * Days that have trades, newest first — the blotter's date picker.
 *
 * The two sources are merged, not chosen between. They hold different things:
 * disk has what this machine recorded, Mongo has every day any instance ever
 * mirrored, and a day written during an outage — or by a different deployment —
 * exists in exactly one of them. Returning the first non-empty source meant one
 * journal file on disk was enough to hide the entire database from the picker,
 * so `tradesOn` would happily serve a date the dropdown gave no way to choose.
 *
 * Disk wins a collision, for the reason it wins everywhere else here: it is what
 * the session actually produced and the mirror is allowed to lag it.
 */
export async function tradeDays(limit = 60): Promise<TradeDaySummary[]> {
  const [fromDisk, fromMongo] = await Promise.all([
    journalDays(limit),
    // An unreachable cluster costs the days only Mongo knows about. It must not
    // cost the days on disk as well — that is the whole point of the journal.
    mongoDays(limit).catch(() => [] as TradeDaySummary[]),
  ]);

  const merged = new Map<string, TradeDaySummary>();
  for (const day of fromMongo) merged.set(`${day.tradingDate}:${day.strategyId}`, day);
  for (const day of fromDisk) merged.set(`${day.tradingDate}:${day.strategyId}`, day);

  // `limit` counts days, not rows — a day fans out to one row per strategy that
  // traded it, and cutting mid-day would drop strategies from the last one.
  const keep = new Set(
    [...new Set([...merged.values()].map((day) => day.tradingDate))]
      .sort((a, b) => b.localeCompare(a))
      .slice(0, limit)
  );

  return [...merged.values()]
    .filter((day) => keep.has(day.tradingDate))
    .sort(
      (a, b) =>
        b.tradingDate.localeCompare(a.tradingDate) || a.strategyId.localeCompare(b.strategyId)
    );
}
