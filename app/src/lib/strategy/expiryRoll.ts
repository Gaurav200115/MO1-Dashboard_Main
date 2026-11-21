/**
 * Rolling to next month's series in the last days of a stock-option expiry.
 *
 * Stock options settle by physical delivery, so Zerodha blocks fresh buys of
 * (OTM) current-month stock options on the last two trading days of the series
 * - the day before expiry (E-1) and expiry day (E). Every live entry on those
 * days was refused (20 Nov 2026: MARUTI, HDFCBANK).
 *
 * The desk rolls one day earlier than the block, from E-2, so a block that
 * Zerodha's RMS starts a day early still misses us. From E-2 to E, both paper
 * and live buy the next expiry of the same stock, so the two stay comparable.
 * The backtest still uses the nearest expiry.
 *
 * Trading days are weekdays less NSE's trading holidays below. A year missing
 * from the list only counts weekends, which can overstate the days left and roll
 * a day late - with the E-2 buffer that is still before the block, but the list
 * should be extended every December when NSE publishes the next year.
 */

/** The first day (counted back from expiry) on which the next series is bought. */
export const ROLL_TRADING_DAYS_BEFORE_EXPIRY = 2;

/**
 * NSE equity / F&O trading holidays on weekdays.
 * 2026: from Zerodha's holiday calendar (republishing NSE's), read 21 Nov 2026.
 */
export const NSE_TRADING_HOLIDAYS: Record<number, string[]> = {
  2026: [
    "2026-01-15", // Municipal Corporation elections, Maharashtra
    "2026-01-26", // Republic Day
    "2026-03-03", // Holi
    "2026-03-26", // Shri Ram Navami
    "2026-03-31", // Shri Mahavir Jayanti
    "2026-04-03", // Good Friday
    "2026-04-14", // Dr. Baba Saheb Ambedkar Jayanti
    "2026-05-01", // Maharashtra Day
    "2026-05-28", // Bakri Eid
    "2026-06-26", // Moharram
    "2026-09-14", // Ganesh Chaturthi
    "2026-10-02", // Mahatma Gandhi Jayanti
    "2026-10-20", // Dussehra
    "2026-11-10", // Diwali Balipratipada
    "2026-11-24", // Guru Nanak Jayanti - why the Nov 2026 series expires Monday 23rd
    "2026-12-25", // Christmas
  ],
};

const HOLIDAYS = new Set(Object.values(NSE_TRADING_HOLIDAYS).flat());

/** Index options settle in cash; the physical-delivery block never applies to them. */
const INDEX_UNDERLYINGS = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50", "SENSEX", "BANKEX"]);

function utc(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

export function isTradingDay(day: string): boolean {
  const weekday = utc(day).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !HOLIDAYS.has(day);
}

/** Whether the holiday list covers this year; when false only weekends are skipped. */
export function holidaysKnown(day: string): boolean {
  return Number(day.slice(0, 4)) in NSE_TRADING_HOLIDAYS;
}

/**
 * Trading days after `today` up to and including `expiry`.
 * 0 on expiry day (E), 1 on E-1, 2 on E-2.
 */
export function tradingDaysLeft(today: string, expiry: string): number {
  let n = 0;
  const d = utc(today);
  const end = utc(expiry).getTime();
  while (true) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getTime() > end) return n;
    if (isTradingDay(d.toISOString().slice(0, 10))) n += 1;
  }
}

/** True when `today` is E-2, E-1 or E of `expiry` for a stock's options. */
export function shouldRoll(symbol: string, today: string, expiry: string): boolean {
  if (INDEX_UNDERLYINGS.has(symbol)) return false;
  if (expiry < today) return false;
  return tradingDaysLeft(today, expiry) <= ROLL_TRADING_DAYS_BEFORE_EXPIRY;
}

/**
 * The expiry to trade: the near one, or in its last days the next one listed
 * for the same stock. Stays on the near one only if no later series exists.
 */
export function tradeExpiry(symbol: string, today: string, near: string, expiries: Iterable<string>): string {
  if (!shouldRoll(symbol, today, near)) return near;
  let next: string | null = null;
  for (const e of expiries) {
    if (e > near && (!next || e < next)) next = e;
  }
  return next ?? near;
}
