// The ATR600 paper shadow (lib/strategy/shadowAtr.ts).
//
//   node scripts/test-shadow-ts.mjs
//
//   - the ATR is the backtest's: true range with the previous close, Wilder, seeded by the mean
//   - his example: premium 133, ATR 14.40 -> SL 128.20; Rs 600 ladder on a 500 lot = 1.20 a rung
//   - cost at +900, +600 locked at +1,200, then every +600; exits at the bid like paper
//   - no ATR -> recorded, never given a made-up stop
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const jiti = createJiti(import.meta.url, { alias: { "@": src } });
const S = await jiti.import(path.join(src, "lib/strategy/shadowAtr.ts"));
const { BREAKOUT_RETRACE_21EMA } = await jiti.import(path.join(src, "lib/strategy/registry.ts"));
const RISK = BREAKOUT_RETRACE_21EMA.risk;

let passed = 0;
const failed = [];
function check(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) passed += 1;
  else failed.push(`${name}\n      got  ${g}\n      want ${w}`);
}
const near = (x) => (x == null ? x : Math.round(x * 1e6) / 1e6);

// ---- the ATR: the same numbers as tests/test_atr_stop.py ----
const bar = (h, l, c) => ({ t: 0, o: c, h, l, c, v: 0 });
check("no ATR before `period` bars", S.atrOf([bar(102, 100, 101), bar(106, 105, 105)], 3), null);
check("mean of the first 3 true ranges (2, gap 5, 8)",
  near(S.atrOf([bar(102, 100, 101), bar(106, 105, 105), bar(104, 97, 98)], 3)), near(5));
check("then Wilder: (5 x 2 + 1) / 3",
  near(S.atrOf([bar(102, 100, 101), bar(106, 105, 105), bar(104, 97, 98), bar(99, 99, 99)], 3)), near(11 / 3));
check("14 bars of a steady 6 range: ATR 6", near(S.atrOf(Array(30).fill(bar(103, 97, 100)))), 6);

// ---- his example ----
// 30 closed bars whose true range is 14.40 each -> ATR 14.40.
const bars = Array(30).fill(bar(1007.2, 992.8, 1000));
const trade = {
  _id: "2026-11-26:x:HAL:A:0", tradingDate: "2026-11-26", strategyId: "breakout-retrace-21ema", setup: "A",
  symbol: "HAL", instrument: { tradingsymbol: "HAL26DEC4800CE" }, qty: 500, buy: { price: 133, at: 1000 },
};
const sh = S.openShadow(trade, bars, 1000);
check("open, ATR 14.40", [sh.status, near(sh.atr)], ["open", 14.4]);
check("SL 133 - 4.80 = 128.20; R = 4.80 x 500", [near(sh.stop), near(sh.stopPoints), near(sh.riskRupees)], [128.2, 4.8, 2400]);
check("first rung at +Rs 1,200 = 133 + 2.40", near(sh.target), 135.4);
check("keyed to its paper trade", [sh._id, sh.tradeId], ["2026-11-26:x:HAL:A:0:atr600", trade._id]);

const q = (last, at, bid = last - 0.05) => ({ key: "k", last, bid, ask: last + 0.05, oi: null, volume: null, at });
check("below +900 nothing moves", [S.stepShadow(sh, q(134.79, 2000), RISK, false), near(sh.stop)], [false, 128.2]);
check("at +900 (134.80) the stop goes to cost", [S.stepShadow(sh, q(134.8, 3000), RISK, false), near(sh.stop), sh.breakevenAt], [true, 133, 3000]);
check("at +1,200 (135.40) it locks +600 (134.20)", [S.stepShadow(sh, q(135.4, 4000), RISK, false), near(sh.stop), sh.step], [true, 134.2, 2]);
check("the lock is Rs 600", near(sh.ladder.at(-1).locked), 600);
S.stepShadow(sh, q(136.6, 5000), RISK, false);
check("+1,800 -> +1,200 (135.40)", near(sh.stop), 135.4);
check("a fall to the stop exits on the trail, at the bid", [S.stepShadow(sh, q(135.3, 6000, 135.2), RISK, false), sh.status, sh.exit.reason, near(sh.profit)],
  [true, "closed", "trail-stop", near((135.2 - 133) * 500)]);
check("a closed shadow takes no more quotes", S.stepShadow(sh, q(150, 7000), RISK, false), false);

const be = S.openShadow(trade, bars, 1000);
S.stepShadow(be, q(134.9, 2000), RISK, false);
S.stepShadow(be, q(132.9, 3000, 132.85), RISK, false);
check("touched +900, fell back to cost: closed as breakeven", [be.status, be.exit.reason], ["closed", "breakeven"]);

const sl = S.openShadow(trade, bars, 1000);
S.stepShadow(sl, q(128.1, 2000, 128.0), RISK, false);
check("straight to the ATR stop: a stop, about -R", [sl.exit.reason, near(sl.profit)], ["stop", near((128 - 133) * 500)]);

const fl = S.openShadow(trade, bars, 1000);
S.stepShadow(fl, q(131, 2000, 130.9), RISK, true);
check("the flatten closes it at the bid", [fl.exit.reason, near(fl.profit)], ["eod-flatten", near((130.9 - 133) * 500)]);

const none = S.openShadow(trade, bars.slice(0, 5), 1000);
check("fewer than 14 bars: no ATR, not tracked", [none.status, none.atr, S.stepShadow(none, q(100, 2000), RISK, false)], ["no-atr", null, false]);
check("no bars at all: the same", S.openShadow(trade, null, 1000).status, "no-atr");

const deep = S.openShadow({ ...trade, buy: { price: 3, at: 1000 } }, bars, 1000);
check("an ATR stop past zero premium sits at the 5-paisa floor", near(deep.stop), 0.05);

console.log(`${passed} passed, ${failed.length} failed`);
for (const f of failed) console.log("  FAIL  " + f);
process.exit(failed.length ? 1 : 0);
