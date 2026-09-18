import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadFloatTable } from "@/lib/float";
import { dailyCandles, NoSessionError, type Candle } from "@/lib/kite/history";
import { readSession } from "@/lib/kite/session";
import type { DeskIndex } from "@/lib/types";
import { anchorOf, buildSeries } from "./series";
import { mergeSeries, mirrorSessions, readSeries, writeSeries } from "./store";
import { BENCHMARK, type SectorSeries } from "./types";

/**
 * Keeps the chained sector indices current.
 *
 * One entry point for both jobs, because they are the same job. With no history
 * on disk it builds a year from scratch and sets the base at 1,000; with a
 * history it re-walks the same candles and emits only the sessions after the
 * last stored one, chaining them onto it. A machine that was off for a week
 * catches up on the next run without anything special happening — which is the
 * property that matters, since a chain with a hole in it is not repairable from
 * the next session.
 *
 * Cost is near zero when it runs after the EOD scan: that scan already pulled a
 * year of daily candles for every F&O name and the history cache holds them for
 * six hours, so all this pays for is the handful of Nifty 200 members that have
 * no options.
 */

const METHOD =
  "Free-float market-cap weighted, chained daily from candle closes. Weights re-derive " +
  "from the previous close each session; float factors and membership are the current " +
  "snapshot applied backwards.";

export interface SectorJobOutcome {
  ran: boolean;
  reason: "built" | "extended" | "up-to-date" | "no-session" | "in-flight" | "failed";
  detail?: string;
  from?: string;
  to?: string;
  sessions?: number;
  /** Symbols whose candles could not be read; they carry no weight that day. */
  failed?: string[];
}

async function loadIndex(): Promise<DeskIndex> {
  const file = path.join(process.cwd(), "public", "data", "index.json");
  return JSON.parse(await readFile(file, "utf8")) as DeskIndex;
}

async function run(force: boolean): Promise<SectorJobOutcome> {
  const session = await readSession();
  if (!session) return { ran: false, reason: "no-session", detail: "Sign in to Kite first" };

  const index = await loadIndex();
  const floats = await loadFloatTable(index.companies.map((company) => company.symbol));

  const stored = await readSeries();

  /*
   * A chain seeded from the EOD reports is replaced, not extended. It covers
   * only the F&O names and only the few sessions those reports go back, so
   * chaining a year of real candles onto its tail would preserve a base that is
   * both too short and built from the wrong universe — and would do it silently,
   * since every level after it would still look like a valid index.
   */
  const provisional = stored != null && stored.meta.source !== "candles";
  const existing = force || provisional ? null : stored;
  const seed = existing ? anchorOf(existing) : null;

  if (provisional && !force) {
    console.log(
      `[sectors] replacing the provisional ${stored?.meta.source} chain with a full candle backfill`
    );
  }

  const candles: Record<string, Candle[]> = {};
  const failed: string[] = [];

  for (const company of index.companies) {
    if (!floats[company.symbol]) continue;
    try {
      candles[company.symbol] = await dailyCandles(company.symbol, { background: true });
    } catch (err) {
      if (err instanceof NoSessionError) throw err;
      failed.push(company.symbol);
    }
  }

  if (Object.keys(candles).length === 0) {
    return { ran: false, reason: "failed", detail: "No candles could be read" };
  }

  const built = buildSeries({
    companies: index.companies,
    candles,
    floats,
    seed: seed ?? undefined,
  });

  if (built.dates.length === 0) {
    return {
      ran: false,
      reason: "up-to-date",
      detail: seed ? `Chain already runs to ${seed.date}` : "No settled session yet",
      to: seed?.date,
    };
  }

  const merged = mergeSeries(existing, built, METHOD, "candles");
  await writeSeries(merged);
  await mirror(built.sectors, merged);

  if (built.droppedOutliers > 0) {
    console.warn(
      `[sectors] ${built.droppedOutliers} constituent-days rejected as corporate actions — ` +
        "check whether Kite is serving unadjusted candles for a symbol"
    );
  }

  return {
    ran: true,
    reason: existing ? "extended" : "built",
    from: built.dates[0],
    to: built.dates[built.dates.length - 1],
    sessions: built.dates.length,
    failed: failed.length > 0 ? failed : undefined,
    detail: `${Object.keys(merged.sectors).length - 1} sector indices + ${BENCHMARK}`,
  };
}

/**
 * The mirror is analysis, not the desk. A Mongo that is down must not cost us
 * the chain we just wrote to disk — and must not leave the caller thinking the
 * write failed, since the file is the source of truth either way.
 */
async function mirror(
  fresh: SectorSeries["sectors"],
  merged: SectorSeries
): Promise<void> {
  try {
    const outcome = await mirrorSessions(fresh);
    if (outcome.skipped === "not-configured") {
      console.log("[sectors] mirror skipped — MONGO_CONNECTION_STRING not set");
    } else {
      console.log(
        `[sectors] chain now ${merged.meta.from} to ${merged.meta.to}; ` +
          `mirrored ${outcome.stored} index-days`
      );
    }
  } catch (err) {
    console.warn("[sectors] mirror failed:", err instanceof Error ? err.message : err);
  }
}

const globalRef = globalThis as typeof globalThis & {
  __sectorJobInFlight?: Promise<SectorJobOutcome> | null;
};

/**
 * Single-flight, for the same reason the EOD scan is: boot and a sign-in
 * arriving together must not both walk 200 symbols of history, and two writers
 * racing on one chain file could interleave a session.
 */
export function updateSectorHistory(opts?: { force?: boolean }): Promise<SectorJobOutcome> {
  if (globalRef.__sectorJobInFlight) {
    return globalRef.__sectorJobInFlight.then((outcome) =>
      outcome.ran ? outcome : { ...outcome, reason: "in-flight" as const }
    );
  }

  const job = run(opts?.force ?? false)
    .catch((err: unknown): SectorJobOutcome => {
      const detail = err instanceof Error ? err.message : String(err);
      if (err instanceof NoSessionError) return { ran: false, reason: "no-session", detail };
      console.error("[sectors] update failed:", detail);
      return { ran: false, reason: "failed", detail };
    })
    .finally(() => {
      globalRef.__sectorJobInFlight = null;
    });

  globalRef.__sectorJobInFlight = job;
  return job;
}
