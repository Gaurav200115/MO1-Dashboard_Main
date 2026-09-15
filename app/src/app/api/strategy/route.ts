import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { engineFor, engines, startStrategies, stopStrategies } from "@/lib/strategy/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live engine state.
 *
 * `?symbols=<id>` adds the per-stock machine state, which is what answers the
 * only question worth asking mid-session: this stock broke its level and nothing
 * happened — why? The answer is usually a phase or a note, not a bug.
 */
export async function GET(request: NextRequest) {
  const wanted = request.nextUrl.searchParams.get("symbols");

  const running = engines().map((engine) => engine.snapshot());

  if (wanted) {
    const engine = engineFor(wanted);
    if (!engine) {
      return NextResponse.json({ error: `No engine for "${wanted}"` }, { status: 404 });
    }
    return NextResponse.json(
      { engines: running, symbols: engine.symbolStatuses() },
      { headers: { "cache-control": "no-store" } }
    );
  }

  return NextResponse.json({ engines: running }, { headers: { "cache-control": "no-store" } });
}

/**
 * Start or stop the live engines.
 *
 *   POST /api/strategy            start every active strategy (idempotent)
 *   POST /api/strategy?stop=1     stop them
 *
 * Starting is the same call the server makes on boot; it exists here because the
 * engine needs a signed-in Kite session, and on a trading morning the sign-in
 * happens long after the server started.
 */
export async function POST(request: NextRequest) {
  if (request.nextUrl.searchParams.get("stop") === "1") {
    stopStrategies();
    return NextResponse.json(
      { stopped: true, engines: engines().map((engine) => engine.snapshot()) },
      { headers: { "cache-control": "no-store" } }
    );
  }

  try {
    return NextResponse.json(
      { engines: await startStrategies() },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not start the strategy engine" },
      { status: 502 }
    );
  }
}
