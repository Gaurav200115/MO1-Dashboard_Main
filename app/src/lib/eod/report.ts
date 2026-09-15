import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNTIME_DIR } from "@/lib/kite/config";
import type { Candle } from "@/lib/kite/history";
import { istDateString } from "@/lib/kite/history";
import type { EodReport } from "./types";

export type { EodReport, SessionOhlc, SpecialStock } from "./types";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

/**
 * The exchange closes at 15:30 IST and the daily candle settles shortly after.
 * Before this hour, today's candle is still forming and its high, low and close
 * are all provisional — so a scan that ran mid-session would compute pivots from
 * a partial range.
 */
const SESSION_SETTLED_HOUR_IST = 16;

function eodDir(): string {
  return path.resolve(process.cwd(), RUNTIME_DIR, "eod");
}

function reportFile(session: string): string {
  return path.join(eodDir(), `${session}.json`);
}

function latestFile(): string {
  return path.join(eodDir(), "latest.json");
}

function istHour(now: number): number {
  return new Date(now + IST_OFFSET_MS).getUTCHours();
}

/**
 * The last candle whose session has finished. Walking back from the end rather
 * than assuming "yesterday" keeps this correct across weekends and holidays —
 * whatever the exchange last published is what we use, and no holiday calendar
 * is needed anywhere in the pipeline.
 */
export function lastSettledCandle(candles: Candle[], now = Date.now()): Candle | null {
  const today = istDateString(now);
  const settled = istHour(now) >= SESSION_SETTLED_HOUR_IST;

  for (let i = candles.length - 1; i >= 0; i--) {
    const date = istDateString(candles[i].t);
    if (date < today || settled) return candles[i];
  }
  return null;
}

/**
 * Best-effort label for the session these levels apply to. Weekends are skipped;
 * exchange holidays are not, since that would need a calendar we deliberately
 * do not depend on. `basedOn` is the load-bearing field — this one is a caption.
 */
export function nextSessionDate(session: string): string {
  const cursor = new Date(`${session}T00:00:00.000Z`);
  do {
    cursor.setTime(cursor.getTime() + DAY_MS);
  } while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6);
  return cursor.toISOString().slice(0, 10);
}

/** Session dates that have a report on disk, newest first. */
export async function listReportSessions(): Promise<string[]> {
  try {
    const files = await readdir(eodDir());
    return files
      .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
      .map((file) => file.slice(0, 10))
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

export async function readReport(session: string): Promise<EodReport | null> {
  try {
    return JSON.parse(await readFile(reportFile(session), "utf8")) as EodReport;
  } catch {
    return null;
  }
}

export async function readLatestReport(): Promise<EodReport | null> {
  try {
    return JSON.parse(await readFile(latestFile(), "utf8")) as EodReport;
  } catch {
    return null;
  }
}

/**
 * Archived under its own session date as well as `latest`, so the levels a day
 * was traded against stay recoverable after the next evening overwrites latest.
 *
 * `latest: false` when rewriting a historical session — recomputing an older day
 * under a changed rule must not make it the day the desk shows.
 */
export async function writeReport(
  report: EodReport,
  opts?: { latest?: boolean }
): Promise<void> {
  await mkdir(eodDir(), { recursive: true });
  const body = JSON.stringify(report, null, 2);
  await writeFile(reportFile(report.basedOn), body);
  if (opts?.latest !== false) await writeFile(latestFile(), body);
}
