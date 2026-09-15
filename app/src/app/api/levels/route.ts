import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { recomputeReport } from "@/lib/eod/recompute";
import {
  listReportSessions,
  readLatestReport,
  readReport,
  writeReport,
} from "@/lib/eod/report";
import {
  getSession,
  isConfigured,
  listSessions,
  storeReport,
  toStoredDay,
  type SessionSummary,
} from "@/lib/eod/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Without `session`, the list of archived sessions — the options for the date
 * picker. With one, that day's stored levels.
 */
export async function GET(request: NextRequest) {
  const session = request.nextUrl.searchParams.get("session");

  if (isConfigured()) {
    try {
      if (!session) {
        return ok({ source: "mongo", sessions: await listSessions() });
      }
      return ok({ source: "mongo", session, days: await getSession(session) });
    } catch (err) {
      // Fall through to disk. Mongo holds a copy for querying; the reports under
      // .kite/eod are the source of truth, so an unreachable database should
      // cost the archive its history, not its contents.
      console.warn(
        "[levels] Mongo unavailable, serving from disk:",
        err instanceof Error ? err.message.split("\n")[0] : err
      );
    }
  }

  return session ? ok(await daysFromDisk(session)) : ok(await sessionsFromDisk());
}

function ok(body: Record<string, unknown>) {
  return NextResponse.json(
    { configured: true, ...body },
    { headers: { "cache-control": "no-store" } }
  );
}

async function sessionsFromDisk() {
  const summaries: SessionSummary[] = [];

  for (const session of await listReportSessions()) {
    const report = await readReport(session);
    if (!report) continue;
    const confirmed = report.stocks.filter((stock) => stock.levels.length > 0);
    if (confirmed.length === 0) continue;

    summaries.push({
      session: report.basedOn,
      tradingFor: report.computedFor,
      stocks: confirmed.length,
      levels: confirmed.reduce((n, stock) => n + stock.levels.length, 0),
      precious: confirmed.reduce(
        (n, stock) => n + stock.levels.filter((level) => level.precious).length,
        0
      ),
      storedAt: new Date(report.verifiedAt ?? report.generatedAt),
    });
  }

  return { source: "disk", sessions: summaries };
}

async function daysFromDisk(session: string) {
  const report = await readReport(session);
  if (!report) return { source: "disk", session, days: [] };

  const days = report.stocks
    .filter((stock) => stock.levels.length > 0)
    .map((stock) => toStoredDay(report, stock))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  return { source: "disk", session, days };
}

/**
 * Archives a report. Idempotent — safe to call repeatedly.
 *
 *   POST /api/levels                              the current report
 *   POST /api/levels?session=YYYY-MM-DD           backfill that stored session
 *   POST /api/levels?session=...&recompute=1      re-run the rule over it first
 *
 * `recompute` exists for backfilling days computed under an older rule, so a
 * backtest sample is not spliced together from two different rules.
 */
export async function POST(request: NextRequest) {
  const session = request.nextUrl.searchParams.get("session");
  const recompute = request.nextUrl.searchParams.get("recompute") === "1";

  let report = session ? await readReport(session) : await readLatestReport();
  if (!report) {
    return NextResponse.json(
      { error: session ? `No stored report for ${session}` : "No report to archive yet" },
      { status: 404 }
    );
  }

  const before = report.stocks.filter((stock) => stock.levels.length > 0).length;
  const beforeLevels = report.stocks.reduce((n, stock) => n + stock.levels.length, 0);

  if (recompute) {
    report = recomputeReport(report);
    // Never `latest` — an older day must not become the day the desk shows.
    await writeReport(report, { latest: false });
  }

  const summary = {
    session: report.basedOn,
    tradingFor: report.computedFor,
    recomputed: recompute,
    before: { stocks: before, levels: beforeLevels },
    after: {
      stocks: report.stocks.filter((stock) => stock.levels.length > 0).length,
      levels: report.stocks.reduce((n, stock) => n + stock.levels.length, 0),
      precious: report.stocks.reduce(
        (n, stock) => n + stock.levels.filter((level) => level.precious).length,
        0
      ),
    },
  };

  // The recompute is already on disk and is the source of truth; a database
  // that is unreachable must not present as though the whole operation failed.
  try {
    const outcome = await storeReport(report);
    return NextResponse.json({ ...summary, ...outcome });
  } catch (err) {
    return NextResponse.json({
      ...summary,
      stored: 0,
      archiveError: err instanceof Error ? err.message.split("\n")[0] : "Archive write failed",
    });
  }
}
