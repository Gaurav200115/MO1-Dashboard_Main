/**
 * Prices and tags for real orders. Pure, so the arithmetic is tested on its own.
 */

/** NSE option prices move in five-paise steps; an order off the tick is refused. */
export const TICK = 0.05;
/** The lowest price an option order can carry. */
export const MIN_PRICE = 0.05;

/** Rounded down to the tick - for a stop, which must never sit above where the rule put it. */
export function tickDown(price: number): number {
  return Math.max(MIN_PRICE, toPaise(Math.floor(round6(price / TICK)) * TICK));
}

/** Rounded up to the tick. */
export function tickUp(price: number): number {
  return Math.max(MIN_PRICE, toPaise(Math.ceil(round6(price / TICK)) * TICK));
}

/** 602 * 0.05 is 30.100000000000001; an order wants 30.1. */
function toPaise(x: number): number {
  return Number(x.toFixed(2));
}

/** Floating point turns 30.15 / 0.05 into 602.9999999; six places takes the noise out first. */
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/**
 * The exchange stop for a filled entry.
 *
 * Trigger: the fill less the trade's risk per unit - the desk's 550 over the
 * lot - rounded down to the tick. Limit: the worst price the stop accepts once
 * triggered, half an R further down (at least two ticks), so a stop that fires
 * into a thin book still fills inside 1.5R. Below that, the watchdog takes over.
 */
export function stopPrices(fill: number, riskPerUnit: number): { trigger: number; limit: number } {
  const trigger = tickDown(fill - riskPerUnit);
  return { trigger, limit: limitUnder(trigger, riskPerUnit) };
}

/** The limit half an R (at least two ticks) under a trigger. */
export function limitUnder(trigger: number, riskPerUnit: number): number {
  const buffer = Math.max(2 * TICK, 0.5 * riskPerUnit);
  return tickDown(trigger - buffer);
}

/**
 * The price an exit sells at: the bid, rounded down, so it is marketable
 * without being a market order (Zerodha blocks those on stock options). Each
 * retry gives up a little more - 1% of the price per attempt - so a book that
 * moved away while the order rested still takes it.
 */
export function exitPrice(bid: number | null, last: number, attempt: number): number {
  const base = bid != null && bid > 0 ? bid : last;
  return tickDown(base * (1 - 0.01 * attempt));
}

/**
 * Kite's tag: alphanumeric, at most 20 characters. Ours carries the date, what
 * the order is for, a per-day sequence and the symbol, so an order found in the
 * book by tag alone says what it was:
 *
 *   M1 1116 E 007 TVSMOT    the 7th live order on 16 Nov, an entry, TVSMOTOR
 *
 * The sequence makes it unique, which is what lets a lost reply be resolved by
 * looking the order up rather than by sending it again.
 */
export function orderTag(tradingDate: string, kind: "E" | "S" | "X", seq: number, symbol: string): string {
  const mmdd = tradingDate.slice(5, 7) + tradingDate.slice(8, 10);
  const sym = symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return `M1${mmdd}${kind}${String(seq).padStart(3, "0")}${sym}`.slice(0, 20);
}
