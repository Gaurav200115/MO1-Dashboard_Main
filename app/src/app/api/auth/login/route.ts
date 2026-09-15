import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { pathWithParams, redirectTo } from "@/lib/redirect";
import {
  credentialMatches,
  readAuthConfig,
  SESSION_COOKIE,
  sessionCookieOptions,
  signJwt,
} from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Only ever bounce back inside this app — `//evil.com` is a valid path prefix otherwise. */
function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

/** The middleware redirects unauthenticated page loads here; send them to the form. */
export function GET(request: NextRequest) {
  const next = request.nextUrl.searchParams.get("next");
  return redirectTo(pathWithParams("/login", next ? { next } : {}));
}

/**
 * Checks the one credential pair and mints the session token.
 *
 * Accepts a form post so the login page needs no JavaScript — a plain <form>
 * that works before hydration is one less thing between you and the desk at
 * 09:10. A JSON body is accepted too, for curl.
 */
export async function POST(request: NextRequest) {
  const config = readAuthConfig();
  if (!config) {
    return NextResponse.json(
      { error: "Auth is not configured. Set DESK_EMAIL, DESK_PASSWORD and AUTH_SECRET." },
      { status: 500 }
    );
  }

  let email = "";
  let password = "";
  let next = safeNext(request.nextUrl.searchParams.get("next"));
  const wantsJson = request.headers.get("content-type")?.includes("application/json");

  try {
    if (wantsJson) {
      const body = (await request.json()) as { email?: string; password?: string };
      email = body.email ?? "";
      password = body.password ?? "";
    } else {
      const form = await request.formData();
      email = String(form.get("email") ?? "");
      password = String(form.get("password") ?? "");
      next = safeNext(String(form.get("next") ?? "") || next);
    }
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  /*
   * Both halves are always compared, even when the address is already wrong.
   * Short-circuiting on the email would make a wrong address measurably faster
   * than a wrong password and turn the form into an oracle for which one it is.
   */
  const emailOk = await credentialMatches(email.trim().toLowerCase(), config.email, config.secret);
  const passwordOk = await credentialMatches(password, config.password, config.secret);

  if (!emailOk || !passwordOk) {
    if (wantsJson) {
      return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
    }
    return redirectTo(
      pathWithParams("/login", next !== "/" ? { error: "1", next } : { error: "1" }),
      303
    );
  }

  const token = await signJwt(config.email, config.secret);

  // 303 so the browser follows with GET — a 307 would replay the POST at the desk.
  const response = wantsJson ? NextResponse.json({ ok: true, next }) : redirectTo(next, 303);

  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return response;
}
