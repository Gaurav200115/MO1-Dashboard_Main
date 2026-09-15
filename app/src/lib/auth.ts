/**
 * Single-user gate for the desk — self-issued HS256 JWT, no identity provider.
 *
 * The desk has no accounts and never will: it serves one person. So this is not
 * a user system, it is a door. One address and one password live in the
 * environment, and a signed token is minted against them.
 *
 * Why it exists: the app writes nothing to Kite, but it does serve a live
 * position blotter, and `POST /api/eod?force=1` will spend ~6,000 of a
 * rate-limited quote budget for whoever calls it. On a laptop that is nobody's
 * business but yours. On a public URL it is everyone's.
 *
 * Why the credential sits in the environment in the clear: the same file already
 * holds the Kite API secret, which is strictly more dangerous than a password to
 * a read-only desk. Hashing this one would protect nothing that is not already
 * lost if that file leaks, while adding a setup step that has to be redone on
 * every password change. The variable *is* the secret — treat it like the rest
 * of the file.
 *
 * Dependency-free and Web Crypto only, because `middleware.ts` runs on the edge
 * runtime where `node:crypto` and `Buffer` do not exist.
 *
 * Unconfigured means open. A local checkout with none of these set behaves
 * exactly as it did before this file existed — the same handled
 * "not-configured" state the Kite config uses, and for the same reason: a desk
 * that refuses to start because an optional door is missing is worse than no
 * door.
 */

export const SESSION_COOKIE = "desk_session";

/** Thirty days. This is a personal desk; a weekly login prompt is friction, not security. */
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

export interface AuthConfig {
  email: string;
  password: string;
  secret: string;
}

export function readAuthConfig(): AuthConfig | null {
  const email = process.env.DESK_EMAIL?.trim().toLowerCase();
  const password = process.env.DESK_PASSWORD;
  const secret = process.env.AUTH_SECRET?.trim();

  if (!email || !password || !secret) return null;
  return { email, password, secret };
}

/** True when the door is fitted. When false, every request passes. */
export function isAuthEnabled(): boolean {
  return readAuthConfig() !== null;
}

/* ---------- base64url, without Buffer ---------- */

function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const encoder = new TextEncoder();

/* ---------- HS256 ---------- */

interface JwtClaims {
  /** Subject — the signed-in address. */
  sub: string;
  /** Issued at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds. */
  exp: number;
}

const HEADER = b64urlEncode(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/** A standard three-segment JWT, so it reads in any JWT debugger. */
export async function signJwt(email: string, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: JwtClaims = { sub: email, iat: now, exp: now + SESSION_MAX_AGE_S };
  const body = `${HEADER}.${b64urlEncode(encoder.encode(JSON.stringify(claims)))}`;
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(signature))}`;
}

/**
 * The subject of a valid token, or null for anything that fails — wrong shape,
 * bad signature, expired, or an address that is no longer the allowed one.
 *
 * The algorithm is fixed at HS256 here and the token's own `alg` header is never
 * read. That is the whole defence against the classic JWT downgrade, where a
 * forged header of `{"alg":"none"}` persuades a verifier to skip the signature.
 * There is one issuer and one algorithm, so there is nothing to negotiate.
 *
 * The allowlist is re-read on every verify rather than trusted from the claim,
 * so changing DESK_EMAIL revokes every token already issued to the old address,
 * immediately and without a rotation step.
 */
export async function verifyJwt(
  token: string | undefined,
  config: AuthConfig
): Promise<string | null> {
  if (!token) return null;

  const segments = token.split(".");
  if (segments.length !== 3) return null;
  const [header, payload, signature] = segments;

  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(config.secret),
      b64urlDecode(signature),
      encoder.encode(`${header}.${payload}`)
    );
    if (!valid) return null;

    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as JwtClaims;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return null;
    if (typeof claims.sub !== "string" || claims.sub.toLowerCase() !== config.email) return null;

    return claims.sub;
  } catch {
    return null;
  }
}

/**
 * Compares a submitted credential without leaking its length or its matching
 * prefix through timing.
 *
 * Both sides are run through HMAC first so the comparison is always over two
 * 32-byte digests regardless of input length, then `crypto.subtle.verify` does
 * the compare in constant time. A plain `===` on the raw strings would return
 * faster the earlier it finds a differing byte.
 */
export async function credentialMatches(
  submitted: string,
  expected: string,
  secret: string
): Promise<boolean> {
  const key = await hmacKey(secret);
  const expectedDigest = await crypto.subtle.sign("HMAC", key, encoder.encode(expected));
  return crypto.subtle.verify("HMAC", key, expectedDigest, encoder.encode(submitted));
}

/**
 * SameSite=Lax is load-bearing, not a default.
 *
 * Kite's sign-in returns as a top-level GET from an external origin to
 * /api/kite/callback. Lax sends the cookie on exactly that navigation; Strict
 * would withhold it, the callback would be treated as unauthenticated and
 * bounced to the login page, and the request_token would be lost with it.
 */
export function sessionCookieOptions(maxAge: number = SESSION_MAX_AGE_S) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}
