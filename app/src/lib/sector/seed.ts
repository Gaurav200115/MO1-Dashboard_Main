import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadFloatTable } from "@/lib/float";
import type { Candle } from "@/lib/kite/history";
import { listReportSessions, readReport } from "@/lib/eod/report";
import type { DeskIndex } from "@/lib/types";
import { buildSeries } from "./series";
import { mergeSeries, mirrorSessions, writeSeries } from "./store";

/**
 * A provisional chain built from the EOD reports already on disk.
 *
 * The real backfill needs a Kite session, and the token dies at 06:00 IST every
 * day — so on an evening when nobody has signed in there is no way to reach a
 * year of candles. The reports under `.kite/eod` already carry one settled OHLC
 * per stock per session, which is exactly the input the chain needs, so this
 * turns whatever has accumulated there into a working index immediately.
 *
 * Two honest limits, which is why the result is tagged `eod-reports` rather than
 * `candles`:
 *
 *   - It covers only the stocks the EOD scan reaches, which is the F&O list —
 *     about 184 of the 200. The missing names carry no weight, so a sector whose
 *     members are mostly cash-only is thinner here than it will be later.
 *   - It reaches back only as far as the oldest stored report, which is days,
 *     not a year. Enough for the live strip to stop restarting at 1,000; not
 *     nearly enough for the rotation coordinates, which need a hundred sessions.
 *
 * The daily job replaces a chain tagged this way rather than extending it, so
 * the first signed-in run rebuilds the whole thing from candles and this seed
 * disappears without anyone having to remember to delete it.
 */

const METHOD =
  "Free-float market-cap weighted, chained daily from EOD report closes (F&O universe only) " +
  "pending a full candle backfill.";

export interface SeedOutcome {
  ran: boolean;
  reason: "seeded" | "no-reports" | "failed";
  detail?: string;
  sessions?: number;
  from?: string;
  to?: string;
  symbols?: number;
}

async function loadIndex(): Promise<DeskIndex> {
  const file = path.join(process.cwd(), "public", "data", "index.json");
  return JSON.parse(await readFile(file, "utf8")) as DeskIndex;
}

export async function seedFromReports(): Promise<SeedOutcome> {
  const sessions = (await listReportSessions()).sort();
  if (sessions.length < 2) {
    return {
      ran: false,
      reason: "no-reports",
      detail: `${sessions.length} stored report(s) — a chain needs at least two sessions`,
    };
  }

  const candles: Record<string, Candle[]> = {};

  for (const session of sessions) {
    const report = await readReport(session);
    if (!report) continue;

    for (const stock of report.stocks) {
      // Its own settled session, not the report date — a stock that did not
      // trade that day carries the session it actually had, and writing it under
      // the report date would invent a close it never printed.
      const date = stock.session.date;
      const close = stock.session.close;
      if (!Number.isFinite(close) || close <= 0) continue;

      // Midnight UTC lands on the same IST date once istDateString adds its
      // offset, which is the only property of `t` the builder reads.
      const t = Date.parse(`${date}T00:00:00.000Z`);
      const bucket = (candles[stock.symbol] ??= []);
      if (bucket.some((candle) => candle.t === t)) continue;

      // Volume is not in the report, so turnover stays null for these sessions
      // rather than being guessed at.
      bucket.push({ t, o: close, h: stock.session.high, l: stock.session.low, c: close, v: 0 });
    }
  }

  for (const series of Object.values(candles)) series.sort((a, b) => a.t - b.t);

  const symbols = Object.keys(candles).length;
  if (symbols === 0) return { ran: false, reason: "no-reports", detail: "No closes in the reports" };

  const index = await loadIndex();
  const floats = await loadFloatTable(index.companies.map((company) => company.symbol));

  const built = buildSeries({ companies: index.companies, candles, floats });
  if (built.dates.length === 0) {
    return { ran: false, reason: "failed", detail: "No session cleared the quorum rule" };
  }

  const merged = mergeSeries(null, built, METHOD, "eod-reports");
  await writeSeries(merged);

  try {
    const outcome = await mirrorSessions(built.sectors);
    if (outcome.skipped !== "not-configured") {
      console.log(`[sectors] seed mirrored ${outcome.stored} index-days`);
    }
  } catch (err) {
    console.warn("[sectors] seed mirror failed:", err instanceof Error ? err.message : err);
  }

  return {
    ran: true,
    reason: "seeded",
    sessions: built.dates.length,
    from: built.dates[0],
    to: built.dates[built.dates.length - 1],
    symbols,
    detail: `${Object.keys(merged.sectors).length - 1} sector indices, provisional until a candle backfill`,
  };
}
