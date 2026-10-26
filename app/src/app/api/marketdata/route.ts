import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Progress of the overnight market-data download (Dhan + NSE -> PostgreSQL).
 *
 *   GET /api/marketdata
 *
 * The download runs on this same VPS as its own service and writes a small JSON snapshot every
 * minute. Reading that file keeps the desk free of any database credentials. The path can be
 * moved with MARKETDATA_PROGRESS_FILE.
 */
const PROGRESS_FILE =
  process.env.MARKETDATA_PROGRESS_FILE?.trim() || "/opt/marketdata/progress/progress.json";

export async function GET() {
  try {
    const text = await readFile(PROGRESS_FILE, "utf8");
    return NextResponse.json(
      { available: true, progress: JSON.parse(text) },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException)?.code === "ENOENT";
    return NextResponse.json(
      {
        available: false,
        reason: missing
          ? "The download has not run on this server yet."
          : `Could not read the progress file: ${(err as Error).message}`,
      },
      { headers: { "cache-control": "no-store" } }
    );
  }
}
