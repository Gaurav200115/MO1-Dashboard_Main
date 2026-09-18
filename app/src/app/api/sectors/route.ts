import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { updateSectorHistory } from "@/lib/sector/job";
import { seedFromReports } from "@/lib/sector/seed";
import { computeRotation } from "@/lib/sector/rotation";
import { anchorOf } from "@/lib/sector/series";
import { readSeries } from "@/lib/sector/store";
import { BENCHMARK, type SectorBar } from "@/lib/sector/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The stored chain, in three shapes.
 *
 * Split by `view` rather than always returning everything, because the three
 * readers want very different amounts of it: the live strip needs one line (the
 * anchor), the rotation panel needs a computed summary, and only a chart wants
 * a year of bars — and a year of bars for fifteen indices is most of a megabyte
 * that would otherwise be shipped on every desk load.
 */

/** Levels only, for the chart — the breadth and turnover columns are dead weight there. */
function toLine(bars: SectorBar[]): { d: string; v: number }[] {
  return bars.map((bar) => ({ d: bar.date, v: Number(bar.level.toFixed(3)) }));
}

export async function GET(request: NextRequest) {
  const series = await readSeries();
  const view = request.nextUrl.searchParams.get("view") ?? "rotation";

  if (!series) {
    return NextResponse.json(
      { series: null, reason: "no-history" },
      { headers: { "cache-control": "no-store" } }
    );
  }

  const anchor = anchorOf(series);
  const meta = { ...series.meta, sessions: series.dates.length };

  if (view === "meta") {
    return NextResponse.json({ meta, anchor }, { headers: { "cache-control": "no-store" } });
  }

  if (view === "series") {
    const wanted = request.nextUrl.searchParams.get("sector");
    const names = wanted ? [wanted, BENCHMARK] : Object.keys(series.sectors);
    const lines: Record<string, { d: string; v: number }[]> = {};
    for (const name of names) {
      const bars = series.sectors[name];
      if (bars) lines[name] = toLine(bars);
    }
    return NextResponse.json(
      { meta, anchor, lines },
      { headers: { "cache-control": "no-store" } }
    );
  }

  return NextResponse.json(
    { meta, anchor, rotation: computeRotation(series) },
    { headers: { "cache-control": "no-store" } }
  );
}

/**
 * Manual trigger.
 *
 * `?force=1` rebuilds from candles and resets the base date — it does not repair
 * a chain, it replaces one, so every level shifts.
 *
 * `?from=eod` builds the provisional chain out of the EOD reports already on
 * disk. That path needs no Kite session, which is the whole point of it: it is
 * what gets the desk off a daily reset to 1,000 on an evening when the token has
 * already expired. The next signed-in run replaces it.
 */
export async function POST(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  if (params.get("from") === "eod") {
    const outcome = await seedFromReports();
    return NextResponse.json(outcome, { headers: { "cache-control": "no-store" } });
  }

  const outcome = await updateSectorHistory({ force: params.get("force") === "1" });
  return NextResponse.json(outcome, { headers: { "cache-control": "no-store" } });
}
