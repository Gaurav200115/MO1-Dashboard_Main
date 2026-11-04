/**
 * The parts of trade notes that are safe to load in the browser.
 *
 * Kept apart from `notes.ts` because that module imports the MongoDB driver,
 * and a client component importing any value from it drags the whole driver
 * (and the Node built-ins it needs) into the browser bundle, which fails the
 * build. Nothing here may import from `@/lib/mongo` or anything server-only.
 */

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
