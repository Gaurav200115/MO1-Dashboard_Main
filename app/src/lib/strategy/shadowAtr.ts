import type { Candle } from "@/lib/kite/history";
import { getDb, isConfigured } from "@/lib/mongo";
import { fillPrice, type PremiumQuote } from "./options";
import { evaluate } from "./position";
import type { LadderStep, StrategyRisk, StrategyTrade } from "./types";

/**
 * The ATR600 exit, run in paper beside every paper trade - a forward test.
 *
 * As Gaurav asked on 2026-11-25: "paper first". Every paper trade the desk
 * opens also gets a shadow managed under the backtest's -ATR600 exit, on the
 * same option quotes the paper trade is managed on:
 *
 *   SL      the stock's ATR(14) on 5-minute bars / 3, straight off the option
 *           premium in points - read from the closed bars at the entry moment
 *   ladder  in fixed Rs 600 steps: SL to cost at +900, +600 locked at +1,200,
 *           then every +600 (the live 1:2 -> +1R ladder with a Rs 600 unit)
 *
 * Same entry, same contract, same fill model (exits at the bid). Only the exit
 * differs, so the two can be compared trade by trade.
 *
 * A measurement, nothing else. It places no order, holds no slot in the
 * desk's book, and never changes the paper trade or the live desk - a shadow
 * can outlive its paper trade (a wider ATR stop can still be open after the
 * 550 stop fired) and is simply quoted until its own exit. Every failure is
 * swallowed here. One document per paper trade in `paper_shadows`.
 */

export const ATR600 = {
  key: "atr600",
  atrPeriod: 14,
  divisor: 3,
  ladderRupees: 600,
  breakevenAtR: 1.5,
} as const;

const COLLECTION = "paper_shadows";
/** A premium cannot trade below five paise (position.ts). */
const PREMIUM_FLOOR = 0.05;

export type ShadowStatus = "open" | "closed" | "no-atr";

export interface ShadowTrade {
  /** `<paper trade id>:atr600` */
  _id: string;
  tradeId: string;
  rule: typeof ATR600.key;
  tradingDate: string;
  strategyId: string;
  setup: string;
  symbol: string;
  instrument: StrategyTrade["instrument"];
  qty: number;
  entry: number;
  entryAt: number;
  /** The stock's 5-min ATR(14) at entry, and the stop it set in premium points. */
  atr: number | null;
  stopPoints: number | null;
  /** The ATR stop in rupees for the lot - this trade's R. */
  riskRupees: number | null;
  ladderRupees: number;
  stop: number;
  target: number;
  step: number;
  ladder: LadderStep[];
  /** When the stop moved to cost, if it did. */
  breakevenAt: number | null;
  status: ShadowStatus;
  exit: { price: number; at: number; reason: string } | null;
  profit: number | null;
  updatedAt: number;
}

/**
 * Wilder's ATR over closed candles, oldest first - true range with the previous
 * close, seeded with the plain mean of the first `period`. The same definition
 * as the backtest (backtest/atr_stop.py). Null with fewer than `period` bars.
 */
export function atrOf(candles: Candle[], period: number = ATR600.atrPeriod): number | null {
  let value: number | null = null;
  let prevClose: number | null = null;
  const first: number[] = [];
  for (const bar of candles) {
    const tr =
      prevClose == null
        ? bar.h - bar.l
        : Math.max(bar.h - bar.l, Math.abs(bar.h - prevClose), Math.abs(bar.l - prevClose));
    prevClose = bar.c;
    if (value == null) {
      first.push(tr);
      if (first.length === period) value = first.reduce((a, b) => a + b, 0) / period;
    } else {
      value = (value * (period - 1) + tr) / period;
    }
  }
  return value;
}

/** A shadow for a paper trade just opened, from the stock's closed 5-min bars. */
export function openShadow(trade: StrategyTrade, closedBars: Candle[] | null, now: number): ShadowTrade {
  const atr = closedBars ? atrOf(closedBars) : null;
  const entry = trade.buy.price;
  const unit = ATR600.ladderRupees / trade.qty;
  const usable = atr != null && atr > 0;
  const points = usable ? atr / ATR600.divisor : null;
  return {
    _id: `${trade._id}:${ATR600.key}`,
    tradeId: trade._id,
    rule: ATR600.key,
    tradingDate: trade.tradingDate,
    strategyId: trade.strategyId,
    setup: trade.setup,
    symbol: trade.symbol,
    instrument: trade.instrument,
    qty: trade.qty,
    entry,
    entryAt: trade.buy.at,
    atr: usable ? atr : null,
    stopPoints: points,
    riskRupees: points != null ? points * trade.qty : null,
    ladderRupees: ATR600.ladderRupees,
    stop: points != null ? Math.max(PREMIUM_FLOOR, entry - points) : entry,
    target: entry + 2 * unit,
    step: 1,
    ladder: [],
    breakevenAt: null,
    // A stock without 14 closed bars has no ATR: recorded, never given a made-up stop.
    status: usable ? "open" : "no-atr",
    exit: null,
    profit: null,
    updatedAt: now,
  };
}

/**
 * One quote applied to an open shadow, exactly as the paper trade's own quote
 * is applied to it (position.evaluate), on the Rs 600 unit - then the move to
 * cost. Returns true when the shadow changed.
 */
export function stepShadow(
  shadow: ShadowTrade,
  quote: PremiumQuote,
  risk: StrategyRisk,
  flatten: boolean
): boolean {
  if (shadow.status !== "open") return false;
  const close = (reason: string) => {
    const price = fillPrice(quote, "sell");
    shadow.exit = { price, at: quote.at, reason };
    shadow.profit = (price - shadow.entry) * shadow.qty;
    shadow.status = "closed";
    shadow.updatedAt = quote.at;
    return true;
  };
  if (flatten) return close("eod-flatten");

  const unit = shadow.ladderRupees / shadow.qty;
  const verdict = evaluate(
    {
      buy: { price: shadow.entry, at: shadow.entryAt },
      qty: shadow.qty,
      step: shadow.step,
      stop: shadow.stop,
      target: shadow.target,
      riskPerUnit: unit,
      status: "open",
    },
    quote.last,
    { ...risk, rupeesPerTrade: shadow.ladderRupees },
    quote.at
  );

  if (verdict.action === "exit") {
    const atCost = verdict.reason === "stop" && shadow.breakevenAt != null && shadow.stop === shadow.entry;
    return close(atCost ? "breakeven" : verdict.reason);
  }

  let changed = false;
  if (verdict.action === "trail") {
    shadow.stop = verdict.advance.stop;
    shadow.target = verdict.advance.target;
    shadow.step = verdict.advance.step;
    shadow.ladder = [...shadow.ladder, ...verdict.advance.steps];
    changed = true;
  }
  if (shadow.stop < shadow.entry && quote.last >= shadow.entry + ATR600.breakevenAtR * unit) {
    shadow.stop = shadow.entry;
    shadow.breakevenAt = quote.at;
    changed = true;
  }
  if (changed) shadow.updatedAt = quote.at;
  return changed;
}

// ---------------- storage: never throws ----------------

async function collection() {
  if (!isConfigured()) return null;
  const db = await getDb();
  return db ? db.collection<ShadowTrade>(COLLECTION) : null;
}

export async function saveShadow(shadow: ShadowTrade): Promise<void> {
  try {
    const c = await collection();
    if (!c) return;
    const { _id, ...rest } = shadow;
    await c.updateOne({ _id }, { $set: rest }, { upsert: true });
  } catch (err) {
    console.warn(`[shadow] ${shadow.symbol}: save failed — ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Today's shadows still open for a strategy, for a restarted engine to pick up. */
export async function openShadows(tradingDate: string, strategyId: string): Promise<ShadowTrade[]> {
  try {
    const c = await collection();
    if (!c) return [];
    return await c.find({ tradingDate, strategyId, status: "open" }).toArray();
  } catch {
    return [];
  }
}

/** Every shadow between two dates, for the comparison on the Backtest page. */
export async function shadowsBetween(from: string, to: string): Promise<ShadowTrade[]> {
  const c = await collection();
  if (!c) return [];
  return c.find({ tradingDate: { $gte: from, $lte: to } }).sort({ entryAt: 1 }).toArray();
}
