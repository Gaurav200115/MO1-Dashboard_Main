/**
 * Credentials live in app/.env.local and never leave the server.
 *
 * Read lazily rather than at module load: a missing key has to surface as a
 * handled "not configured" state, because throwing at import time in Next takes
 * down every route that touches this module, including the login route you'd
 * need to fix it.
 */

export interface KiteConfig {
  apiKey: string;
  apiSecret: string;
}

/**
 * Where the session file, caches, EOD reports and the trade journal live.
 *
 * Relative by default, so a local checkout keeps everything in `app/.kite` and
 * stays gitignored — see app/.gitignore. A hosted deployment sets
 * KITE_RUNTIME_DIR to the absolute mount path of its persistent volume
 * (Render mounts at e.g. /var/data), because none of this may live on the
 * ephemeral disk: losing session.json mid-session means a forced re-login, and
 * losing the journal means losing fills that cannot be recomputed.
 *
 * Every consumer resolves this with `path.resolve(process.cwd(), RUNTIME_DIR)`
 * rather than `path.join`, which is what lets one constant carry both cases —
 * resolve returns the absolute path unchanged and joins the relative one onto
 * the working directory.
 */
export const RUNTIME_DIR = process.env.KITE_RUNTIME_DIR?.trim() || ".kite";

/** How often the browser is allowed a re-render. See the coalescer in feed.ts. */
export const FLUSH_MS = 500;

export function readConfig(): KiteConfig | null {
  const apiKey = process.env.KITE_API_KEY?.trim();
  const apiSecret = process.env.KITE_API_SECRET?.trim();
  if (!apiKey || !apiSecret) return null;
  return { apiKey, apiSecret };
}

export function requireConfig(): KiteConfig {
  const config = readConfig();
  if (!config) {
    throw new Error(
      "KITE_API_KEY / KITE_API_SECRET missing. Add both to app/.env.local as KEY=value."
    );
  }
  return config;
}
