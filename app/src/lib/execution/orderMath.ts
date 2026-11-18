/**
 * Prices and tags for real orders. Pure, so the arithmetic is tested on its own.
 *
 * Every price is rounded to the contract's own tick. NSE stock options are not
 * all on five paise: cheap options on low-priced stocks trade in one-paisa steps
 * (IDFCFIRSTB at 1.26, IOC at 3.07). Kite's instrument dump carries each
 * contract's `tick_size`; five paise is only the fallback when it is missing.
 */

/** The tick when a contract's own is not known. */
export const DEFAULT_TICK = 0.05;

/** Rounded down to the tick - for a stop, which must never sit above where the rule put it. */
export function tickDown(price: number, tick = DEFAULT_TICK): number {
  return Math.max(tick, toPaise(Math.floor(round6(price / tick)) * tick));
}

/** Rounded up to the tick. */
export function tickUp(price: number, tick = DEFAULT_TICK): number {
  return Math.max(tick, toPaise(Math.ceil(round6(price / tick)) * tick));
}

/** Floating point turns 30.15 / 0.05 into 602.9999999; six places takes the noise out first. */
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** 602 * 0.05 is 30.100000000000001; an order wants 30.1. */
function toPaise(x: number): number {
  return Number(x.toFixed(2));
}

/**
 * How far above the ask an entry may pay: 1% of the option's own price, but
 * never more than a tenth of the trade's risk, and at least one tick.
 *
 * The ask is read a moment before the order arrives; an IOC at exactly that
 * ask is cancelled the moment the best offer moves a step - four of five
 * entries on 18 Nov. Some room fixes that, but on a big lot 1% of the premium
 * could cost more than the strategy earns (its edge is about 0.2R a trade), so
 * the room is capped in rupees by the risk: 0.1R, 55 on the desk's 550.
 */
export const ENTRY_BUFFER_PCT = 1;
export const ENTRY_BUFFER_MAX_R = 0.1;

/**
 * The entry's IOC limit. A buy limit fills at the best offer up to it, so the
 * room is only spent when the price really moved.
 */
export function entryLimit(ask: number, riskPerUnit: number, tick = DEFAULT_TICK): number {
  const room = Math.min(ask * (ENTRY_BUFFER_PCT / 100), ENTRY_BUFFER_MAX_R * riskPerUnit);
  const buffer = Math.max(tick, Math.floor(round6(room / tick)) * tick);
  return tickUp(ask + buffer, tick);
}

/**
 * The exchange stop for a filled entry.
 *
 * Trigger: the fill less the trade's risk per unit - the desk's 550 over the
 * lot - rounded down to the tick. Limit: the worst price the stop accepts once
 * triggered, half an R further down (at least two ticks), so a stop that fires
 * into a thin book still fills inside 1.5R. Below that, the watchdog takes over.
 */
export function stopPrices(
  fill: number,
  riskPerUnit: number,
  tick = DEFAULT_TICK
): { trigger: number; limit: number } {
  const trigger = tickDown(fill - riskPerUnit, tick);
  return { trigger, limit: limitUnder(trigger, riskPerUnit, tick) };
}

/** The limit half an R (at least two ticks) under a trigger. */
export function limitUnder(trigger: number, riskPerUnit: number, tick = DEFAULT_TICK): number {
  const buffer = Math.max(2 * tick, 0.5 * riskPerUnit);
  return tickDown(trigger - buffer, tick);
}

/**
 * The price an exit sells at: the bid, rounded down, so it is marketable
 * without being a market order (Zerodha blocks those on stock options). Each
 * retry gives up a little more - 1% of the price per attempt - so a book that
 * moved away while the order rested still takes it.
 */
export function exitPrice(bid: number | null, last: number, attempt: number, tick = DEFAULT_TICK): number {
  const base = bid != null && bid > 0 ? bid : last;
  return tickDown(base * (1 - 0.01 * attempt), tick);
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
