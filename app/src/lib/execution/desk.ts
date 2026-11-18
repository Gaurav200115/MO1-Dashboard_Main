import { sendTelegram } from "@/lib/notify/telegram";
import { istClock, istDate } from "@/lib/strategy/ist";
import { fetchPremiums, quoteKey, type PremiumQuote } from "@/lib/strategy/options";
import type { ExitReason, StrategyTrade } from "@/lib/strategy/types";
import { kiteBroker } from "./broker";
import { readDay, saveDay } from "./journal";
import { liveAllowed, liveEntriesOn, liveMaxOpen, readMode, writeMode, type ExecutionMode } from "./mode";
import { entryLimit, exitPrice, limitUnder, orderTag, stopPrices, tickDown } from "./orderMath";
import {
  BrokerError,
  type AlertLevel,
  type Broker,
  type BrokerOrder,
  type LivePosition,
} from "./types";

/**
 * The live desk: real orders at Zerodha, following the paper engine.
 *
 * The engine decides; this executes. It is told three things - a paper entry
 * opened, a paper stop trailed, a paper trade closed - and turns each into the
 * matching real order. It never decides to trade on its own, so a fault here
 * can cost a live trade but cannot invent one.
 *
 * The rules it keeps, all from the design doc:
 *
 *   - Entry: a LIMIT at the ask the paper entry was priced at, IOC - it fills
 *     now or is cancelled, and never rests. Sent once and never retried: a
 *     missed entry is a missed trade, and paper keeps the record of it.
 *   - No reply is not a refusal. An order that got no answer is looked up by its
 *     tag before anything else happens, because sending it again could buy twice.
 *   - On a fill, a stop-limit SELL is rested at the exchange at once - fill less
 *     R, limit half an R under that - so the position is protected even if this
 *     server dies. If it cannot be placed, the position is exited instead.
 *   - One sell order per position, ever. The trail modifies the stop; the exit
 *     modifies it again into a sell at the bid. A second sell beside a resting
 *     stop would, if both filled, leave the account short an option.
 *   - Zerodha's positions are the truth. Every minute they are compared with
 *     this record; a mismatch halts live entries and pages the phone.
 */

const TERMINAL = new Set(["COMPLETE", "REJECTED", "CANCELLED"]);
/** Statuses an exchange order settles into once Kite has finished validating it. */
const SETTLED = new Set(["COMPLETE", "REJECTED", "CANCELLED", "OPEN", "TRIGGER PENDING"]);

const ENTRY_WAIT_MS = 10_000;
const STOP_WAIT_MS = 3_000;
const EXIT_WAIT_MS = 3_000;
const POLL_MS = 500;
const LOOKUP_TRIES = 3;
const LOOKUP_GAP_MS = 2_000;
const LOOP_MS = 5_000;
const STOP_REFRESH_MS = 10_000;
const RECONCILE_MS = 60_000;
/** A position this fresh is skipped by reconciliation - Kite's positions lag a fill by a moment. */
const RECONCILE_SETTLE_MS = 30_000;
const QUOTE_FRESH_MS = 10_000;
const MAX_EXIT_ATTEMPTS = 5;

const ACTIVE: ReadonlySet<LivePosition["state"]> = new Set(["entering", "open", "closing"]);

export interface DeskDeps {
  broker: Broker;
  alert: (level: AlertLevel, text: string) => void;
  now: () => number;
  today: () => string;
  quotes: (keys: string[]) => Promise<Map<string, PremiumQuote>>;
  sleep: (ms: number) => Promise<void>;
  load: (tradingDate: string) => Promise<LivePosition[]>;
  persist: (tradingDate: string, positions: LivePosition[], changed?: LivePosition) => Promise<void>;
  entriesOn: () => Promise<boolean>;
  maxOpen: () => number;
  /** Starts the background loop. Tests pass a no-op and call `tick()` themselves. */
  schedule: (fn: () => void, ms: number) => (() => void) | null;
}

export interface DeskStatus {
  allowed: boolean;
  mode: ExecutionMode;
  halted: string | null;
  maxOpen: number;
  tradingDate: string;
  positions: LivePosition[];
}

export class LiveDesk {
  private positions: LivePosition[] = [];
  private loadedFor: string | null = null;
  private seq = 0;
  private readonly quotes = new Map<string, PremiumQuote>();
  private readonly stopCheckedAt = new Map<string, number>();
  /** Paper exits that arrived while the live entry was still in flight. */
  private readonly pendingExit = new Map<string, ExitReason>();
  private readonly busy = new Set<string>();
  private lastReconcile = 0;
  private stopLoop: (() => void) | null = null;
  private ticking = false;
  private announcedFor: string | null = null;

  constructor(private readonly deps: DeskDeps) {}

  // ---------------------------------------------------------------- events

  /** A paper entry just opened. Mirrors it with a real IOC buy if live entries are on. */
  async onEntry(trade: StrategyTrade, quote: PremiumQuote): Promise<void> {
    await this.ensureDay();
    this.remember(trade.instrument.tradingsymbol, quote);
    if (!(await this.deps.entriesOn())) return;
    if (this.find(trade._id)) return;
    if (this.activeCount() >= this.deps.maxOpen()) {
      this.log(`${trade.symbol}: live cap of ${this.deps.maxOpen()} reached - paper only`);
      return;
    }
    if (quote.ask == null || !(quote.ask > 0)) return;

    const now = this.deps.now();
    const position: LivePosition = {
      tradeId: trade._id,
      tradingDate: this.loadedFor ?? this.deps.today(),
      strategyId: trade.strategyId,
      setup: trade.setup,
      symbol: trade.symbol,
      tradingsymbol: trade.instrument.tradingsymbol,
      qty: trade.qty,
      riskPerUnit: trade.riskPerUnit,
      state: "entering",
      entry: {
        tag: this.nextTag("E", trade.symbol),
        orderId: null,
        ask: quote.ask,
        price: entryLimit(quote.ask),
        status: "sending",
        reason: null,
        filledQty: 0,
        fillPrice: null,
        quoteAt: quote.at,
        sentAt: now,
        placedAt: null,
        ackAt: null,
        doneAt: null,
      },
      stop: null,
      exit: null,
      profit: null,
      updatedAt: now,
    };
    // On disk before it is sent, so a lost reply can always be looked up by its
    // tag. The disk write is local and quick; the Mongo copy follows on its own
    // and never holds the order back.
    this.positions.push(position);
    await this.save(position);
    this.ensureLoop();

    try {
      position.entry.placedAt = this.deps.now();
      position.entry.orderId = await this.deps.broker.placeOrder({
        tradingsymbol: position.tradingsymbol,
        transactionType: "BUY",
        quantity: position.qty,
        orderType: "LIMIT",
        price: position.entry.price,
        validity: "IOC",
        tag: position.entry.tag,
      });
      position.entry.ackAt = this.deps.now();
      await this.save(position);
    } catch (err) {
      const e = asBrokerError(err);
      if (e.answered) {
        this.endEntry(position, "rejected", `${e.kind}: ${e.message}`);
        await this.save(position);
        this.deps.alert(
          "warning",
          `BUY ${position.tradingsymbol} x${position.qty} @ ${position.entry.price} refused by Zerodha - ${e.message}`
        );
        return;
      }
      position.entry.status = "unknown";
      position.entry.reason = `no reply: ${e.message}`;
      await this.save(position);
      this.deps.alert(
        "warning",
        `BUY ${position.tradingsymbol}: no reply from Kite (${e.message}). Looking it up by tag ${position.entry.tag} before anything else.`
      );
      await this.resolveUnknownEntry(position);
      return;
    }

    const final = await this.waitFor(position.entry.orderId, ENTRY_WAIT_MS, TERMINAL);
    if (!final) {
      position.entry.status = "unknown";
      position.entry.reason = "no final status inside 10s";
      await this.save(position);
      this.deps.alert("warning", `BUY ${position.tradingsymbol}: still not final after 10s - watching it`);
      return;
    }
    await this.applyEntry(position, final);
  }

  /** The paper trade's stop moved up. Moves the exchange stop to match. */
  async onTrail(trade: StrategyTrade): Promise<void> {
    const position = this.find(trade._id);
    if (!position || position.state !== "open" || !position.stop?.orderId) return;
    if (position.stop.status !== "open") return;
    const trigger = tickDown(trade.stop);
    if (trigger <= position.stop.trigger) return;
    const limit = limitUnder(trigger, position.riskPerUnit);

    await this.withLock(position, async () => {
      try {
        await this.deps.broker.modifyOrder(position.stop!.orderId!, { triggerPrice: trigger, price: limit });
        position.stop!.trigger = trigger;
        position.stop!.limit = limit;
        position.stop!.modifications += 1;
        await this.save(position);
        this.deps.alert("info", `${position.tradingsymbol}: stop trailed to ${trigger} (limit ${limit})`);
      } catch (err) {
        // Most often the stop has just fired. Find out rather than guess.
        await this.refreshStop(position, true);
        if (position.state === "open") {
          this.deps.alert(
            "warning",
            `${position.tradingsymbol}: could not trail the stop to ${trigger} - ${asBrokerError(err).message}. The old stop at ${position.stop?.trigger} still stands.`
          );
        }
      }
    });
  }

  /** The paper trade closed. Takes the real position out with it. */
  async onExit(trade: StrategyTrade, quote: PremiumQuote | null, reason: ExitReason): Promise<void> {
    if (quote) this.remember(trade.instrument.tradingsymbol, quote);
    const position = this.find(trade._id);
    if (!position) return;
    if (position.state === "entering") {
      this.pendingExit.set(position.tradeId, reason);
      return;
    }
    if (position.state !== "open") return;
    await this.requestExit(position, reason);
  }

  /** Every price the engine reads for an open trade - cached, and checked against the stop. */
  async onQuote(trade: StrategyTrade, quote: PremiumQuote): Promise<void> {
    this.remember(trade.instrument.tradingsymbol, quote);
    const position = this.find(trade._id);
    if (!position || position.state !== "open" || position.stop?.status !== "open") return;
    if (quote.last >= position.stop.limit) return;
    // Traded below the stop's own limit: the stop may have triggered and not
    // filled. Settle what actually happened, then get out if still in.
    await this.refreshStop(position, true);
    if (position.state === "open") await this.requestExit(position, "gap-past-limit");
  }

  // ------------------------------------------------------------- controls

  async status(): Promise<DeskStatus> {
    await this.ensureDay();
    const state = await readMode();
    return {
      allowed: liveAllowed(),
      mode: state.mode,
      halted: state.halted,
      maxOpen: this.deps.maxOpen(),
      tradingDate: this.loadedFor ?? this.deps.today(),
      positions: [...this.positions],
    };
  }

  /** The desk's switch. Live needs the server's permission and a typed confirmation. */
  async setMode(mode: ExecutionMode, confirm?: string): Promise<{ ok: true } | { ok: false; error: string }> {
    await this.ensureDay();
    if (mode === "live") {
      if (!liveAllowed()) return { ok: false, error: "LIVE_ALLOWED is not set to true on the server." };
      if (confirm !== "LIVE") return { ok: false, error: 'Type LIVE to confirm real orders.' };
    }
    const active = this.positions.filter((p) => ACTIVE.has(p.state));
    if (active.length > 0) {
      return {
        ok: false,
        error: `${active.length} live position(s) still open - let them close, or use the kill switch, before switching.`,
      };
    }
    const before = await readMode();
    await writeMode({ mode, changedAt: this.deps.now(), halted: null });
    this.deps.alert(
      mode === "live" ? "warning" : "info",
      mode === "live"
        ? `Live orders switched ON from the desk (max ${this.deps.maxOpen()} open).`
        : `Live orders switched OFF from the desk${before.halted ? ` (was halted: ${before.halted})` : ""}. Paper continues.`
    );
    if (mode === "live") this.ensureLoop();
    return { ok: true };
  }

  /** Off, and out: no new live entries, and every live position exited. */
  async kill(): Promise<{ exiting: number }> {
    await this.ensureDay();
    const state = await readMode();
    await writeMode({ ...state, mode: "paper", changedAt: this.deps.now(), halted: "kill switch" });
    const active = this.positions.filter((p) => p.state === "open" || p.state === "closing");
    for (const p of this.positions) if (p.state === "entering") this.pendingExit.set(p.tradeId, "manual");
    this.deps.alert(
      "critical",
      `KILL SWITCH: live orders off, exiting ${active.length} live position(s). Paper continues.`
    );
    for (const position of active) {
      if (position.state === "open") await this.requestExit(position, "kill");
    }
    this.ensureLoop();
    return { exiting: active.length };
  }

  /** Once a morning: says out loud whether real orders are on today. */
  async announce(): Promise<void> {
    await this.ensureDay();
    // After a restart, positions still open or being exited need the loop
    // whatever the switch says - the kill switch turns it off mid-exit.
    if (this.positions.some((p) => ACTIVE.has(p.state))) this.ensureLoop();
    if (this.announcedFor === this.loadedFor) return;
    this.announcedFor = this.loadedFor;
    const state = await readMode();
    if (state.mode !== "live") return;
    if (!liveAllowed()) {
      this.deps.alert("warning", "Live orders are switched on at the desk but LIVE_ALLOWED is not set - paper only today.");
      return;
    }
    this.deps.alert(
      state.halted ? "warning" : "info",
      state.halted
        ? `Live orders are HALTED (${state.halted}). Switch them off and on again at the desk to resume.`
        : `Live orders ON today: max ${this.deps.maxOpen()} open, entries LIMIT at the ask (IOC), MIS, exchange stop on every fill.`
    );
    this.ensureLoop();
  }

  // ---------------------------------------------------------------- loop

  /**
   * The background pass: settles entries left unknown, notices a stop that
   * fired at the exchange, retries exits that have not filled, and reconciles.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.ensureDay();
      for (const position of this.positions) {
        try {
          if (position.state === "entering" && position.entry.status === "unknown" && position.entry.orderId) {
            const last = await this.lastOrder(position.entry.orderId);
            if (last && TERMINAL.has(last.status)) await this.applyEntry(position, last);
          } else if (position.state === "open") {
            await this.refreshStop(position, false);
          } else if (position.state === "closing") {
            await this.workExit(position);
          }
        } catch (err) {
          this.log(`${position.tradingsymbol}: loop step failed - ${asBrokerError(err).message}`);
        }
      }
      if (this.deps.now() - this.lastReconcile >= RECONCILE_MS) await this.reconcile();
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Zerodha's net positions against this record, for every contract the desk
   * has touched today. Anything else in the account is the person's own and is
   * left alone. A mismatch halts live entries; open positions keep their stops.
   */
  async reconcile(): Promise<string[]> {
    this.lastReconcile = this.deps.now();
    if (this.positions.length === 0) return [];

    const symbols = new Set(this.positions.map((p) => p.tradingsymbol));
    // A contract with anything in flight - an entry or exit being worked, or a
    // change too recent for Kite's positions to show - waits for the next pass.
    for (const p of this.positions) {
      const inFlight = p.state === "entering" || p.state === "closing";
      const recent = this.deps.now() - p.updatedAt < RECONCILE_SETTLE_MS;
      if (inFlight || recent) symbols.delete(p.tradingsymbol);
    }
    if (symbols.size === 0) return [];

    let net: Map<string, number>;
    try {
      net = new Map();
      for (const row of await this.deps.broker.positions()) {
        if (row.exchange !== "NFO") continue;
        net.set(row.tradingsymbol, (net.get(row.tradingsymbol) ?? 0) + row.quantity);
      }
    } catch (err) {
      this.log(`reconcile: positions call failed - ${asBrokerError(err).message}`);
      return [];
    }

    const problems: string[] = [];
    for (const symbol of symbols) {
      const expected = this.positions
        .filter((p) => p.tradingsymbol === symbol && p.state === "open")
        .reduce((sum, p) => sum + p.entry.filledQty, 0);
      const actual = net.get(symbol) ?? 0;
      if (actual !== expected) problems.push(`${symbol}: Zerodha holds ${actual}, desk expects ${expected}`);
    }

    if (problems.length > 0) {
      const state = await readMode();
      const reason = `position mismatch - ${problems.join("; ")}`;
      if (state.halted !== reason) {
        await writeMode({ ...state, halted: reason });
        this.deps.alert(
          "critical",
          `${reason}. Live entries HALTED; stops already resting stay in place. Check Kite positions, then use the kill switch or square off by hand.`
        );
      }
    }
    return problems;
  }

  // --------------------------------------------------------------- entry

  private async applyEntry(position: LivePosition, order: BrokerOrder): Promise<void> {
    if (position.state !== "entering") return;
    const filled = order.filledQty > 0;
    if (order.status === "COMPLETE" || filled) {
      position.entry.status = "filled";
      position.entry.filledQty = order.filledQty || position.qty;
      position.entry.fillPrice = order.averagePrice || position.entry.price;
      position.entry.doneAt = this.deps.now();
      position.entry.reason = order.status === "COMPLETE" ? null : `partly filled, then ${order.status}`;
      position.state = "open";
      await this.save(position);
      this.deps.alert(
        "info",
        `BUY filled ${position.tradingsymbol} x${position.entry.filledQty} @ ${position.entry.fillPrice} (ask ${position.entry.ask}, limit ${position.entry.price}). Placing the exchange stop.`
      );
      await this.placeStop(position);
      const wanted = this.pendingExit.get(position.tradeId);
      if (wanted && position.state === "open") {
        this.pendingExit.delete(position.tradeId);
        await this.requestExit(position, wanted);
      }
      return;
    }

    if (order.status === "REJECTED") {
      this.endEntry(position, "rejected", order.statusMessage ?? "rejected");
      await this.save(position);
      this.deps.alert(
        "warning",
        `BUY ${position.tradingsymbol} x${position.qty} @ ${position.entry.price} REJECTED - ${order.statusMessage ?? "no reason given"}`
      );
      return;
    }

    if (order.status === "CANCELLED") {
      this.endEntry(position, "cancelled", order.statusMessage ?? "IOC: nothing at our price");
      await this.save(position);
      this.deps.alert(
        "info",
        `BUY ${position.tradingsymbol} not filled: no seller at or under ${position.entry.price} (ask was ${position.entry.ask}). Paper keeps the trade.`
      );
    }
  }

  private endEntry(position: LivePosition, status: "rejected" | "cancelled" | "not-placed", reason: string) {
    position.entry.status = status;
    position.entry.reason = reason;
    position.entry.doneAt = this.deps.now();
    position.state = "not-entered";
    this.pendingExit.delete(position.tradeId);
  }

  private async resolveUnknownEntry(position: LivePosition): Promise<void> {
    for (let i = 0; i < LOOKUP_TRIES; i += 1) {
      await this.deps.sleep(LOOKUP_GAP_MS);
      let found: BrokerOrder | null = null;
      try {
        found = await this.findByTag(position.entry.tag);
      } catch (err) {
        this.log(`${position.tradingsymbol}: lookup by tag failed - ${asBrokerError(err).message}`);
        continue;
      }
      if (!found) continue;
      position.entry.orderId = found.orderId;
      await this.save(position);
      this.deps.alert("info", `BUY ${position.tradingsymbol}: found at Zerodha by its tag (order ${found.orderId}).`);
      const final = TERMINAL.has(found.status) ? found : await this.waitFor(found.orderId, ENTRY_WAIT_MS, TERMINAL);
      if (final) await this.applyEntry(position, final);
      return;
    }
    this.endEntry(position, "not-placed", "no reply, and not in Zerodha's order book by its tag");
    await this.save(position);
    this.deps.alert(
      "warning",
      `BUY ${position.tradingsymbol}: never reached Zerodha (not found by tag). Not retried - paper keeps the trade.`
    );
  }

  // ---------------------------------------------------------------- stop

  private async placeStop(position: LivePosition): Promise<void> {
    const { trigger, limit } = stopPrices(position.entry.fillPrice!, position.riskPerUnit);
    let lastError = "unknown";

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const tag = this.nextTag("S", position.symbol);
      position.stop = {
        tag,
        orderId: null,
        trigger,
        limit,
        status: "placing",
        reason: null,
        placedAt: this.deps.now(),
        modifications: 0,
      };
      await this.save(position);

      let orderId: string | null = null;
      try {
        orderId = await this.deps.broker.placeOrder({
          tradingsymbol: position.tradingsymbol,
          transactionType: "SELL",
          quantity: position.entry.filledQty,
          orderType: "SL",
          price: limit,
          triggerPrice: trigger,
          validity: "DAY",
          tag,
        });
      } catch (err) {
        const e = asBrokerError(err);
        lastError = `${e.kind}: ${e.message}`;
        if (!e.answered) orderId = (await this.findByTag(tag).catch(() => null))?.orderId ?? null;
      }
      if (!orderId) continue;

      position.stop.orderId = orderId;
      const settled = await this.waitFor(orderId, STOP_WAIT_MS, SETTLED);
      if (settled && (settled.status === "REJECTED" || settled.status === "CANCELLED")) {
        lastError = settled.statusMessage ?? settled.status;
        continue;
      }
      if (settled?.status === "COMPLETE") {
        await this.close(position, settled.averagePrice, "stop");
        return;
      }
      position.stop.status = "open";
      await this.save(position);
      this.deps.alert(
        "info",
        `${position.tradingsymbol}: exchange stop resting - trigger ${trigger}, limit ${limit}.`
      );
      return;
    }

    if (position.stop) {
      position.stop.status = "failed";
      position.stop.reason = lastError;
    }
    await this.save(position);
    this.deps.alert(
      "critical",
      `${position.tradingsymbol}: NO STOP at the exchange (${lastError}). Exiting the position now.`
    );
    await this.requestExit(position, "stop-failed");
  }

  /** Asks Kite what became of the stop - throttled unless `force`. */
  private async refreshStop(position: LivePosition, force: boolean): Promise<void> {
    const stop = position.stop;
    if (!stop?.orderId || stop.status !== "open") return;
    const now = this.deps.now();
    if (!force && now - (this.stopCheckedAt.get(position.tradeId) ?? 0) < STOP_REFRESH_MS) return;
    this.stopCheckedAt.set(position.tradeId, now);

    const last = await this.lastOrder(stop.orderId);
    if (!last) return;
    if (last.status === "COMPLETE") {
      await this.close(position, last.averagePrice, "stop");
      this.deps.alert(
        "info",
        `${position.tradingsymbol}: stopped out at the exchange @ ${last.averagePrice} - P&L ₹${Math.round(position.profit ?? 0)}.`
      );
    } else if (last.status === "REJECTED" || last.status === "CANCELLED") {
      stop.status = "failed";
      stop.reason = last.statusMessage ?? last.status;
      await this.save(position);
      this.deps.alert(
        "critical",
        `${position.tradingsymbol}: exchange stop ${last.status} (${stop.reason}). Exiting the position now.`
      );
      await this.requestExit(position, "stop-failed");
    }
  }

  // ---------------------------------------------------------------- exit

  private async requestExit(position: LivePosition, reason: NonNullable<LivePosition["exit"]>["reason"]) {
    if (position.state === "closed" || position.state === "not-entered") return;
    if (!position.exit) {
      position.exit = {
        tag: position.stop?.tag ?? "",
        orderId: null,
        reason,
        requestedAt: this.deps.now(),
        price: null,
        fillPrice: null,
        attempts: 0,
        doneAt: null,
      };
    }
    position.state = "closing";
    await this.save(position);
    this.ensureLoop();
    await this.workExit(position);
  }

  /**
   * One attempt to get out. While a stop is resting, the exit is that same
   * order modified into a sell at the bid; only with no stop to modify is a
   * fresh sell placed. Each further attempt gives up a little more on price.
   */
  private async workExit(position: LivePosition): Promise<void> {
    if (position.state !== "closing" || !position.exit) return;
    await this.withLock(position, async () => {
      const exit = position.exit!;
      const stop = position.stop;

      // The stop may have filled on its own since the exit was asked for.
      if (stop?.orderId && (stop.status === "open" || stop.status === "exiting")) {
        const last = await this.lastOrder(stop.orderId).catch(() => null);
        if (last?.status === "COMPLETE") {
          await this.close(position, last.averagePrice, stop.status === "open" ? "stop" : "exit");
          return;
        }
      }

      const quote = await this.quoteFor(position.tradingsymbol);
      const fallback = position.entry.fillPrice ?? position.entry.price;
      const price = exitPrice(quote?.bid ?? null, quote?.last ?? fallback, exit.attempts);

      let orderId: string | null = null;
      try {
        if (stop?.orderId && (stop.status === "open" || stop.status === "exiting")) {
          await this.deps.broker.modifyOrder(stop.orderId, { orderType: "LIMIT", price });
          stop.status = "exiting";
          stop.modifications += 1;
          orderId = stop.orderId;
          exit.tag = stop.tag;
        } else if (exit.orderId) {
          await this.deps.broker.modifyOrder(exit.orderId, { price });
          orderId = exit.orderId;
        } else {
          exit.tag = this.nextTag("X", position.symbol);
          orderId = await this.deps.broker.placeOrder({
            tradingsymbol: position.tradingsymbol,
            transactionType: "SELL",
            quantity: position.entry.filledQty,
            orderType: "LIMIT",
            price,
            validity: "DAY",
            tag: exit.tag,
          });
        }
      } catch (err) {
        const e = asBrokerError(err);
        exit.attempts += 1;
        await this.save(position);
        // A stop that filled between our check and the modify refuses the modify.
        if (stop?.orderId) {
          const last = await this.lastOrder(stop.orderId).catch(() => null);
          if (last?.status === "COMPLETE") {
            await this.close(position, last.averagePrice, "stop");
            return;
          }
        }
        if (!e.answered && !exit.orderId && exit.tag) {
          const found = await this.findByTag(exit.tag).catch(() => null);
          if (found) exit.orderId = found.orderId;
        }
        if (exit.attempts >= MAX_EXIT_ATTEMPTS) {
          this.deps.alert(
            "critical",
            `${position.tradingsymbol}: exit not going through after ${exit.attempts} tries (${e.message}). Square it off in the Kite app.`
          );
        }
        return;
      }

      exit.orderId = orderId;
      exit.price = price;
      exit.attempts += 1;
      await this.save(position);

      const done = orderId ? await this.waitFor(orderId, EXIT_WAIT_MS, TERMINAL) : null;
      if (done?.status === "COMPLETE") {
        await this.close(position, done.averagePrice, "exit");
      } else if (exit.attempts === MAX_EXIT_ATTEMPTS) {
        this.deps.alert(
          "critical",
          `${position.tradingsymbol}: exit still not filled after ${exit.attempts} tries at down to ${price}. Square it off in the Kite app.`
        );
      }
    });
  }

  private async close(position: LivePosition, fillPrice: number, how: "stop" | "exit"): Promise<void> {
    if (position.state === "closed") return;
    const now = this.deps.now();
    if (!position.exit) {
      position.exit = {
        tag: position.stop?.tag ?? "",
        orderId: position.stop?.orderId ?? null,
        reason: "stop",
        requestedAt: now,
        price: position.stop?.limit ?? null,
        fillPrice: null,
        attempts: 0,
        doneAt: null,
      };
    }
    position.exit.fillPrice = fillPrice;
    position.exit.doneAt = now;
    if (position.stop && how === "stop") position.stop.status = "complete";
    position.state = "closed";
    position.profit = (fillPrice - (position.entry.fillPrice ?? position.entry.price)) * position.entry.filledQty;
    await this.save(position);
    if (how === "exit") {
      this.deps.alert(
        "info",
        `SELL filled ${position.tradingsymbol} x${position.entry.filledQty} @ ${fillPrice} (${position.exit.reason}) - P&L ₹${Math.round(position.profit)}.`
      );
    }
  }

  // ------------------------------------------------------------- helpers

  private async ensureDay(): Promise<void> {
    const today = this.deps.today();
    if (this.loadedFor === today) return;
    this.positions = await this.deps.load(today);
    this.loadedFor = today;
    this.seq = 0;
    for (const p of this.positions) {
      for (const tag of [p.entry.tag, p.stop?.tag, p.exit?.tag]) {
        const n = tag ? Number.parseInt(tag.slice(7, 10), 10) : NaN;
        if (Number.isFinite(n)) this.seq = Math.max(this.seq, n);
      }
    }
  }

  private ensureLoop(): void {
    if (this.stopLoop) return;
    this.stopLoop = this.deps.schedule(() => void this.tick(), LOOP_MS);
  }

  private nextTag(kind: "E" | "S" | "X", symbol: string): string {
    this.seq += 1;
    return orderTag(this.loadedFor ?? this.deps.today(), kind, this.seq, symbol);
  }

  private find(tradeId: string): LivePosition | undefined {
    return this.positions.find((p) => p.tradeId === tradeId);
  }

  private activeCount(): number {
    return this.positions.filter((p) => ACTIVE.has(p.state)).length;
  }

  private remember(tradingsymbol: string, quote: PremiumQuote): void {
    this.quotes.set(tradingsymbol, quote);
  }

  private async quoteFor(tradingsymbol: string): Promise<PremiumQuote | null> {
    const cached = this.quotes.get(tradingsymbol);
    if (cached && this.deps.now() - cached.at <= QUOTE_FRESH_MS) return cached;
    try {
      const key = quoteKey({ tradingsymbol });
      const fresh = (await this.deps.quotes([key])).get(key) ?? null;
      if (fresh) this.remember(tradingsymbol, fresh);
      return fresh ?? cached ?? null;
    } catch {
      return cached ?? null;
    }
  }

  private async save(position: LivePosition): Promise<void> {
    position.updatedAt = this.deps.now();
    await this.deps.persist(position.tradingDate, this.positions, position);
  }

  private async withLock(position: LivePosition, work: () => Promise<void>): Promise<void> {
    if (this.busy.has(position.tradeId)) return;
    this.busy.add(position.tradeId);
    try {
      await work();
    } finally {
      this.busy.delete(position.tradeId);
    }
  }

  private async lastOrder(orderId: string): Promise<BrokerOrder | null> {
    const history = await this.deps.broker.orderHistory(orderId);
    return history.at(-1) ?? null;
  }

  private async findByTag(tag: string): Promise<BrokerOrder | null> {
    const book = await this.deps.broker.orders();
    return book.filter((o) => o.tag === tag).at(-1) ?? null;
  }

  /** Polls an order until its status is one of `until`, or the time runs out (null). */
  private async waitFor(orderId: string, timeoutMs: number, until: ReadonlySet<string>): Promise<BrokerOrder | null> {
    const deadline = this.deps.now() + timeoutMs;
    for (;;) {
      const last = await this.lastOrder(orderId).catch(() => null);
      if (last && until.has(last.status)) return last;
      if (this.deps.now() >= deadline) return null;
      await this.deps.sleep(POLL_MS);
    }
  }

  private log(text: string): void {
    console.warn(`[live] ${text}`);
  }
}

function asBrokerError(err: unknown): BrokerError {
  if (err instanceof BrokerError) return err;
  return new BrokerError(err instanceof Error ? err.message : String(err), "Unknown", false);
}

// ------------------------------------------------------------- the singleton

const LEVEL_MARK: Record<AlertLevel, string> = { critical: "🔴 CRITICAL", warning: "🟠 WARNING", info: "🟢" };

function alert(level: AlertLevel, text: string): void {
  const line = `MO1 LIVE ${LEVEL_MARK[level]} ${istClock(Date.now())}\n${text}`;
  (level === "info" ? console.log : console.warn)(`[live] ${level}: ${text}`);
  void sendTelegram(line).then((result) => {
    if (!result.ok) console.warn(`[live] telegram failed: ${result.reason}`);
  });
}

const globalRef = globalThis as typeof globalThis & { __liveDesk?: LiveDesk };

/** The one live desk for this process. */
export function liveDesk(): LiveDesk {
  globalRef.__liveDesk ??= new LiveDesk({
    broker: kiteBroker,
    alert,
    now: () => Date.now(),
    today: () => istDate(),
    quotes: fetchPremiums,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    load: readDay,
    persist: saveDay,
    entriesOn: liveEntriesOn,
    maxOpen: liveMaxOpen,
    schedule: (fn, ms) => {
      const timer = setInterval(fn, ms);
      timer.unref();
      return () => clearInterval(timer);
    },
  });
  return globalRef.__liveDesk;
}
