/**
 * IST wall-clock helpers, kept dependency-free so client components can import
 * them. The desk's other date helper lives in kite/history.ts, which pulls in
 * kiteconnect and cannot cross into the browser bundle.
 *
 * Everything the strategy layer decides is anchored on exchange local time: the
 * entry window closes at an IST wall-clock time, bars are cut on IST boundaries,
 * and a trading day is an IST date. None of that survives being expressed in the
 * server's own timezone, which on a cloud host is rarely IST.
 */

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** IST calendar date for an epoch — the trading-day key used everywhere. */
export function istDate(ms = Date.now()): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Minutes since IST midnight, for comparing against the session windows. */
export function istMinutes(ms = Date.now()): number {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** "11:30" -> 690. Throws on a malformed value so a bad param fails loudly. */
export function parseIstTime(hhmm: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) throw new Error(`Not an IST time: "${hhmm}" (expected HH:MM)`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error(`Not an IST time: "${hhmm}"`);
  return hours * 60 + minutes;
}

/** 09:15 IST — NSE's equity open. */
export const MARKET_OPEN_MIN = 9 * 60 + 15;
/** 15:30 IST — the close. */
export const MARKET_CLOSE_MIN = 15 * 60 + 30;

export function isMarketHours(ms = Date.now()): boolean {
  const day = new Date(ms + IST_OFFSET_MS).getUTCDay();
  if (day === 0 || day === 6) return false;
  const minute = istMinutes(ms);
  return minute >= MARKET_OPEN_MIN && minute <= MARKET_CLOSE_MIN;
}

/** "HH:MM:SS" in IST, for log lines and the blotter. */
export function istClock(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 19);
}
