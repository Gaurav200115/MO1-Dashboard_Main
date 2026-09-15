import { readFile } from "node:fs/promises";
import path from "node:path";
import { KiteConnect } from "kiteconnect";
import { requireConfig } from "@/lib/kite/config";
import { historyGate } from "@/lib/kite/gate";
import { dailyCandles, istDateString } from "@/lib/kite/history";
import { readSession } from "@/lib/kite/session";
import type { DeskIndex } from "@/lib/types";
import {
  BAND_MAX_PCT,
  BAND_MIN_PCT,
  confirmLevels,
  PRECIOUS_PCT,
} from "./confluence";
import { loadOptionUniverse, STRIKE_WINDOW, type OptionContract } from "./chain";
import { OI_RATIO, oiLevels, type StrikeOi } from "./oi";
import { fibPivots, pivotLevels } from "./pivots";
import { nextSessionDate, writeReport } from "./report";
import { storeReport } from "./store";
import type { EodReport, SpecialStock } from "./types";

/**
 * Rebuilds reports for sessions that have already passed.
 *
 * The nightly scan reads open interest from `/quote`, which is a live snapshot
 * and therefore gone the moment the session is over. For a past day the only
 * source is the historical candle endpoint with the OI flag, one call per option
 * contract — so this is a fundamentally more expensive path than the scan and is
 * deliberately separate from it.
 *
 * The saving grace is that one call returns the whole date range, so back-filling
 * three consecutive sessions costs the same as one. Strikes are unioned across
 * the requested sessions for that reason: each day's at-the-money band sits in a
 * slightly different place, and fetching the union once beats fetching each day.
 */

export interface BackfillPlan {
  sessions: string[];
  stocks: number;
  contracts: number;
  estimatedMinutes: number;
}

export interface BackfillProgress {
  running: boolean;
  phase: "idle" | "planning" | "fetching-oi" | "building" | "done" | "failed";
  sessions: string[];
  done: number;
  total: number;
  startedAt: number | null;
  finishedAt: number | null;
  results: { session: string; stocks: number; levels: number; stored: number }[];
  error: string | null;
}

const globalRef = globalThis as typeof globalThis & {
  __eodBackfill?: BackfillProgress;
  __eodBackfillRun?: Promise<void> | null;
};

globalRef.__eodBackfill ??= {
  running: false,
  phase: "idle",
  sessions: [],
  done: 0,
  total: 0,
  startedAt: null,
  finishedAt: null,
  results: [],
  error: null,
};

export function backfillProgress(): BackfillProgress {
  return globalRef.__eodBackfill!;
}

async function loadIndex(): Promise<DeskIndex> {
  const file = path.join(process.cwd(), "public", "data", "index.json");
  return JSON.parse(await readFile(file, "utf8")) as DeskIndex;
}

/** Ladder position nearest `reference`, then `window` strikes either side. */
function bandAround(ladder: number[], reference: number, window: number): number[] {
  if (ladder.length === 0) return [];
  let atm = 0;
  for (let i = 1; i < ladder.length; i++) {
    if (Math.abs(ladder[i] - reference) < Math.abs(ladder[atm] - reference)) atm = i;
  }
  return ladder.slice(Math.max(0, atm - window), atm + window + 1);
}

interface StockPlan {
  symbol: string;
  name: string;
  sector: string;
  expiry: string;
  /** Session date -> that day's settled OHLC. */
  bySession: Map<string, { high: number; low: number; close: number }>;
  /** Session date -> the strikes in that day's band. */
  bandBySession: Map<string, number[]>;
  atmBySession: Map<string, number>;
  /** Contracts to fetch, unioned across sessions. */
  contracts: { strike: number; type: "CE" | "PE"; token: number }[];
}

/**
 * Works out what has to be fetched without fetching any of it, so the size of
 * the job is known before it starts.
 */
async function plan(sessions: string[]): Promise<{ plans: StockPlan[]; skipped: string[] }> {
  const session = await readSession();
  if (!session) throw new Error("Sign in to Kite first");

  const index = await loadIndex();
  const universe = await loadOptionUniverse(session.accessToken);

  const plans: StockPlan[] = [];
  const skipped: string[] = [];

  for (const company of index.companies) {
    const contracts = universe.get(company.symbol);
    if (!contracts || contracts.length === 0) continue;

    // The series that was current for these sessions — strictly after the last
    // of them, matching what the nightly scan would have chosen at the time.
    const expiry = nearestExpiryAfter(contracts, sessions[sessions.length - 1]);
    if (!expiry) {
      skipped.push(company.symbol);
      continue;
    }

    let candles;
    try {
      candles = await dailyCandles(company.symbol, { background: true });
    } catch {
      skipped.push(company.symbol);
      continue;
    }

    const bySession = new Map<string, { high: number; low: number; close: number }>();
    for (const candle of candles) {
      const date = istDateString(candle.t);
      if (sessions.includes(date)) {
        bySession.set(date, { high: candle.h, low: candle.l, close: candle.c });
      }
    }
    if (bySession.size === 0) {
      skipped.push(company.symbol);
      continue;
    }

    const sides = new Map<number, { CE?: OptionContract; PE?: OptionContract }>();
    for (const contract of contracts) {
      if (contract.expiry !== expiry) continue;
      const entry = sides.get(contract.strike) ?? {};
      entry[contract.type] = contract;
      sides.set(contract.strike, entry);
    }
    // Both sides or nothing — a missing put is unknown OI, not zero.
    const ladder = [...sides.entries()]
      .filter(([, entry]) => entry.CE && entry.PE)
      .map(([strike]) => strike)
      .sort((a, b) => a - b);
    if (ladder.length === 0) {
      skipped.push(company.symbol);
      continue;
    }

    const bandBySession = new Map<string, number[]>();
    const atmBySession = new Map<string, number>();
    const needed = new Set<number>();
    for (const [date, ohlc] of bySession) {
      const band = bandAround(ladder, ohlc.close, STRIKE_WINDOW);
      bandBySession.set(date, band);
      atmBySession.set(date, band.reduce((best, s) =>
        Math.abs(s - ohlc.close) < Math.abs(best - ohlc.close) ? s : best, band[0]));
      for (const strike of band) needed.add(strike);
    }

    const list: StockPlan["contracts"] = [];
    for (const strike of needed) {
      const entry = sides.get(strike);
      if (!entry?.CE || !entry.PE) continue;
      list.push({ strike, type: "CE", token: entry.CE.token });
      list.push({ strike, type: "PE", token: entry.PE.token });
    }

    plans.push({
      symbol: company.symbol,
      name: company.name,
      sector: company.sector,
      expiry,
      bySession,
      bandBySession,
      atmBySession,
      contracts: list,
    });
  }

  return { plans, skipped };
}

function nearestExpiryAfter(contracts: OptionContract[], session: string): string | null {
  let nearest: string | null = null;
  for (const contract of contracts) {
    if (contract.expiry <= session) continue;
    if (!nearest || contract.expiry < nearest) nearest = contract.expiry;
  }
  return nearest;
}

export async function planBackfill(sessions: string[]): Promise<BackfillPlan> {
  const { plans } = await plan(sessions);
  const contracts = plans.reduce((n, p) => n + p.contracts.length, 0);
  return {
    sessions,
    stocks: plans.length,
    contracts,
    // One historical call per contract, spaced by the 3 req/sec gate.
    estimatedMinutes: Math.round((contracts * 0.35) / 60),
  };
}

export function runBackfill(sessions: string[]): BackfillProgress {
  const state = backfillProgress();
  if (state.running) return state;

  Object.assign(state, {
    running: true,
    phase: "planning",
    sessions,
    done: 0,
    total: 0,
    startedAt: Date.now(),
    finishedAt: null,
    results: [],
    error: null,
  } satisfies Partial<BackfillProgress>);

  globalRef.__eodBackfillRun = execute(sessions, state)
    .catch((err: unknown) => {
      state.phase = "failed";
      state.error = err instanceof Error ? err.message : String(err);
      console.error("[backfill] failed:", state.error);
    })
    .finally(() => {
      state.running = false;
      state.finishedAt = Date.now();
      globalRef.__eodBackfillRun = null;
    });

  return state;
}

async function execute(sessions: string[], state: BackfillProgress): Promise<void> {
  const session = await readSession();
  if (!session) throw new Error("Sign in to Kite first");

  const { plans } = await plan(sessions);
  const { apiKey } = requireConfig();
  const kc = new KiteConnect({ api_key: apiKey });
  kc.setAccessToken(session.accessToken);

  state.total = plans.reduce((n, p) => n + p.contracts.length, 0);
  state.phase = "fetching-oi";
  console.log(
    `[backfill] ${sessions.join(", ")}: ${plans.length} stocks, ${state.total} contracts`
  );

  // One call per contract covers every requested session at once.
  const from = `${sessions[0]} 09:00:00`;
  const to = `${sessions[sessions.length - 1]} 16:00:00`;

  /** symbol -> session -> strike -> {call,put} */
  const oi = new Map<string, Map<string, Map<number, { call?: number; put?: number }>>>();

  for (const stock of plans) {
    const bySession = new Map<string, Map<number, { call?: number; put?: number }>>();
    oi.set(stock.symbol, bySession);

    for (const contract of stock.contracts) {
      try {
        const rows = await historyGate.run(
          () => kc.getHistoricalData(contract.token, "day", from, to, false, true),
          { background: true }
        );
        for (const row of rows) {
          const date = istDateString(new Date(row.date).getTime());
          if (!sessions.includes(date)) continue;
          const strikes = bySession.get(date) ?? new Map();
          const entry = strikes.get(contract.strike) ?? {};
          const value = typeof row.oi === "number" ? row.oi : 0;
          if (contract.type === "CE") entry.call = value;
          else entry.put = value;
          strikes.set(contract.strike, entry);
          bySession.set(date, strikes);
        }
      } catch {
        // A contract that will not return is simply absent; the strike is then
        // one-sided and gets dropped rather than counted as zero OI.
      }
      state.done += 1;
    }
  }

  state.phase = "building";

  for (const date of sessions) {
    const stocks: SpecialStock[] = [];

    for (const stock of plans) {
      const ohlc = stock.bySession.get(date);
      const band = stock.bandBySession.get(date);
      if (!ohlc || !band) continue;

      const pivots = fibPivots(ohlc.high, ohlc.low, ohlc.close);
      if (!pivots) continue;

      const strikes = oi.get(stock.symbol)?.get(date);
      const chain: StrikeOi[] = [];
      for (const strike of band) {
        const entry = strikes?.get(strike);
        if (entry?.call == null || entry.put == null) continue;
        chain.push({ strike, callOi: entry.call, putOi: entry.put });
      }
      if (chain.length === 0) continue;

      const levels = confirmLevels(
        pivotLevels(pivots, ohlc.close),
        oiLevels(chain),
        ohlc.close
      );
      levels.sort((a, b) => a.reachPct - b.reachPct);

      stocks.push({
        symbol: stock.symbol,
        name: stock.name,
        sector: stock.sector,
        session: { date, ...ohlc },
        pivots,
        expiry: stock.expiry,
        atmStrike: stock.atmBySession.get(date) ?? band[0],
        levels,
        chain,
      });
    }

    stocks.sort((a, b) => nearestReach(a) - nearestReach(b));

    const report: EodReport = {
      basedOn: date,
      computedFor: nextSessionDate(date),
      generatedAt: Date.now(),
      // Backfilled from finalised candles, so there is nothing for the
      // verification pass to correct.
      verifiedAt: Date.now(),
      revised: 0,
      params: {
        oiRatio: OI_RATIO,
        bandMinPct: BAND_MIN_PCT,
        bandMaxPct: BAND_MAX_PCT,
        preciousPct: PRECIOUS_PCT,
        strikeWindow: STRIKE_WINDOW,
      },
      stats: {
        withOptions: plans.length,
        scanned: stocks.length,
        qualified: stocks.filter((s) => s.levels.length > 0).length,
        oiLevelsFound: 0,
        failed: [],
        durationMs: Date.now() - (state.startedAt ?? Date.now()),
      },
      stocks,
    };

    await writeReport(report, { latest: false });

    let stored = 0;
    try {
      stored = (await storeReport(report)).stored;
    } catch (err) {
      console.warn("[backfill] archive failed for", date, err instanceof Error ? err.message.split("\n")[0] : err);
    }

    state.results.push({
      session: date,
      stocks: report.stats.qualified,
      levels: stocks.reduce((n, s) => n + s.levels.length, 0),
      stored,
    });
    console.log(
      `[backfill] ${date}: ${report.stats.qualified} stocks, ` +
        `${stocks.reduce((n, s) => n + s.levels.length, 0)} levels, ${stored} archived`
    );
  }

  state.phase = "done";
}

function nearestReach(stock: SpecialStock): number {
  if (stock.levels.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(...stock.levels.map((level) => level.reachPct));
}
