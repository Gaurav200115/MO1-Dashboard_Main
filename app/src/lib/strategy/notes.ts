import type { Collection } from "mongodb";
import { getDb, isConfigured } from "@/lib/mongo";

/**
 * Tags and comments on individual trades — your read on what happened, kept
 * apart from what the engine recorded.
 *
 * **Its own collection, deliberately.** `backfillTrades` mirrors a day from the
 * disk journal with `replaceOne`, so anything written onto a trade document is
 * wiped the next time that day is re-mirrored — silently, and only for the days
 * that happen to get re-run. Annotations keyed by trade id in a separate
 * collection cannot be lost that way, and the same arrangement lets a backtest
 * trade be tagged with no change to how runs are stored.
 *
 * A note with no tags and no comment is deleted rather than stored empty, so
 * "has this trade been looked at" stays a question the data can answer.
 */

const NOTES = "trade_notes";

export { isConfigured };

export type NoteSource = "live" | "backtest";

export interface TradeNote {
  /** The trade's own `_id` — live and backtest ids cannot collide. */
  _id: string;
  tags: string[];
  comment: string | null;
  source: NoteSource;
  /** Set for a backtest trade, so a run's notes can be found or removed together. */
  runId?: string | null;
  /** Denormalised so the notes collection is readable on its own. */
  tradingDate?: string | null;
  symbol?: string | null;
  updatedAt: Date;
}

/**
 * The tags offered before you have made any of your own.
 *
 * Chosen from what the record has already shown rather than invented: the first
 * post-mortem found trades filled far above the market on strikes with no book,
 * and the exit analysis found trades that reached 2R and still closed red.
 * Those are the two things worth being able to count. The list is a starting
 * point — any tag you type is remembered and offered alongside these.
 */
export const STARTER_TAGS: { tag: string; hint: string }[] = [
  { tag: "bad fill", hint: "Filled far from where the contract was actually trading" },
  { tag: "thin book", hint: "Barely any size on the other side" },
  { tag: "slipped", hint: "Exit was worse than the stop it should have got" },
  { tag: "gave it back", hint: "Ran up, then closed red or at scratch" },
  { tag: "good setup", hint: "The rule did exactly what it is meant to do" },
  { tag: "news", hint: "Something outside the chart moved it" },
  { tag: "review", hint: "Come back to this one" },
];

/** Trimmed, lower-cased, de-duplicated, order kept. Caps length and count. */
export function cleanTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const tag = String(raw).trim().toLowerCase().replace(/\s+/g, " ").slice(0, 40);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= 12) break;
  }
  return out;
}

export function cleanComment(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const text = input.trim().slice(0, 2000);
  return text.length > 0 ? text : null;
}

async function notes(): Promise<Collection<TradeNote> | null> {
  const db = await getDb();
  return db ? db.collection<TradeNote>(NOTES) : null;
}

export async function ensureIndexes(): Promise<void> {
  const collection = await notes();
  if (!collection) return;
  await collection.createIndex({ tags: 1 });
  await collection.createIndex({ runId: 1 });
  await collection.createIndex({ updatedAt: -1 });
}

/** Every note, as a map keyed by trade id. Small enough to read whole. */
export async function allNotes(runId?: string): Promise<Record<string, TradeNote>> {
  const collection = await notes();
  if (!collection) return {};
  const query = runId ? { runId } : {};
  const rows = await collection.find(query).toArray();
  return Object.fromEntries(rows.map((row) => [row._id, row]));
}

export async function notesFor(ids: string[]): Promise<Record<string, TradeNote>> {
  if (ids.length === 0) return {};
  const collection = await notes();
  if (!collection) return {};
  const rows = await collection.find({ _id: { $in: ids } }).toArray();
  return Object.fromEntries(rows.map((row) => [row._id, row]));
}

/**
 * Writes one trade's note, or removes it when nothing is left on it.
 *
 * Returns the stored note, or null when it was cleared — so the caller can
 * update its own state without a second read.
 */
export async function saveNote(
  id: string,
  fields: {
    tags: string[];
    comment: string | null;
    source: NoteSource;
    runId?: string | null;
    tradingDate?: string | null;
    symbol?: string | null;
  }
): Promise<TradeNote | null> {
  const collection = await notes();
  if (!collection) throw new Error("MongoDB is not configured");

  const tags = cleanTags(fields.tags);
  const comment = cleanComment(fields.comment);

  if (tags.length === 0 && comment === null) {
    await collection.deleteOne({ _id: id });
    return null;
  }

  const note: TradeNote = {
    _id: id,
    tags,
    comment,
    source: fields.source,
    runId: fields.runId ?? null,
    tradingDate: fields.tradingDate ?? null,
    symbol: fields.symbol ?? null,
    updatedAt: new Date(),
  };
  await collection.replaceOne({ _id: id }, note, { upsert: true });
  return note;
}

/** Removes every note belonging to a backtest run — called when the run is deleted. */
export async function deleteRunNotes(runId: string): Promise<void> {
  const collection = await notes();
  if (!collection) return;
  await collection.deleteMany({ runId });
}

/**
 * Every tag in use, most-used first, with its count — plus the starter tags.
 *
 * Built from the notes themselves rather than from a vocabulary list that would
 * have to be kept in step with them. A tag stops being offered once the last
 * trade carrying it is untagged, which is the behaviour you want: the list
 * describes what you actually use.
 */
export async function tagVocabulary(): Promise<{ tag: string; count: number; starter: boolean }[]> {
  const starter = new Set(STARTER_TAGS.map((s) => s.tag));
  const counts = new Map<string, number>();

  const collection = await notes();
  if (collection) {
    const rows = await collection.find({}, { projection: { tags: 1 } }).toArray();
    for (const row of rows) {
      for (const tag of row.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  const used = [...counts.entries()]
    .map(([tag, count]) => ({ tag, count, starter: starter.has(tag) }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  const unused = STARTER_TAGS.filter((s) => !counts.has(s.tag)).map((s) => ({
    tag: s.tag,
    count: 0,
    starter: true,
  }));

  return [...used, ...unused];
}
