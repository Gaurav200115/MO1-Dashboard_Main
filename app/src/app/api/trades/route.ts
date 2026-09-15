import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { mongoMessage } from "@/lib/mongo";
import { istDate } from "@/lib/strategy/ist";
import { isConfigured, tradeDays, tradesOn } from "@/lib/strategy/store";

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

function ok(body: Record<string, unknown>) {
  return NextResponse.json(
    { configured: isConfigured(), ...body },
    { headers: { "cache-control": "no-store" } }
  );
}
