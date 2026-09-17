import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { mongoMessage } from "@/lib/mongo";
import { istDate } from "@/lib/strategy/ist";
import {
  backfillAllTrades,
  backfillTrades,
  isConfigured,
  tradeDays,
  tradesOn,
} from "@/lib/strategy/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The blotter.
 *
 *   GET /api/trades                      today's trades
 *   GET /api/trades?date=YYYY-MM-DD      that day's
 *   GET /api/trades?strategy=<id>        narrowed to one strategy
 *   GET /api/trades?days=1               the list of days that have trades
 *
 * Served from the on-disk journal, which is written before Mongo on every fill,
 * so the blotter keeps working through a database outage. `configured` reports
 * whether the Mongo mirror is set up at all — the trades themselves do not
 * depend on it.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  try {
    if (params.get("days") === "1") {
      return ok({ days: await tradeDays() });
    }

    const date = params.get("date")?.trim() || istDate();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
    }

    const strategy = params.get("strategy")?.trim() || undefined;
    return ok({ date, trades: await tradesOn(date, strategy) });
  } catch (err) {
    return NextResponse.json(
      { configured: isConfigured(), error: mongoMessage(err) },
      { status: 502, headers: { "cache-control": "no-store" } }
    );
  }
}

/**
 * Mirrors the journal into Mongo. Idempotent — safe to call repeatedly.
 *
 *   POST /api/trades                         today's journal
 *   POST /api/trades?session=YYYY-MM-DD      that day's
 *   POST /api/trades?session=all             every day the journal holds
 *
 * The counterpart to `POST /api/levels`, and here for the same reason: writes
 * take the disk copy as authoritative and treat Mongo as a mirror that is
 * allowed to be behind, which only works if something can catch it up.
 */
export async function POST(request: NextRequest) {
  const session = request.nextUrl.searchParams.get("session")?.trim();

  if (session && session !== "all" && !/^\d{4}-\d{2}-\d{2}$/.test(session)) {
    return NextResponse.json(
      { error: "session must be YYYY-MM-DD or 'all'" },
      { status: 400 }
    );
  }

  if (!isConfigured()) {
    return NextResponse.json(
      { configured: false, error: "MONGO_CONNECTION_STRING is not set" },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }

  try {
    const results =
      session === "all"
        ? await backfillAllTrades()
        : [await backfillTrades(session || istDate())];

    return ok({
      results,
      stored: results.reduce((n, r) => n + r.upserted + r.matched, 0),
    });
  } catch (err) {
    // The journal still holds every one of these, so a failure here costs the
    // mirror and nothing else. 502 says "the database refused", not "lost".
    return NextResponse.json(
      { configured: true, error: mongoMessage(err) },
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
