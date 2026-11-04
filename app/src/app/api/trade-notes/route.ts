import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { mongoMessage } from "@/lib/mongo";
import {
  allNotes,
  cleanComment,
  cleanTags,
  ensureIndexes,
  isConfigured,
  saveNote,
  STARTER_TAGS,
  tagVocabulary,
} from "@/lib/strategy/notes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tags and comments on trades.
 *
 *   GET  /api/trade-notes              every note, plus the tags in use
 *   GET  /api/trade-notes?run=<id>     just one backtest run's notes
 *   POST /api/trade-notes              { id, tags, comment, source, ... }
 *   DELETE /api/trade-notes?id=<id>    clear one trade's note
 *
 * These live in their own collection rather than on the trade documents, which
 * a journal re-mirror replaces wholesale. See lib/strategy/notes.ts.
 *
 * A POST with no tags and no comment clears the note, so there is no separate
 * "untag everything" call — emptying it is the same action.
 */

export async function GET(request: NextRequest) {
  const runId = request.nextUrl.searchParams.get("run")?.trim() || undefined;

  try {
    const [notes, tags] = await Promise.all([allNotes(runId), tagVocabulary()]);
    return ok({ notes, tags, starter: STARTER_TAGS });
  } catch (err) {
    return NextResponse.json(
      { configured: isConfigured(), error: mongoMessage(err) },
      { status: 502, headers: { "cache-control": "no-store" } }
    );
  }
}

export async function POST(request: NextRequest) {
  if (!isConfigured()) {
    return NextResponse.json(
      { configured: false, error: "MONGO_CONNECTION_STRING is not set" },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "expected a JSON body" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const source = body.source === "backtest" ? "backtest" : "live";

  try {
    await ensureIndexes();
    const note = await saveNote(id, {
      tags: cleanTags(body.tags),
      comment: cleanComment(body.comment),
      source,
      runId: typeof body.runId === "string" ? body.runId : null,
      tradingDate: typeof body.tradingDate === "string" ? body.tradingDate : null,
      symbol: typeof body.symbol === "string" ? body.symbol : null,
    });
    // `note` is null when the trade was left with nothing on it, which is a
    // clear rather than a failure — the caller drops it from its own map.
    return ok({ id, note, tags: await tagVocabulary() });
  } catch (err) {
    return NextResponse.json(
      { configured: true, error: mongoMessage(err) },
      { status: 502, headers: { "cache-control": "no-store" } }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id")?.trim();
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  try {
    await saveNote(id, { tags: [], comment: null, source: "live" });
    return ok({ id, note: null, tags: await tagVocabulary() });
  } catch (err) {
    return NextResponse.json(
      { configured: isConfigured(), error: mongoMessage(err) },
      { status: 502, headers: { "cache-control": "no-store" } }
    );
  }
}

function ok(body: Record<string, unknown>) {
  return NextResponse.json(
    { configured: isConfigured(), ...body },
    { headers: { "cache-control": "no-store" } }
  );
}
