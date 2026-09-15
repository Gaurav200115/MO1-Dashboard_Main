import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { readAuthConfig, SESSION_COOKIE, verifyJwt } from "@/lib/auth";
import { pathWithParams, publicOrigin } from "@/lib/redirect";

/**
 * The door. Everything that is not the sign-in flow itself needs a valid
 * session cookie.
 *
 * /api/kite/callback is deliberately *not* exempt. It is reached as a top-level
 * navigation from Kite while you are already signed in here, so the Lax cookie
 * rides along and it authenticates like any other request. Exempting it would
 * leave the one endpoint that mints a broker token open to anyone.
 */

/** The sign-in flow cannot require a session to reach the sign-in flow. */
const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/auth/logout"];

export async function middleware(request: NextRequest) {
  const config = readAuthConfig();
  // Unconfigured means open — a local checkout is unchanged. See lib/auth.ts.
  if (!config) return NextResponse.next();

  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.includes(pathname)) return NextResponse.next();

  const email = await verifyJwt(request.cookies.get(SESSION_COOKIE)?.value, config);
  if (email) return NextResponse.next();

  /*
   * An API caller gets a status it can act on; a browser gets sent to Google.
   * Redirecting an unauthenticated fetch would hand the caller a login page with
   * a 200 on it, which reads as success and fails much later and less clearly.
   */
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Not signed in", signInAt: "/api/auth/login" },
      { status: 401 }
    );
  }

  const login = new URL(pathWithParams("/login", { next: pathname + request.nextUrl.search }), publicOrigin(request));
  return NextResponse.redirect(login);
}

/**
 * Static assets are skipped in the matcher rather than in the handler, so the
 * edge function is never invoked for them at all. `_next/static` and
 * `_next/image` carry no secrets, and gating them would put an HMAC verify in
 * front of every chunk the desk loads.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
