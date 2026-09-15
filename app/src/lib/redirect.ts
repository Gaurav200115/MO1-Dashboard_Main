import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * A redirect whose `Location` is a relative reference.
 *
 * `request.nextUrl.origin` is the origin the *server* was reached on, which is
 * not the one the browser used as soon as anything proxies us. Render terminates
 * TLS at its edge and forwards to the app on `http://localhost:10000`, so an
 * absolute redirect built from `nextUrl.origin` tells the browser to go to
 * `http://localhost:10000/...` — which on the user's machine is either nothing
 * at all or, worse, their own dev server.
 *
 * RFC 7231 §7.1.2 allows `Location` to be a relative reference, and the browser
 * resolves it against the URL it actually requested. That is the public one, so
 * the redirect lands in the right place without the server needing to know its
 * own public address.
 *
 * The alternative — reading `X-Forwarded-Host` — would work on Render but means
 * trusting a header that anything reaching the app directly can set, turning a
 * fixed-path redirect into an open redirect. There is nothing to trust here.
 *
 * Callers pass a root-relative path (`/`, `/login?next=%2F`). Cookies still work:
 * `NextResponse` exposes `.cookies` on any response, not just `redirect()` ones.
 */
export function redirectTo(path: string, status: 303 | 307 = 307): NextResponse {
  return new NextResponse(null, { status, headers: { Location: path } });
}

/**
 * Builds a root-relative path with query string, for callers that need params.
 *
 * `URL` is still used for the escaping, against a base that is thrown away — it
 * never reaches the response.
 */
export function pathWithParams(path: string, params: Record<string, string>): string {
  const url = new URL(path, "http://placeholder.invalid");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}

/**
 * The origin the *browser* used, for the one caller that cannot take a relative
 * redirect: Next builds a `URL` from middleware's `Location`, so middleware must
 * emit an absolute one.
 *
 * Prefers the forwarded headers a reverse proxy sets, falling back to `Host` and
 * finally to the request's own origin. On Render the edge overwrites both
 * forwarded headers, so they cannot be spoofed from outside; the fallbacks only
 * matter when nothing is proxying, where they are already correct.
 */
export function publicOrigin(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwarded || request.headers.get("host")?.trim();
  if (!host) return request.nextUrl.origin;
  const proto =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    request.nextUrl.protocol.replace(/:$/, "");
  return `${proto}://${host}`;
}
