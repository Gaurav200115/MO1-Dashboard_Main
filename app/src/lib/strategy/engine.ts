import type { ConfirmedLevel } from "@/lib/eod/confluence";
import { readLatestReport } from "@/lib/eod/report";
import type { EodReport } from "@/lib/eod/types";
import { getFeed } from "@/lib/kite/feed";
import { mongoMessage } from "@/lib/mongo";
import { BarEngine } from "./bars";
import { istClock, istDate, istMinutes, parseIstTime } from "./ist";
import { buildWatchPlan, toTriggerLevel, type SymbolPlan, type WatchPlan } from "./levels";
import { fetchPremiums, fillPrice, quoteKey, resolveAtm, type PremiumQuote } from "./options";
import { evaluate, profitAt, sizeTrade } from "./position";
import { activeStrategies } from "./registry";
import { evaluateSymbol, initialState, type Signal, type SymbolState } from "./signals";
import {
  ensureIndexes,
  insertTrade,
  openTrades,
  syncStrategies,
  tradeId,
  updateTrade,
} from "./store";
import type {
  EngineSnapshot,
  EngineStatus,
  ExitReason,
  StrategyDefinition,
  StrategyTrade,
  SymbolStatus,
} from "./types";

export type { EngineSnapshot, EngineStatus, SymbolStatus } from "./types";

/**
 * The live runtime: overnight levels in, paper trades out.
 *
 * One engine per strategy, all of them sharing the tick feed and one bar
 * builder per (interval, period) they ask for. Everything it produces is paper —
 * this desk has no order placement and never has — so a "fill" here is a live
 * premium read at the moment the rule fired, recorded so the rule can be judged
 * on something better than memory.
 *
 * Two clocks matter and they are not the same one. Entries close at the
 * strategy's cutoff; positions already open keep running to their stop or to the
 * flatten time. Conflating the two would have the cutoff silently close winners.
 */

/** How often open positions are re-priced. One batched quote call per tick. */
const TRACK_MS = 2_000;

export class StrategyEngine {
  private status: EngineStatus = "idle";
  private detail: string | null = null;
  private tradingDate: string | null = null;
  private report: EodReport | null = null;
  private plan: WatchPlan | null = null;

  private readonly states = new Map<string, SymbolState>();
  private readonly plans = new Map<string, SymbolPlan>();
  private readonly open = new Map<string, StrategyTrade>();
  /** Symbols with an entry in flight, so one signal cannot open two positions. */
  private readonly opening = new Set<string>();

  private openedToday = 0;
  private lastSignalAt: number | null = null;
  private readonly errors: string[] = [];

  private unsubscribe: (() => void) | null = null;
  private tracker: NodeJS.Timeout | null = null;
  private starting: Promise<void> | null = null;
  private trackingNow = false;

  private readonly cutoffMin: number;
  private readonly flattenMin: number;

  constructor(
    private readonly strategy: StrategyDefinition,
    private readonly bars: BarEngine
  ) {
    this.cutoffMin = parseIstTime(strategy.params.entryCutoffIst);
    this.flattenMin = parseIstTime(strategy.params.flattenIst);
  }

  snapshot(): EngineSnapshot {
    return {
      strategyId: this.strategy.id,
      strategyName: this.strategy.name,
      version: this.strategy.version,
      status: this.status,
      detail: this.detail,
      tradingDate: this.tradingDate,
      basedOn: this.plan?.basedOn ?? null,
      watching: this.plans.size,
      emaReady: this.bars.readyCount(),
      entriesOpen: this.entriesOpen(),
      entryCutoffIst: this.strategy.params.entryCutoffIst,
      openTrades: this.open.size,
      tradesToday: this.openedToday,
      lastSignalAt: this.lastSignalAt,
      errors: this.errors.slice(-5),
    };
  }

  /** Per-symbol machine state, for the status panel. */
  symbolStatuses(): SymbolStatus[] {
    const out: SymbolStatus[] = [];
    for (const [symbol, plan] of this.plans) {
      const state = this.states.get(symbol);
      const bars = this.bars.get(symbol);
      if (!state) continue;
      out.push({
        symbol,
        name: plan.name,
        phaseA: state.phaseA,
        phaseB: state.phaseB,
        note: state.note,
        ltp: state.lastLtp,
        ema: bars?.emaValue ?? null,
        emaReady: Boolean(bars?.seeded && bars.emaValue != null),
        majorResistance: plan.majorResistance?.pivotValue ?? null,
        majorSupport: plan.majorSupport?.pivotValue ?? null,
      });
    }
    return out;
  }

  /** Idempotent, and safe to call from a request handler as well as from boot. */
  async start(): Promise<EngineSnapshot> {
    if (this.status === "running") return this.snapshot();
    if (this.starting) {
      await this.starting;
      return this.snapshot();
    }
    this.starting = this.boot().finally(() => {
      this.starting = null;
    });
    await this.starting;
    return this.snapshot();
  }

  private async boot(): Promise<void> {
    this.status = "starting";
    this.detail = null;
    // Notes describe the boot that produced them. Carrying yesterday's warm-up
    // failures into today's status panel would report problems that are no
    // longer true, which is worse than reporting none.
    this.errors.length = 0;

    const today = istDate();
    const report = await readLatestReport();

    if (!report) {
      this.status = "no-levels";
      this.detail = "No EOD report yet — the confluence scan has not run.";
      return;
    }

    /*
     * The levels must come from a session that has finished. Comparing against
     * `basedOn` rather than `computedFor` on purpose: computedFor is the next
     * weekday, which is a caption and is wrong across exchange holidays, while
     * "derived from a session before today" is the condition that actually has
     * to hold.
     */
    if (report.basedOn >= today) {
      this.status = "no-levels";
      this.detail = `Latest report is based on ${report.basedOn}, which is not a completed prior session.`;
      return;
    }
    if (!report.verifiedAt) {
      this.note(
        `levels for ${report.basedOn} are still provisional — Kite had not finalised the daily candle when they were computed`
      );
    }
    if (report.computedFor !== today) {
      this.note(`report was computed for ${report.computedFor}, trading it on ${today}`);
    }

    this.report = report;
    this.tradingDate = today;
    this.plan = buildWatchPlan(report, this.strategy.params);

    this.plans.clear();
    this.states.clear();
    for (const plan of this.plan.plans) {
      this.plans.set(plan.symbol, plan);
      this.states.set(plan.symbol, initialState(plan));
      this.bars.track(plan.symbol);
    }

    if (this.plans.size === 0) {
      this.status = "no-levels";
      this.detail = `No stock in ${report.basedOn} has a level clearing the skew thresholds (${this.strategy.params.resistanceSkew}x / ${this.strategy.params.supportSkew}x).`;
      return;
    }

    try {
      await ensureIndexes();
      await syncStrategies([this.strategy]);
    } catch (err) {
      this.note(`strategy sync failed: ${mongoMessage(err)}`);
    }

    await this.resume();

    this.bars.start();
    if (!this.unsubscribe) {
      this.unsubscribe = getFeed().subscribe((event) => {
        if (event.type !== "quotes") return;
        for (const quote of event.quotes) this.onTick(quote.symbol, quote.ltp);
      });
    }
    if (!this.tracker) {
      this.tracker = setInterval(() => void this.track(), TRACK_MS);
      this.tracker.unref();
    }

    this.status = "running";
    this.detail = `Watching ${this.plans.size} stocks from ${report.basedOn}.`;

    // Warming runs behind the engine rather than in front of it. Signals are
    // gated on a symbol's EMA being ready, so a stock that is still warming is
    // simply not tradeable yet — which is far better than the whole strategy
    // sitting out the open waiting on a hundred sequential history calls.
    void this.warm();
  }

  private async warm(): Promise<void> {
    for (const symbol of this.plans.keys()) {
      try {
        const bars = await this.bars.seed(symbol);
        if (bars.seedError) this.note(`${symbol}: ${bars.seedError}`);
      } catch (err) {
        this.note(`${symbol}: seed failed — ${message(err)}`);
      }
    }
  }

  /** Re-adopts positions left open by a previous process. */
  private async resume(): Promise<void> {
    try {
      const existing = await openTrades([this.strategy.id]);
      for (const trade of existing) {
        if (trade.tradingDate !== this.tradingDate) {
          // A position from an earlier day can never be managed correctly now —
          // its contract has moved on and its stop is meaningless — so it is
          // closed at its last mark rather than left open forever.
          await this.settleStale(trade);
          continue;
        }
        this.open.set(trade._id, trade);
        this.openedToday += 1;
        const state = this.states.get(trade.symbol);
        if (state) {
          state.tradesToday += 1;
          if (trade.setup === "A") state.phaseA = "spent";
          if (trade.setup === "B") state.phaseB = "spent";
        }
      }
      if (existing.length > 0) this.note(`resumed ${this.open.size} open trades`);
    } catch (err) {
      this.note(`resume failed: ${mongoMessage(err)}`);
    }
  }

  private async settleStale(trade: StrategyTrade): Promise<void> {
    const price = trade.mtm?.price ?? trade.buy.price;
    const at = trade.mtm?.at ?? trade.buy.at;
    await updateTrade(trade, {
      sell: { price, at, reason: "eod-flatten" },
      profit: (price - trade.buy.price) * trade.qty,
      status: "closed",
      closedAt: new Date(),
    });
    this.note(`closed stale ${trade.symbol} trade from ${trade.tradingDate}`);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.tracker) clearInterval(this.tracker);
    this.tracker = null;
    this.status = "stopped";
    this.detail = "Stopped by request.";
  }

  private entriesOpen(now = Date.now()): boolean {
    const minute = istMinutes(now);
    return (
      this.status === "running" &&
      this.tradingDate === istDate(now) &&
      minute <= this.cutoffMin &&
      this.openedToday < this.strategy.params.maxTradesPerDay &&
      this.open.size < this.strategy.params.maxOpenTrades
    );
  }

  private onTick(symbol: string, ltp: number): void {
    const plan = this.plans.get(symbol);
    const state = this.states.get(symbol);
    if (!plan || !state) return;

    const bars = this.bars.get(symbol);
    const ready = Boolean(bars?.seeded) && bars?.emaValue != null;
    const lastBar = bars?.closed.at(-1) ?? null;

    const signal = evaluateSymbol({
      plan,
      state,
      params: this.strategy.params,
      ltp,
      ema: ready ? (bars?.emaValue ?? null) : null,
      lastBarClose: lastBar?.c ?? null,
      at: Date.now(),
      entriesOpen: this.entriesOpen(),
    });

    if (signal) void this.enter(signal, plan);
  }

  /**
   * Opens a paper position on a signal.
   *
   * The two guards at the top close a real race: resolving a contract and
   * pricing it are both awaits, and the tick stream keeps arriving throughout.
   * Without them a stock ticking twice inside one quote round-trip would open
   * the position twice.
   */
  private async enter(signal: Signal, plan: SymbolPlan): Promise<void> {
    const symbol = signal.symbol;
    if (this.opening.has(symbol)) return;
    if (!this.entriesOpen()) return;
    this.opening.add(symbol);

    try {
      const expiry = this.report?.stocks.find((s) => s.symbol === symbol)?.expiry;
      const instrument = await resolveAtm(symbol, signal.spot, "CE", expiry);

      const key = quoteKey(instrument);
      const quotes = await fetchPremiums([key]);
      const quote = quotes.get(key);
      if (!quote) {
        this.note(`${symbol}: no premium quote for ${instrument.tradingsymbol}, entry skipped`);
        return;
      }

      const entry = fillPrice(quote, "buy");
      if (!Number.isFinite(entry) || entry <= 0) {
        this.note(`${symbol}: premium came back as ${entry}, entry skipped`);
        return;
      }

      // Re-checked after the awaits — the cutoff or a cap may have been reached
      // while the quote was in flight.
      if (!this.entriesOpen()) return;

      const sizing = sizeTrade(entry, instrument.lotSize, this.strategy.risk);
      const state = this.states.get(symbol);
      const setup = this.strategy.setups.find((s) => s.id === signal.setup);
      const at = Date.now();

      const trade: StrategyTrade = {
        _id: tradeId(
          {
            tradingDate: this.tradingDate ?? istDate(at),
            strategyId: this.strategy.id,
            symbol,
            setup: signal.setup,
          },
          state?.tradesToday ?? 0
        ),
        strategyId: this.strategy.id,
        strategyVersion: this.strategy.version,
        strategyName: this.strategy.name,
        setup: signal.setup,
        setupLabel: setup?.label ?? signal.setup,
        tradingDate: this.tradingDate ?? istDate(at),
        symbol,
        side: "LONG",
        instrument,
        qty: sizing.qty,
        buy: { price: entry, at },
        sell: null,
        profit: null,
        stop: sizing.stop,
        target: sizing.target,
        step: 1,
        riskPerUnit: sizing.riskPerUnit,
        riskCapped: sizing.riskCapped,
        mtm: { price: quote.last, at, profit: (quote.last - entry) * sizing.qty },
        status: "open",
        ladder: [],
        trigger: {
          setup: signal.setup,
          level: toTriggerLevel(signal.level),
          basis: signal.basis ? toTriggerLevel(signal.basis) : null,
          crossedAt: signal.crossedAt,
          ema: signal.ema,
          spot: signal.spot,
        },
        paper: true,
        openedAt: new Date(at),
        closedAt: null,
      };

      const written = await insertTrade(trade);
      if (!written) {
        this.note(`${symbol}: signal fired but Mongo is not configured — trade not recorded`);
        return;
      }

      this.open.set(trade._id, trade);
      this.openedToday += 1;
      this.lastSignalAt = at;
      if (state) state.tradesToday += 1;

      console.log(
        `[strategy] ${istClock(at)} ${this.strategy.id} ${setup?.label ?? signal.setup}: ` +
          `LONG ${instrument.tradingsymbol} @ ${entry.toFixed(2)} x${sizing.qty} ` +
          `(stop ${sizing.stop.toFixed(2)}, target ${sizing.target.toFixed(2)}) ` +
          `on ${signal.level.kind} ${signal.level.pivot} ${signal.level.pivotValue.toFixed(2)}` +
          `${plan.name ? ` — ${plan.name}` : ""}`
      );
    } catch (err) {
      this.note(`${symbol}: entry failed — ${message(err)}`);
    } finally {
      this.opening.delete(symbol);
    }
  }

  /**
   * Re-prices every open position and applies stops, trails and the flatten.
   *
   * Guarded against re-entry. The interval is 2s but the quote call behind it
   * queues on a 1 req/sec gate, so a slow round-trip lets the next tick start
   * before this one has finished — and two passes holding the same position
   * would each read a stop as breached and exit it twice.
   */
  private async track(): Promise<void> {
    if (this.trackingNow) return;
    if (this.open.size === 0) return;
    this.trackingNow = true;
    try {
      await this.trackOnce();
    } finally {
      this.trackingNow = false;
    }
  }

  private async trackOnce(): Promise<void> {
    const now = Date.now();
    const flatten = istMinutes(now) >= this.flattenMin;

    let quotes: Map<string, PremiumQuote>;
    try {
      quotes = await fetchPremiums([...this.open.values()].map(quoteKeyOf));
    } catch (err) {
      this.note(`tracking quote failed: ${message(err)}`);
      return;
    }

    for (const trade of [...this.open.values()]) {
      const quote = quotes.get(quoteKeyOf(trade));
      if (!quote) continue;

      if (flatten) {
        await this.exit(trade, quote, "eod-flatten");
        continue;
      }

      const verdict = evaluate(trade, quote.last, this.strategy.risk, quote.at);

      if (verdict.action === "exit") {
        await this.exit(trade, quote, verdict.reason);
        continue;
      }

      const patch: Partial<StrategyTrade> = {
        mtm: { price: quote.last, at: quote.at, profit: profitAt(trade, quote.last) },
      };

      if (verdict.action === "trail") {
        trade.stop = verdict.advance.stop;
        trade.target = verdict.advance.target;
        trade.step = verdict.advance.step;
        trade.ladder = [...trade.ladder, ...verdict.advance.steps];
        patch.stop = trade.stop;
        patch.target = trade.target;
        patch.step = trade.step;
        patch.ladder = trade.ladder;

        const last = verdict.advance.steps.at(-1);
        console.log(
          `[strategy] ${istClock(quote.at)} ${trade.symbol} trailed to step ${trade.step} — ` +
            `stop ${trade.stop.toFixed(2)} locks ₹${Math.round(last?.locked ?? 0)}, ` +
            `target ${trade.target.toFixed(2)}`
        );
      }

      trade.mtm = patch.mtm ?? trade.mtm;
      try {
        await updateTrade(trade, patch);
      } catch (err) {
        this.note(`${trade.symbol}: update failed — ${mongoMessage(err)}`);
      }
    }
  }

  private async exit(
    trade: StrategyTrade,
    quote: PremiumQuote,
    reason: ExitReason
  ): Promise<void> {
    const price = fillPrice(quote, "sell");
    const profit = (price - trade.buy.price) * trade.qty;

    trade.sell = { price, at: quote.at, reason };
    trade.profit = profit;
    trade.status = "closed";
    trade.closedAt = new Date();
    this.open.delete(trade._id);

    try {
      await updateTrade(trade, {
        sell: trade.sell,
        profit,
        status: "closed",
        closedAt: trade.closedAt,
        mtm: { price: quote.last, at: quote.at, profit },
      });
    } catch (err) {
      this.note(`${trade.symbol}: exit write failed — ${mongoMessage(err)}`);
    }

    console.log(
      `[strategy] ${istClock(quote.at)} ${trade.symbol} EXIT ${reason} @ ${price.toFixed(2)} ` +
        `(in ${trade.buy.price.toFixed(2)}) → ₹${profit >= 0 ? "+" : ""}${Math.round(profit)}`
    );
  }

  private note(text: string): void {
    this.errors.push(text);
    if (this.errors.length > 50) this.errors.splice(0, this.errors.length - 50);
    console.warn(`[strategy:${this.strategy.id}] ${text}`);
  }
}

function quoteKeyOf(trade: StrategyTrade): string {
  return quoteKey(trade.instrument);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------------------------------------- */

interface Runtime {
  engines: Map<string, StrategyEngine>;
  bars: Map<string, BarEngine>;
}

const globalRef = globalThis as typeof globalThis & { __strategyRuntime?: Runtime };

function runtime(): Runtime {
  globalRef.__strategyRuntime ??= { engines: new Map(), bars: new Map() };
  return globalRef.__strategyRuntime;
}

/**
 * Bar builders are shared across strategies asking for the same interval and
 * period. Two rules both wanting a 21 EMA on 5-minute bars are asking for the
 * same series, and building it twice would double the warm-up's history calls
 * against a 3 req/sec limit for no gain at all.
 */
function barsFor(strategy: StrategyDefinition): BarEngine {
  const key = `${strategy.params.emaIntervalMinutes}:${strategy.params.emaPeriod}`;
  const { bars } = runtime();
  let engine = bars.get(key);
  if (!engine) {
    engine = new BarEngine(strategy.params.emaIntervalMinutes, strategy.params.emaPeriod);
    bars.set(key, engine);
  }
  return engine;
}

export function engineFor(strategyId: string): StrategyEngine | null {
  return runtime().engines.get(strategyId) ?? null;
}

export function engines(): StrategyEngine[] {
  return [...runtime().engines.values()];
}

/** Starts every active strategy. Idempotent — safe on boot and on a manual call. */
export async function startStrategies(): Promise<EngineSnapshot[]> {
  const { engines: registry } = runtime();
  const snapshots: EngineSnapshot[] = [];

  for (const strategy of activeStrategies()) {
    let engine = registry.get(strategy.id);
    if (!engine) {
      engine = new StrategyEngine(strategy, barsFor(strategy));
      registry.set(strategy.id, engine);
    }
    snapshots.push(await engine.start());
  }

  return snapshots;
}

export function stopStrategies(): void {
  for (const engine of runtime().engines.values()) engine.stop();
  for (const bars of runtime().bars.values()) bars.stop();
}
