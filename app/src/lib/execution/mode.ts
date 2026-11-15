import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNTIME_DIR } from "@/lib/kite/config";

/**
 * Whether real orders are on, and the two server settings that bound it.
 *
 * The switch itself lives on disk, set from the desk, so it survives a
 * restart: a desk that came back up after a crash with live orders silently
 * off would leave its open positions unmanaged-looking, and one that came back
 * silently *on* would trade without anyone having just decided it should.
 *
 *   LIVE_ALLOWED=true   in app/.env.local - without it the switch cannot be
 *                       turned on at all, whatever the desk says
 *   LIVE_MAX_OPEN=1     live positions open at once; paper still runs its 3
 */

export type ExecutionMode = "paper" | "live";

export interface ModeState {
  mode: ExecutionMode;
  changedAt: number | null;
  /** Set when the desk stopped taking live entries on its own - a reconciliation mismatch, the kill switch. */
  halted: string | null;
}

const DEFAULT: ModeState = { mode: "paper", changedAt: null, halted: null };

export function liveAllowed(): boolean {
  return process.env.LIVE_ALLOWED?.trim().toLowerCase() === "true";
}

export function liveMaxOpen(): number {
  const n = Number(process.env.LIVE_MAX_OPEN?.trim());
  return Number.isInteger(n) && n > 0 ? n : 1;
}

function file(): string {
  return path.resolve(process.cwd(), RUNTIME_DIR, "live", "mode.json");
}

const globalRef = globalThis as typeof globalThis & { __executionMode?: ModeState };

export async function readMode(): Promise<ModeState> {
  if (globalRef.__executionMode) return globalRef.__executionMode;
  try {
    const stored = JSON.parse(await readFile(file(), "utf8")) as Partial<ModeState>;
    globalRef.__executionMode = {
      mode: stored.mode === "live" ? "live" : "paper",
      changedAt: stored.changedAt ?? null,
      halted: stored.halted ?? null,
    };
  } catch {
    globalRef.__executionMode = { ...DEFAULT };
  }
  return globalRef.__executionMode;
}

export async function writeMode(next: ModeState): Promise<ModeState> {
  globalRef.__executionMode = next;
  await mkdir(path.dirname(file()), { recursive: true });
  await writeFile(file(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/** Live entries go out only when all three hold. */
export async function liveEntriesOn(): Promise<boolean> {
  const state = await readMode();
  return liveAllowed() && state.mode === "live" && !state.halted;
}
