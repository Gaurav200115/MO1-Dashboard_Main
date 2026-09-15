import { readFile } from "node:fs/promises";
import path from "node:path";
import { dailyCandles, istDateString } from "@/lib/kite/history";
import { readSession } from "@/lib/kite/session";
import type { DeskIndex } from "@/lib/types";
import {
  fetchOpenInterest,
  loadOptionUniverse,
  planChain,
  STRIKE_WINDOW,
  toStrikeOi,
  type ChainPlan,
} from "./chain";
import { BAND_MAX_PCT, BAND_MIN_PCT, confirmLevels, PRECIOUS_PCT } from "./confluence";
import { OI_RATIO, oiLevels } from "./oi";
import { fibPivots, pivotLevels } from "./pivots";
import {
  lastSettledCandle,
  nextSessionDate,
  readReport,
  writeReport,
  type EodReport,
  type SpecialStock,
} from "./report";
import { storeReport } from "./store";
import { verifyReport } from "./verify";

export interface ScanOutcome {
  ran: boolean;
  reason:
    | "completed"
    | "verified"
    | "already-done"
    | "no-session"
    | "no-settled-session"
    | "in-flight"
    | "failed";
  detail?: string;
  report?: EodReport;
}

async function loadIndex(): Promise<DeskIndex> {
  const file = path.join(process.cwd(), "public", "data", "index.json");
  return JSON.parse(await readFile(file, "utf8")) as DeskIndex;
}

/**
 * The scan is anchored on the largest company by market cap rather than a
 * hardcoded symbol: it is the least likely name in the universe to be halted or
 * illiquid on any given day, and it establishes which session we are computing
 * from before spending 184 requests finding out.
 */
function anchorSymbol(index: DeskIndex): string | null {
  let best: { symbol: string; mcap: number } | null = null;
  for (const company of index.companies) {
    if (company.mcap == null) continue;
    if (!best || company.mcap > best.mcap) best = { symbol: company.symbol, mcap: company.mcap };
  }
  return best?.symbol ?? index.companies[0]?.symbol ?? null;
}

/**
 * One evening's work: read the settled session, derive Fibonacci pivots, read
 * where option writers are positioned, and keep only the levels both agree on.
 *
 * Idempotent on the *session* rather than the wall clock. Restarting the server
 * three times after the close does the work once; starting it the next morning
 * correctly finds the previous evening's report already present. That is what
 * lets this stand in for a scheduler without one.
 */
async function scan(force: boolean): Promise<ScanOutcome> {
  const startedAt = Date.now();

  const session = await readSession();
  if (!session) {
    return { ran: false, reason: "no-session", detail: "Sign in to Kite first" };
  }

  const index = await loadIndex();
  const anchor = anchorSymbol(index);
  if (!anchor) return { ran: false, reason: "failed", detail: "Desk index is empty" };

  const anchorCandles = await dailyCandles(anchor, { background: true });
  const anchorSettled = lastSettledCandle(anchorCandles);
  if (!anchorSettled) {
    return { ran: false, reason: "no-settled-session", detail: "No completed session yet" };
  }

  const basedOn = istDateString(anchorSettled.t);
  const existing = force ? null : await readReport(basedOn);
  if (existing) {
    /*
     * The evening's figures are provisional — Kite finalises the daily candle
     * overnight. Once the session day has passed the candle is authoritative, so
     * the first run after midnight re-reads it and corrects the pivots against
     * the archived option chain. This is what makes the levels the desk shows
     * during a session the ones computed from the *official* previous close.
     */
    if (!existing.verifiedAt && istDateString(Date.now()) > basedOn) {
      console.log(`[eod] verifying ${basedOn} against finalised candles`);
      const verified = await verifyReport(existing);
      await writeReport(verified);
      await archive(verified);
      console.log(
        `[eod] ${basedOn} verified — ${verified.revised} of ${verified.stocks.length} stocks revised`
      );
      return { ran: true, reason: "verified", detail: `${verified.revised} revised`, report: verified };
    }

    return {
      ran: false,
      reason: "already-done",
      detail: `Report for ${basedOn} already exists`,
      report: existing,
    };
  }

  console.log(`[eod] scanning for session ${basedOn} (anchor ${anchor})`);

  const universe = await loadOptionUniverse(session.accessToken);

  type Pending = {
    company: DeskIndex["companies"][number];
    settled: { date: string; high: number; low: number; close: number };
    plan: ChainPlan;
  };

  const pending: Pending[] = [];
  const failed: string[] = [];
  let withOptions = 0;

  for (const company of index.companies) {
    const contracts = universe.get(company.symbol);
    if (!contracts || contracts.length === 0) continue;
    withOptions += 1;

    try {
      const candles = await dailyCandles(company.symbol, { background: true });
      const candle = lastSettledCandle(candles);
      if (!candle) {
        failed.push(company.symbol);
        continue;
      }

      // Its own last settled session, not the anchor's — a stock that did not
      // trade that day gets pivots from the session it actually had.
      const settled = {
        date: istDateString(candle.t),
        high: candle.h,
        low: candle.l,
        close: candle.c,
      };

      const plan = planChain(contracts, settled.close, basedOn);
      if (!plan) {
        failed.push(company.symbol);
        continue;
      }

      pending.push({ company, settled, plan });
    } catch (err) {
      failed.push(company.symbol);
      console.warn(`[eod] ${company.symbol} skipped:`, message(err));
    }
  }

  const keys: string[] = [];
  for (const item of pending) {
    for (const pair of item.plan.pairs) keys.push(pair.callKey, pair.putKey);
  }
  console.log(`[eod] ${pending.length} stocks planned, reading OI for ${keys.length} contracts`);

  const { oiByKey, failedBatches } = await fetchOpenInterest(keys, session.accessToken);

  const stocks: SpecialStock[] = [];
  let oiLevelsFound = 0;

  for (const { company, settled, plan } of pending) {
    const pivots = fibPivots(settled.high, settled.low, settled.close);
    if (!pivots) {
      failed.push(company.symbol);
      continue;
    }

    const chain = toStrikeOi(plan, oiByKey);
    const levels = oiLevels(chain);
    oiLevelsFound += levels.length;

    const confirmed = confirmLevels(pivotLevels(pivots, settled.close), levels, settled.close);

    // Nearest to the last close first — the order in which they can be tested.
    confirmed.sort((a, b) => a.reachPct - b.reachPct);

    // Kept even with no confirmed level, so the verification pass can revisit it
    // against the finalised close. See SpecialStock.
    stocks.push({
      symbol: company.symbol,
      name: company.name,
      sector: company.sector,
      session: settled,
      pivots,
      expiry: plan.expiry,
      atmStrike: plan.atmStrike,
      levels: confirmed,
      chain,
    });
  }

  /*
   * Ranked by reach, not by how tightly the pivot and strike agree.
   *
   * Measured on the 2026-09-10 session: 163 of 184 stocks produce at least one
   * confirmed level, because the 0.3-0.8% band is 0.5pp wide against a median
   * strike spacing of 1.28pp — so nearly every pivot finds a strike in band by
   * geometry alone, and the 1.8x test clears ~76% of strikes since OTM puts
   * always outweigh calls below spot and vice versa. Neither rule is selective
   * on its own, so the list is ordered by the thing that decides whether a level
   * matters tomorrow: how far price has to travel to reach it.
   */
  stocks.sort((a, b) => nearestReach(a) - nearestReach(b));

  const report: EodReport = {
    basedOn,
    computedFor: nextSessionDate(basedOn),
    generatedAt: Date.now(),
    // A scan running after the session day has passed already read finalised
    // candles, so it needs no verification pass.
    verifiedAt: istDateString(Date.now()) > basedOn ? Date.now() : null,
    revised: 0,
    params: {
      oiRatio: OI_RATIO,
      bandMinPct: BAND_MIN_PCT,
      bandMaxPct: BAND_MAX_PCT,
      preciousPct: PRECIOUS_PCT,
      strikeWindow: STRIKE_WINDOW,
    },
    stats: {
      withOptions,
      scanned: pending.length,
      qualified: stocks.filter((s) => s.levels.length > 0).length,
      oiLevelsFound,
      failed,
      durationMs: Date.now() - startedAt,
    },
    stocks,
  };

  await writeReport(report);
  await archive(report);
  console.log(
    `[eod] ${basedOn}: ${report.stats.qualified} qualified of ${pending.length} scanned in ${
      Math.round(report.stats.durationMs / 1000)
    }s${failedBatches > 0 ? ` (${failedBatches} OI batches failed)` : ""}`
  );

  return { ran: true, reason: "completed", report };
}

/**
 * The archive is analysis, not the desk's source of truth — a Mongo that is down
 * or unconfigured must never cost us the scan we just spent 90 seconds on.
 */
async function archive(report: EodReport): Promise<void> {
  try {
    const outcome = await storeReport(report);
    if (outcome.skipped === "not-configured") {
      console.log("[eod] archive skipped — MONGO_CONNECTION_STRING not set");
    } else {
      console.log(`[eod] archived ${outcome.stored} stocks for ${report.basedOn}`);
    }
  } catch (err) {
    console.warn("[eod] archive failed:", message(err));
  }
}

function nearestReach(stock: SpecialStock): number {
  if (stock.levels.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(...stock.levels.map((level) => level.reachPct));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const globalRef = globalThis as typeof globalThis & {
  __eodInFlight?: Promise<ScanOutcome> | null;
};

/**
 * Single-flight. Server boot and a manual trigger arriving together must not
 * both spend 6,000 quote requests on the same session.
 */
export function runEodScan(opts?: { force?: boolean }): Promise<ScanOutcome> {
  if (globalRef.__eodInFlight) {
    return globalRef.__eodInFlight.then((outcome) =>
      outcome.reason === "completed" ? outcome : { ...outcome, reason: "in-flight" as const }
    );
  }

  const run = scan(opts?.force ?? false)
    .catch((err): ScanOutcome => {
      console.error("[eod] scan failed:", message(err));
      return { ran: false, reason: "failed", detail: message(err) };
    })
    .finally(() => {
      globalRef.__eodInFlight = null;
    });

  globalRef.__eodInFlight = run;
  return run;
}
