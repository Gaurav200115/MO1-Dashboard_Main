import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNTIME_DIR } from "@/lib/kite/config";
import { getDb, isConfigured } from "@/lib/mongo";
import type { LivePosition } from "./types";

/**
 * Every live position, written to disk before anything else and mirrored to
 * Mongo (`live_orders`) after.
 *
 * The same disk-first arrangement as the paper journal, for the same reason
 * with higher stakes: after a restart this file is how the desk knows which
 * orders it has at Zerodha and which positions its stops are protecting. Mongo
 * is the copy the blotter and the analysis read; a database outage costs the
 * mirror, never the record.
 */

function dir(): string {
  return path.resolve(process.cwd(), RUNTIME_DIR, "live");
}

function file(tradingDate: string): string {
  return path.join(dir(), `${tradingDate}.json`);
}

/** Rewritten whole on every change, so writes are serialised through one chain. */
let queue: Promise<unknown> = Promise.resolve();
function serialise<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

export async function readDay(tradingDate: string): Promise<LivePosition[]> {
  try {
    return JSON.parse(await readFile(file(tradingDate), "utf8")) as LivePosition[];
  } catch {
    return [];
  }
}

/** Replaces the day's file with `positions`, then mirrors the one that changed. */
export function saveDay(tradingDate: string, positions: LivePosition[], changed?: LivePosition): Promise<void> {
  return serialise(async () => {
    await mkdir(dir(), { recursive: true });
    await writeFile(file(tradingDate), JSON.stringify(positions, null, 2), { mode: 0o600 });
    if (changed) await mirror(changed);
  });
}

async function mirror(position: LivePosition): Promise<void> {
  if (!isConfigured()) return;
  try {
    const db = await getDb();
    // Keyed on the paper trade id: the upsert takes _id from the filter.
    await db
      ?.collection<LivePosition & { _id: string }>("live_orders")
      .replaceOne({ _id: position.tradeId }, position, { upsert: true });
  } catch (err) {
    // The disk copy is the record; a failed mirror is a line in the log.
    console.warn(`[live] Mongo mirror failed for ${position.tradeId}: ${String(err).slice(0, 160)}`);
  }
}
