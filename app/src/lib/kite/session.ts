import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNTIME_DIR } from "./config";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

export interface KiteSession {
  accessToken: string;
  userId: string;
  userName: string | null;
  mintedAt: number;
  /** Epoch ms of the 06:00 IST wall at which Kite invalidates this token. */
  expiresAt: number;
}

function sessionFile(): string {
  return path.resolve(process.cwd(), RUNTIME_DIR, "session.json");
}

/**
 * Kite kills every access token at 06:00 IST regardless of when it was minted,
 * so expiry is a wall-clock boundary and not a duration. Computed in an
 * IST-shifted epoch space so the answer never depends on the server timezone.
 */
export function nextTokenExpiry(now = Date.now()): number {
  const ist = now + IST_OFFSET_MS;
  const sixAmToday = Math.floor(ist / DAY_MS) * DAY_MS + 6 * 3_600_000;
  const target = ist < sixAmToday ? sixAmToday : sixAmToday + DAY_MS;
  return target - IST_OFFSET_MS;
}

/** Null whenever there is no usable token — missing file, bad JSON, or past 06:00. */
export async function readSession(): Promise<KiteSession | null> {
  try {
    const session = JSON.parse(await readFile(sessionFile(), "utf8")) as KiteSession;
    if (!session.accessToken || Date.now() >= session.expiresAt) return null;
    return session;
  } catch {
    return null;
  }
}

export async function writeSession(session: KiteSession): Promise<void> {
  await mkdir(path.dirname(sessionFile()), { recursive: true });
  await writeFile(sessionFile(), JSON.stringify(session, null, 2), { mode: 0o600 });
}

export async function clearSession(): Promise<void> {
  try {
    await unlink(sessionFile());
  } catch {
    // already gone
  }
}
