import { type Collection } from "mongodb";
import { getDb, isConfigured } from "@/lib/mongo";
import type { ConfirmedLevel } from "./confluence";
import type { EodReport, SpecialStock } from "./types";

/**
 * Archive of every confirmed level, one document per (session, symbol).
 *
 * Written for analysis rather than for the desk, so it keeps the stocks whose
 * levels price never came near as well — without that denominator you cannot ask
 * the only question worth asking of this rule: how often does price actually
 * reach a level the two methods agreed on?
 */

const COLLECTION = "daily_levels";

/** Outcome fields, left null until a pass scores them against the next session. */
export interface StoredLevel extends ConfirmedLevel {
  /** Did price reach this level during `tradingFor`? */
  hit: boolean | null;
  /** Where price finished relative to it — true if the level held. */
  held: boolean | null;
  /** Furthest price travelled through the level, in percent. */
  breachPct: number | null;
}

export interface StoredDay {
  _id: string;
  session: string;
  tradingFor: string;
  symbol: string;
  name: string;
  sector: string;
  close: { high: number; low: number; close: number };
  pivots: EodReport["stocks"][number]["pivots"];
  expiry: string;
  atmStrike: number;
  levels: StoredLevel[];
  /** True once any level on this stock has been scored as hit. */
  hitAny: boolean | null;
  provenance: {
    generatedAt: number;
    verifiedAt: number | null;
    params: EodReport["params"];
  };
  storedAt: Date;
}

export interface SessionSummary {
  session: string;
  tradingFor: string;
  stocks: number;
  levels: number;
  precious: number;
  storedAt: Date;
}

/** Re-exported so existing callers keep importing configuration state from here. */
export { isConfigured };

async function levels(): Promise<Collection<StoredDay> | null> {
  const database = await getDb();
  return database ? database.collection<StoredDay>(COLLECTION) : null;
}

/**
 * The archive shape for one stock. Exported because the same mapping serves the
 * on-disk fallback — the reports under `.kite/eod` are the source of truth, and
 * Mongo is a queryable copy of them, so a database that is unreachable should
 * degrade the archive to read-only rather than to empty.
 */
export function toStoredDay(report: EodReport, stock: SpecialStock): StoredDay {
  return {
    _id: `${report.basedOn}:${stock.symbol}`,
    session: report.basedOn,
    tradingFor: report.computedFor,
    symbol: stock.symbol,
    name: stock.name,
    sector: stock.sector,
    close: {
      high: stock.session.high,
      low: stock.session.low,
      close: stock.session.close,
    },
    pivots: stock.pivots,
    expiry: stock.expiry,
    atmStrike: stock.atmStrike,
    levels: stock.levels.map((level) => ({
      ...level,
      hit: null,
      held: null,
      breachPct: null,
    })),
    hitAny: null,
    provenance: {
      generatedAt: report.generatedAt,
      verifiedAt: report.verifiedAt,
      params: report.params,
    },
    storedAt: new Date(),
  };
}

export interface StoreOutcome {
  stored: number;
  skipped: "not-configured" | null;
  error?: string;
}

/**
 * Upserts every stock that produced at least one confirmed level.
 *
 * Keyed on session + symbol so the evening write and the next morning's
 * verification rewrite converge on one document rather than accumulating two
 * versions of the same day. A rewrite resets the outcome fields on purpose: the
 * verification pass only rewrites levels whose pivot moved, and a score recorded
 * against the old pivot value would no longer describe the level it is attached
 * to.
 */
export async function storeReport(report: EodReport): Promise<StoreOutcome> {
  const collection = await levels();
  if (!collection) return { stored: 0, skipped: "not-configured" };

  const confirmed = report.stocks.filter((stock) => stock.levels.length > 0);
  if (confirmed.length === 0) return { stored: 0, skipped: null };

  // Idempotent, and cheap enough to leave on a once-a-day path.
  await collection.createIndex({ session: 1, symbol: 1 });
  await collection.createIndex({ tradingFor: 1 });

  const operations = confirmed.map((stock) => {
    // _id comes from the filter on upsert; setting it again is redundant and
    // Mongo rejects it as an attempt to modify an immutable field.
    const { _id, ...rest } = toStoredDay(report, stock);
    return {
      updateOne: { filter: { _id }, update: { $set: rest }, upsert: true },
    };
  });

  const result = await collection.bulkWrite(operations, { ordered: false });
  return { stored: result.upsertedCount + result.matchedCount, skipped: null };
}

/** Stored sessions, newest first — the options for the date picker. */
export async function listSessions(): Promise<SessionSummary[]> {
  const collection = await levels();
  if (!collection) return [];

  return collection
    .aggregate<SessionSummary>([
      {
        $group: {
          _id: "$session",
          tradingFor: { $first: "$tradingFor" },
          stocks: { $sum: 1 },
          levels: { $sum: { $size: "$levels" } },
          precious: {
            $sum: {
              $size: {
                $filter: {
                  input: "$levels",
                  as: "level",
                  cond: { $eq: ["$$level.precious", true] },
                },
              },
            },
          },
          storedAt: { $max: "$storedAt" },
        },
      },
      { $project: { _id: 0, session: "$_id", tradingFor: 1, stocks: 1, levels: 1, precious: 1, storedAt: 1 } },
      { $sort: { session: -1 } },
    ])
    .toArray();
}

export async function getSession(session: string): Promise<StoredDay[]> {
  const collection = await levels();
  if (!collection) return [];
  return collection.find({ session }).sort({ symbol: 1 }).toArray();
}
