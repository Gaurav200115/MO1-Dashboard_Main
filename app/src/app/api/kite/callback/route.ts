import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { KiteConnect } from "kiteconnect";
import { requireConfig } from "@/lib/kite/config";
import { getFeed } from "@/lib/kite/feed";
import { nextTokenExpiry, writeSession } from "@/lib/kite/session";

export const runtime = "nodejs";

/**
 * Step two: Kite redirects here with a request_token, which is exchanged for the
 * access_token. `generateSession` computes the SHA-256(api_key + request_token +
 * api_secret) checksum for us; the secret never leaves this handler.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const requestToken = params.get("request_token");
  const status = params.get("status");
  const home = new URL("/", request.nextUrl.origin);

  if (status && status !== "success") {
    home.searchParams.set("kite", "denied");
    return NextResponse.redirect(home);
  }
  if (!requestToken) {
    home.searchParams.set("kite", "no-token");
    return NextResponse.redirect(home);
  }

  try {
    const { apiKey, apiSecret } = requireConfig();
    const kc = new KiteConnect({ api_key: apiKey });
    const session = await kc.generateSession(requestToken, apiSecret);

    await writeSession({
      accessToken: session.access_token,
      userId: session.user_id,
      userName: session.user_name ?? null,
      mintedAt: Date.now(),
      expiresAt: nextTokenExpiry(),
    });

    // The socket may be holding yesterday's token, which is now worthless.
    void getFeed().restart();

    /*
     * The whole daily chain hangs off this handler.
     *
     * The scan and the engine both need a session, so on a trading morning both
     * will have failed at boot and have to run here instead. That is true even
     * on a long-lived server — more so, in fact, since `instrumentation.ts` only
     * fires once per process and a hosted box may not restart for weeks, which
     * would leave the desk serving whichever session was settled at deploy time.
     * Sign-in is the one event that reliably happens once a trading day.
     *
     * The cached NFO dump is dropped first because it was resolved under a token
     * that has since been replaced.
     */
    const { resetOptionUniverse } = await import("@/lib/strategy/options");
    const { kickDailyStartup } = await import("@/lib/startup");
    resetOptionUniverse();
    kickDailyStartup("sign-in");

    home.searchParams.set("kite", "connected");
    return NextResponse.redirect(home);
  } catch (err) {
    home.searchParams.set("kite", "failed");
    home.searchParams.set(
      "reason",
      err instanceof Error ? err.message.slice(0, 140) : "Token exchange failed"
    );
    return NextResponse.redirect(home);
  }
}
