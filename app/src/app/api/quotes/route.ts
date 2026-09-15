import { NextResponse } from "next/server";
import { getFeed } from "@/lib/kite/feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Point-in-time snapshot of every quote the feed holds. The desk streams from
 * /api/quotes/stream instead; this exists for a first paint without SSE and for
 * checking the feed by hand with curl.
 */
export async function GET() {
  const feed = getFeed();
  const state = await feed.ensureStarted();
  return NextResponse.json(
    { state, quotes: feed.snapshot() },
    { headers: { "cache-control": "no-store" } }
  );
}
