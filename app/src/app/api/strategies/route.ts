import { NextResponse } from "next/server";
import { mongoMessage } from "@/lib/mongo";
import { ACTIVE_STRATEGY_IDS, listStrategies } from "@/lib/strategy/registry";
import { isConfigured, listStoredStrategies, syncStrategies } from "@/lib/strategy/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The strategy catalogue.
 *
 * Served from code, not from the database — code is where a rule is reviewed,
 * and a definition that disagreed with the one the engine is running would be
 * worse than no answer. `?stored=1` returns the Mongo mirror instead, which is
 * the only way to see versions that have been retired from the code.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);

  if (url.searchParams.get("stored") === "1") {
    if (!isConfigured()) {
      return NextResponse.json(
        { configured: false, strategies: [] },
        { headers: { "cache-control": "no-store" } }
      );
    }
    try {
      return NextResponse.json(
        { configured: true, strategies: await listStoredStrategies() },
        { headers: { "cache-control": "no-store" } }
      );
    } catch (err) {
      return NextResponse.json({ error: mongoMessage(err) }, { status: 502 });
    }
  }

  return NextResponse.json(
    { strategies: listStrategies(), active: ACTIVE_STRATEGY_IDS },
    { headers: { "cache-control": "no-store" } }
  );
}

/** Mirrors the code-defined catalogue into Mongo. Idempotent. */
export async function POST() {
  try {
    const outcome = await syncStrategies(listStrategies());
    return NextResponse.json(outcome, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: mongoMessage(err) }, { status: 502 });
  }
}
