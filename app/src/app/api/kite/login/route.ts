import { NextResponse } from "next/server";
import { readConfig } from "@/lib/kite/config";

export const runtime = "nodejs";

/**
 * Step one of the daily ritual. Kite invalidates every access token at 06:00
 * IST, so this gets visited once each trading morning.
 */
export function GET() {
  const config = readConfig();
  if (!config) {
    return NextResponse.json(
      { error: "KITE_API_KEY / KITE_API_SECRET missing from app/.env.local" },
      { status: 500 }
    );
  }

  const url = new URL("https://kite.zerodha.com/connect/login");
  url.searchParams.set("v", "3");
  url.searchParams.set("api_key", config.apiKey);
  return NextResponse.redirect(url);
}
