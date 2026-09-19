import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Collection } from "mongodb";
import { RUNTIME_DIR } from "@/lib/kite/config";
import { getDb, isConfigured } from "@/lib/mongo";
import type { BuildResult } from "./series";
import { BASE_LEVEL, BENCHMARK, type SectorBar, type SectorSeries } from "./types";

/**
 * Where the chained indices live.
 *
 * Same division of labour as the level archive: the file on disk is the source
 * of truth and Mongo is a queryable copy of it. That matters more here than it
 * does there — a chain that loses a session cannot be recomputed from the next
 * one, it has to be rebuilt from candles, and the desk has to keep reading the
 * previous close off *something* while the database is down.
 *
 * One file rather than a file per session, because every consumer wants the
 * whole series: the chart draws it, the RRG needs a hundred sessions of it to
 * produce one coordinate, and the live strip needs only its last line. At ~250
 * sessions times 15 indices it is a few hundred KB.
 */

const COLLECTION = "sector_index_daily";
const FILE = "history.json";

function dir(): string {
  return path.resolve(process.cwd(), RUNTIME_DIR, "sectors");
}

function file(): string {
  return path.join(dir(), FILE);
}

export async function readSeries(): Promise<SectorSeries | null> {
  try {
    return JSON.parse(await readFile(file(), "utf8")) as SectorSeries;
  } catch {
    return null;
  }
}

/**
 * Written through a temp file and renamed into place. A crash mid-write would
 * otherwise leave a truncated history.json, and unlike an EOD report that is
 * not something the next run can regenerate from what it already has.
 */
export async function writeSeries(series: SectorSeries): Promise<void> {
  await mkdir(dir(), { recursive: true });
  const target = file();
  const temp = `${target}.tmp`;
  await writeFile(temp, JSON.stringify(series), "utf8");
  await rename(temp, target);
}

/**
 * Folds newly built sessions onto an existing chain.
 *
 * Pure, and it overwrites rather than concatenates on a date collision: a
 * rebuild of the last session — which is what happens when a scan runs twice on
 * an evening whose candle is still consolidating — must replace that bar, not
 * append a second one and chain the next day off a duplicate.
 */
export function mergeSeries(
  existing: SectorSeries | null,
  built: BuildResult,
  method: string,
  source: SectorSeries["meta"]["source"]
): SectorSeries {
  const sectors: Record<string, SectorBar[]> = {};
  const names = new Set([
    ...Object.keys(existing?.sectors ?? {}),
    ...Object.keys(built.sectors),
  ]);

  for (const name of names) {
    const byDate = new Map<string, SectorBar>();
    for (const bar of existing?.sectors[name] ?? []) byDate.set(bar.date, bar);
    for (const bar of built.sectors[name] ?? []) byDate.set(bar.date, bar);
    sectors[name] = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  const dates = (sectors[BENCHMARK] ?? []).map((bar) => bar.date);
  const base = existing?.meta.base ?? {
    date: dates[0] ?? built.dates[0] ?? "",
    level: BASE_LEVEL,
  };

  return {
    meta: {
      base,
      from: dates[0] ?? "",
      to: dates[dates.length - 1] ?? "",
      builtAt: Date.now(),
      universe: built.universe,
      droppedOutliers: (existing?.meta.droppedOutliers ?? 0) + built.droppedOutliers,
      method,
      source,
    },
    dates,
    sectors,
  };
}

export interface StoredSectorDay {
  _id: string;
  date: string;
  sector: string;
  level: number;
  changePct: number;
  priced: number;
  members: number;
  advances: number;
  declines: number;
  above50: number | null;
  above200: number | null;
  turnover: number | null;
  storedAt: Date;
}

export { isConfigured };

async function collection(): Promise<Collection<StoredSectorDay> | null> {
  const database = await getDb();
  return database ? database.collection<StoredSectorDay>(COLLECTION) : null;
}

export interface MirrorOutcome {
  stored: number;
  skipped: "not-configured" | null;
}

/**
 * Mirrors sessions into Mongo, keyed on date + sector so a rebuilt session
 * converges on one document instead of accumulating a second version of itself.
 *
 * Only the sessions passed in, not the whole series — a daily update writes one
 * day, and only a full backfill pays to write a year.
 */
export async function mirrorSessions(
  sectors: Record<string, SectorBar[]>
): Promise<MirrorOutcome> {
  const target = await collection();
  if (!target) return { stored: 0, skipped: "not-configured" };

  const operations = [];
  for (const [sector, bars] of Object.entries(sectors)) {
    for (const bar of bars) {
      const document: Omit<StoredSectorDay, "_id"> = {
        date: bar.date,
        sector,
        level: bar.level,
        changePct: bar.changePct,
        priced: bar.priced,
        members: bar.members,
        advances: bar.advances,
        declines: bar.declines,
        above50: bar.above50,
        above200: bar.above200,
        turnover: bar.turnover,
        storedAt: new Date(),
      };
      operations.push({
        updateOne: {
          filter: { _id: `${bar.date}:${sector}` },
          update: { $set: document },
          upsert: true,
        },
      });
    }
  }

  if (operations.length === 0) return { stored: 0, skipped: null };

  // Idempotent, and this path runs once a day.
  await target.createIndex({ sector: 1, date: 1 });
  await target.createIndex({ date: -1 });

  let stored = 0;
  // Chunked because a first backfill is a year times fifteen indices, and one
  // bulkWrite of several thousand operations is a needlessly large payload.
  for (let i = 0; i < operations.length; i += 500) {
    const result = await target.bulkWrite(operations.slice(i, i + 500), { ordered: false });
    stored += result.upsertedCount + result.matchedCount;
  }
  return { stored, skipped: null };
}
