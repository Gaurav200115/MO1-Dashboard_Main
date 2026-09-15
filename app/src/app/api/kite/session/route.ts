import { NextResponse } from "next/server";
import { getFeed } from "@/lib/kite/feed";
import { clearSession, readSession } from "@/lib/kite/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await readSession();
  return NextResponse.json({
    connected: session != null,
    userId: session?.userId ?? null,
    userName: session?.userName ?? null,
    expiresAt: session?.expiresAt ?? null,
    feed: getFeed().state(),
  });
}

/** Sign out locally. The token stays valid at Kite until 06:00 IST. */
export async function DELETE() {
  await clearSession();
  return NextResponse.json({ connected: false });
}
