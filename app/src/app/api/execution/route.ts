import { NextResponse } from "next/server";
import { liveDesk } from "@/lib/execution/desk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The live-orders switch and the kill switch.
 *
 * Behind the desk login like every route. Turning live orders on also needs
 * LIVE_ALLOWED=true on the server and the word LIVE typed at the desk; neither
 * switch moves while a live position is open - the kill switch is how those
 * are closed.
 *
 *   GET                                   status and today's live positions
 *   POST { action: "mode", mode, confirm }  "live" | "paper"
 *   POST { action: "kill" }               off, and exit every live position
 */
export async function GET() {
  return NextResponse.json(await liveDesk().status(), { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  let body: { action?: string; mode?: string; confirm?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  if (body.action === "kill") {
    const result = await liveDesk().kill();
    return NextResponse.json({ ok: true, ...result, status: await liveDesk().status() });
  }

  if (body.action === "mode" && (body.mode === "live" || body.mode === "paper")) {
    const result = await liveDesk().setMode(body.mode, body.confirm);
    if (!result.ok) return NextResponse.json(result, { status: 409 });
    return NextResponse.json({ ok: true, status: await liveDesk().status() });
  }

  return NextResponse.json({ error: 'Expected { action: "mode", mode } or { action: "kill" }' }, { status: 400 });
}
