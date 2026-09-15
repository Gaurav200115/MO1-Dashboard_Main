import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { backfillProgress, planBackfill, runBackfill } from "@/lib/eod/backfill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Progress of the run in flight, or the last one to finish. */
export async function GET() {
  return NextResponse.json(backfillProgress(), {
    headers: { "cache-control": "no-store" },
  });
}

/**
 * Rebuilds past sessions from historical open interest.
 *
 *   POST /api/levels/backfill?sessions=2026-09-07,2026-09-08&plan=1   size it
 *   POST /api/levels/backfill?sessions=2026-09-07,2026-09-08          run it
 *
 * The run is deliberately not awaited. It makes one historical call per option
 * contract and takes tens of minutes, which is far longer than any sensible
 * request timeout — so this starts it and hands back a progress handle.
 */
export async function POST(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("sessions");
  if (!raw) {
    return NextResponse.json(
      { error: "sessions is required, e.g. ?sessions=2026-09-07,2026-09-08,2026-09-09" },
      { status: 400 }
    );
  }

  const sessions = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))].sort();
  const malformed = sessions.filter((s) => !/^\d{4}-\d{2}-\d{2}$/.test(s));
  if (malformed.length > 0) {
    return NextResponse.json(
      { error: `Not YYYY-MM-DD: ${malformed.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    console.log("[backfill] POST entered, sessions:", sessions.join(","));
    if (request.nextUrl.searchParams.get("plan") === "1") {
      return NextResponse.json(await planBackfill(sessions));
    }
    const started = runBackfill(sessions);
    console.log("[backfill] runBackfill returned, phase:", started.phase);
    return NextResponse.json(started);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Backfill failed to start" },
      { status: 502 }
    );
  }
}
