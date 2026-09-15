import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { runEodScan } from "@/lib/eod/job";
import { readLatestReport } from "@/lib/eod/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The stored report, or with `?meta=1` just its stamp — enough for an open tab
 * to notice the report was replaced without pulling the whole payload back.
 * That matters because the overnight verification rewrites the levels, and a
 * tab left open since the evening would otherwise keep showing provisional ones.
 */
export async function GET(request: NextRequest) {
  const report = await readLatestReport();

  if (request.nextUrl.searchParams.get("meta") === "1") {
    return NextResponse.json(
      {
        meta: report
          ? {
              basedOn: report.basedOn,
              generatedAt: report.generatedAt,
              verifiedAt: report.verifiedAt,
            }
          : null,
      },
      { headers: { "cache-control": "no-store" } }
    );
  }

  return NextResponse.json({ report }, { headers: { "cache-control": "no-store" } });
}

/**
 * Manual trigger. `?force=1` recomputes a session that already has a report —
 * otherwise this is the same idempotent call the server makes on boot.
 */
export async function POST(request: NextRequest) {
  const force = request.nextUrl.searchParams.get("force") === "1";
  const outcome = await runEodScan({ force });
  return NextResponse.json(outcome, { headers: { "cache-control": "no-store" } });
}
