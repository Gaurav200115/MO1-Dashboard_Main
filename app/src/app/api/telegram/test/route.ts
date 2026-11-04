import os from "node:os";
import { NextResponse } from "next/server";
import { sendTelegram } from "@/lib/notify/telegram";
import { istClock, istDate } from "@/lib/strategy/ist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sends one dummy message, to prove the bot token and chat ID are right.
 *
 * Open it in a browser while signed in to the desk. The middleware keeps it
 * behind the same door as every other route, so nobody else can use the desk to
 * message your phone.
 *
 * GET rather than POST so it can be fired from the address bar: it is a test,
 * not part of any flow, and sending it twice harms nothing. The hostname in the
 * message says which machine sent it, local checkout or VPS.
 */
const STATUS = { "not-configured": 500, rejected: 502, unreachable: 504 } as const;

export async function GET() {
  const now = Date.now();
  const text = [
    "MO1 desk: test message",
    `Sent ${istDate(now)} ${istClock(now)} IST from ${os.hostname()}.`,
    "If you can read this, desk alerts will reach you.",
  ].join("\n");

  const result = await sendTelegram(text);
  return NextResponse.json(result, { status: result.ok ? 200 : STATUS[result.kind] });
}
