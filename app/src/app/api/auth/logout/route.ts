import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Drops the desk cookie. The Kite session is untouched and stays valid until
 * 06:00 IST — signing out of the desk is not signing out of the broker, and
 * conflating them would silently kill a running strategy engine.
 */
export function GET(request: NextRequest) {
  const response = NextResponse.redirect(new URL("/login", request.nextUrl.origin));
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
