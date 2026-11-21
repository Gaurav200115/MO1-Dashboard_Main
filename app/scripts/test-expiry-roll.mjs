// The expiry roll (lib/strategy/expiryRoll.ts): from E-2 to expiry day a stock
// option entry buys next month's series, because Zerodha refuses fresh buys of
// current-month stock options in the last two days.
//
//   node scripts/test-expiry-roll.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const jiti = createJiti(import.meta.url, { alias: { "@": src } });
const R = await jiti.import(path.join(src, "lib/strategy/expiryRoll.ts"));

let passed = 0;
const failed = [];
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) passed += 1;
  else failed.push(`${name}\n      got  ${g}\n      want ${w}`);
}

const NOV = "2026-11-23", DEC = "2026-12-29", JAN = "2027-01-26";
const series = [NOV, NOV, DEC, DEC, JAN];

// Nov 2026: expiry Monday 23rd (Tuesday 24th is Guru Nanak Jayanti).
check("Mon 23 Nov is E", R.tradingDaysLeft("2026-11-23", NOV), 0);
check("Fri 20 Nov is E-1 (weekend skipped)", R.tradingDaysLeft("2026-11-20", NOV), 1);
check("Thu 19 Nov is E-2", R.tradingDaysLeft("2026-11-19", NOV), 2);
check("Wed 18 Nov is E-3", R.tradingDaysLeft("2026-11-18", NOV), 3);

check("E-3 keeps Nov", R.tradeExpiry("MARUTI", "2026-11-18", NOV, series), NOV);
check("E-2 rolls to Dec", R.tradeExpiry("MARUTI", "2026-11-19", NOV, series), DEC);
check("E-1 (20 Nov, the refused day) rolls to Dec", R.tradeExpiry("MARUTI", "2026-11-20", NOV, series), DEC);
check("expiry day rolls to Dec", R.tradeExpiry("HDFCBANK", "2026-11-23", NOV, series), DEC);
check("a weekend day before E-1 rolls too", R.tradeExpiry("MARUTI", "2026-11-21", NOV, series), DEC);

// Holidays count: Dec expiry Tue 29th, Christmas Fri 25th.
check("Thu 24 Dec is E-2 across Christmas", R.tradingDaysLeft("2026-12-24", DEC), 2);
check("Wed 23 Dec is E-3 across Christmas", R.tradingDaysLeft("2026-12-23", DEC), 3);
check("so 24 Dec rolls to Jan", R.tradeExpiry("TCS", "2026-12-24", DEC, series), JAN);
check("and 23 Dec does not", R.tradeExpiry("TCS", "2026-12-23", DEC, series), DEC);
check("a holiday is not a trading day", R.isTradingDay("2026-11-24"), false);
check("a normal Wednesday is", R.isTradingDay("2026-11-18"), true);

check("index options never roll", R.tradeExpiry("NIFTY", "2026-11-20", NOV, series), NOV);
check("no later series: stays on the near one", R.tradeExpiry("MARUTI", "2026-11-20", NOV, [NOV]), NOV);
check("the roll is the very next series, not a later one", R.tradeExpiry("MARUTI", "2026-11-20", NOV, [JAN, DEC, NOV]), DEC);
check("holiday list covers 2026", R.holidaysKnown("2026-11-20"), true);
check("2027 not yet listed (weekends only)", R.holidaysKnown("2027-01-04"), false);

console.log(`${passed} passed, ${failed.length} failed`);
for (const f of failed) console.log("  FAIL  " + f);
process.exit(failed.length ? 1 : 0);
