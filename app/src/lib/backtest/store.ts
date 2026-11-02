import type { Collection } from "mongodb";
import { getDb, isConfigured } from "@/lib/mongo";
import type { StrategyTrade } from "@/lib/strategy/types";

/**
 * Reading backtest runs, and asking for new ones.
 *
 * The dashboard never replays anything itself. It writes a `queued` row and the
 * worker on the VPS — which is the only process with the PostgreSQL archive in
 * reach — picks it up. That split is the whole design: the archive is 70 GB of
 * minute data that nothing but the VPS should be reading, and a browser click
 * should not be able to start a twenty-minute job inside a web request.
 *
 * A run's `_id` is a fingerprint of everything that decides its result. Asking
 * for the same backtest twice therefore lands on the same row, which is what
 * makes "you have already run this" the default answer rather than a silent
 * recompute.
 */

const RUNS = "backtest_runs";
const TRADES = "backtest_trades";
const META = "backtest_meta";

export { isConfigured };

export type RunStatus = "queued" | "running" | "done" | "failed";

export interface RunSummary {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  net: number;
  profitFactor: number | null;
  maxDrawdown: number;
  expectancy: number;
}

export interface BacktestRun {
  _id: string;
  /** The legs replayed — A, B, C or any mix. The unit a run is asked for in. */
  setups: string[];
  strategyIds: string[];
  strategies: { id: string; version: number }[];
  from: string;
  to: string;
  fillRule: string;
  gateFloors: Record<string, number>;
  dataRevision: string;
  status: RunStatus;
  progress: { done: number; total: number | null; day: string | null } | null;
  requestedBy: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  sessions?: number;
  trades?: number;
  signals?: number;
  summary?: RunSummary;
  summaryExApprox?: RunSummary;
  /** How many trades rested on the approximated book gate, and how many signals it refused. */
  gateCounts?: Record<string, number>;
  /**
   * Each leg's own figures, always — even when they were replayed together.
   * Being able to read them apart is the whole point of separating them.
   */
  bySetup?: Record<string, RunSummary & { signals: number }>;
  rejected?: Record<string, number>;
  skipped?: Record<string, number>;
  incompleteStockDays?: number;
}

/** A backtest trade is a live trade plus where it came from and how it was gated. */
export interface BacktestTrade extends StrategyTrade {
  runId: string;
  gate: "clear" | "approx";
}

/**
 * What the archive holds, published by the worker.
 *
 * The dashboard has no reach into the PostgreSQL archive, so it cannot answer
 * this for itself. Without it a date range can be picked that the archive does
 * not cover, and the run comes back empty with nothing on screen to say why.
 */
export interface ArchiveCoverage {
  options: { stocks: number; from: string; to: string } | null;
  spot: { symbols: number; from: string; to: string } | null;
  months: { month: string; stockDays: number; stocks: number }[];
  /** NIFTY weekly options, for the backtest-only opening-range rule. Absent from older snapshots. */
  indexOptions?: { symbol: string; from: string; to: string; days: number } | null;
}

export async function readCoverage(): Promise<{ coverage: ArchiveCoverage; updatedAt: Date } | null> {
  const db = await getDb();
  if (!db) return null;
  const doc = await db
    .collection<{ _id: string; coverage: ArchiveCoverage; updatedAt: Date }>(META)
    .findOne({ _id: "coverage" });
  return doc ? { coverage: doc.coverage, updatedAt: doc.updatedAt } : null;
}

async function runs(): Promise<Collection<BacktestRun> | null> {
  const db = await getDb();
  return db ? db.collection<BacktestRun>(RUNS) : null;
}

async function trades(): Promise<Collection<BacktestTrade> | null> {
  const db = await getDb();
  return db ? db.collection<BacktestTrade>(TRADES) : null;
}

export async function listRuns(limit = 50): Promise<BacktestRun[]> {
  const collection = await runs();
  if (!collection) return [];
  return collection.find({}).sort({ queuedAt: -1 }).limit(limit).toArray();
}

export async function getRun(id: string): Promise<BacktestRun | null> {
  const collection = await runs();
  if (!collection) return null;
  return collection.findOne({ _id: id });
}

export async function runTrades(runId: string): Promise<BacktestTrade[]> {
  const collection = await trades();
  if (!collection) return [];
  return collection.find({ runId }).sort({ openedAt: 1 }).toArray();
}

/**
 * Queues a run, or returns the existing one unchanged.
 *
 * `$setOnInsert` rather than an upsert of the whole document: a run that has
 * already finished must not be reset to `queued` because someone asked for it
 * again. The caller is told which of the two happened so the screen can say
 * "already run" instead of pretending to start something.
 */
export async function queueRun(
  id: string,
  fields: Omit<BacktestRun, "_id" | "status" | "progress" | "queuedAt" | "startedAt" | "finishedAt" | "error">
): Promise<{ run: BacktestRun; created: boolean }> {
  const collection = await runs();
  if (!collection) throw new Error("MongoDB is not configured");

  // updateOne rather than findOneAndUpdate so `upsertedCount` says plainly
  // whether this call created the row. Inferring it from the document — a
  // recent `queuedAt`, an absent `startedAt` — gets it wrong for a run someone
  // else queued moments ago, and tells the person their click started something
  // when it did not.
  const result = await collection.updateOne(
    { _id: id },
    {
      $setOnInsert: {
        ...fields,
        status: "queued" as RunStatus,
        progress: { done: 0, total: null, day: null },
        queuedAt: new Date(),
        startedAt: null,
        finishedAt: null,
        error: null,
      },
    },
    { upsert: true }
  );

  const run = await collection.findOne({ _id: id });
  if (!run) throw new Error("could not queue the run");
  return { run, created: result.upsertedCount === 1 };
}

export async function deleteRun(id: string): Promise<void> {
  const [runCollection, tradeCollection] = await Promise.all([runs(), trades()]);
  if (!runCollection || !tradeCollection) throw new Error("MongoDB is not configured");
  await tradeCollection.deleteMany({ runId: id });
  await runCollection.deleteOne({ _id: id });
}

export async function ensureIndexes(): Promise<void> {
  const [runCollection, tradeCollection] = await Promise.all([runs(), trades()]);
  if (!runCollection || !tradeCollection) return;
  await runCollection.createIndex({ status: 1, queuedAt: 1 });
  await tradeCollection.createIndex({ runId: 1 });
  await tradeCollection.createIndex({ runId: 1, tradingDate: 1 });
}
