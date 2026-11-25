// The analysis page's trailing what-if and charges, for backtest runs (2026-11-25).
//
//   node scripts/test-whatif-ts.mjs
//
//   - a live-shaped trade prices exactly as before (the ladder unit is its R)
//   - an -ATR600 trade's ladder rungs are Rs 600 each, not its ATR stop
//   - Current live and SL to 0 at 1.5R come exactly from each trade's replay
//   - a backtest run is costed at Kotak Neo (no brokerage, no GST), live at Zerodha
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const jiti = createJiti(import.meta.url, { alias: { "@": src } });
const A = await jiti.import(path.join(src, "lib/strategy/analysis.ts"));
const C = await jiti.import(path.join(src, "lib/strategy/charges.ts"));

let passed = 0;
const failed = [];
function check(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) passed += 1;
  else failed.push(`${name}\n      got  ${g}\n      want ${w}`);
}
const near = (x) => Math.round(x * 1e6) / 1e6;

function trade({ id, risk = 550, qty = 250, profit, steps = [], reason = "trail-stop", atrStop }) {
  return {
    _id: id, tradingDate: "2026-10-15", status: "closed", qty, riskPerUnit: risk / qty,
    buy: { price: 30, at: 0 }, sell: { price: 30 + profit / qty, at: 1, reason }, profit,
    ladder: steps.map((step) => ({ at: 0, step, stop: 0, target: 0, locked: 0 })),
    trigger: { setup: "A", level: { pivot: "R1" }, ...(atrStop ? { atrStop } : {}) },
    instrument: { type: "CE" }, side: "LONG", setup: "A", strategyId: "x", strategyVersion: 1, step: 1,
  };
}

// Live-shaped: R 550, reached rung 3 (3R), stopped on the trail.
const live = A.analyse([trade({ id: "a", profit: 1100, steps: [2, 3] })]);
const liveOut = A.simulateTrail(live, A.liveStopR);
check("a live trade: rung 3 under the live ladder is +2R", [near(liveOut.netR), near(liveOut.net)], [2, 1100]);

// -ATR600: the ATR stop is Rs 300 (R), the ladder steps in Rs 600. Reached rung 3
// = +Rs 1,800, so the live ladder's stop there is +2 rungs = +Rs 1,200 = +4R.
const atr = { atr: 3.6, points: 1.2, rupees: 300, ladderBasis: "fixed", ladderRupees: 600 };
const fixed = A.analyse([trade({ id: "b", risk: 300, profit: 1200, steps: [2, 3], atrStop: atr })]);
const fixedOut = A.simulateTrail(fixed, A.liveStopR);
check("-ATR600: rungs priced at Rs 600, read back in the trade's own R", [near(fixedOut.net), near(fixedOut.netR)], [1200, 4]);
check("ladderRupees: the fixed 600 / the trade's own R", [A.ladderRupees(fixed[0].trade), A.ladderRupees(live[0].trade)], [600, 550]);
const own = A.analyse([trade({ id: "c", risk: 300, profit: 600, steps: [2, 3], atrStop: { ...atr, ladderBasis: "own-r", ladderRupees: 300 } })]);
check("-ATR (own R): rungs are the trade's own 300", near(A.simulateTrail(own, A.liveStopR).net), 600);

// A trade that ran to the flatten keeps its better close.
const flat = A.analyse([trade({ id: "d", risk: 300, profit: 1500, steps: [2], reason: "eod-flatten", atrStop: atr })]);
check("-ATR600 flatten above the rule's stop keeps its close", near(A.simulateTrail(flat, A.liveStopR).net), 1500);

// The replayed exits (backtest/what_if.py): exact, from each trade's own replay.
const replay = (live, be) => ({ liveRule: { profit: live, reason: "stop", exitPrice: 0, exitAt: 0, step: 1 },
                                breakevenAt15: { profit: be, reason: "breakeven", exitPrice: 0, exitAt: 0, step: 1 } });
const replayed = A.analyse([
  { ...trade({ id: "r1", profit: 0, reason: "breakeven" }), whatIf: replay(-550, 0) },
  { ...trade({ id: "r2", profit: 1100, steps: [2, 3] }), whatIf: replay(1100, 1100) },
]);
const rl = A.replayedTrail(replayed, "liveRule");
const rb = A.replayedTrail(replayed, "breakevenAt15");
check("Current live, replayed: -550 + 1,100", [near(rl.net), near(rl.netR)], [550, 1]);
check("SL to 0 at 1.5R, replayed: 0 + 1,100", [near(rb.net), near(rb.netR)], [1100, 2]);
check("one trade priced differently between them", A.changedBetween(rb.perTrade, rl.perTrade), 1);
check("a run made before the replay has none - never a partial sum",
  A.replayedTrail([...replayed, ...live], "liveRule"), null);
check("the live record's rows are unchanged", A.compareTrails(live).map((r) => r.key), ["live", "breakeven2", "prev"]);

// Charges.
const z = C.roundTripCharges(10000, 11000);
const k = C.roundTripCharges(10000, 11000, C.BACKTEST_CHARGE_RATES);
check("Kotak Neo: no brokerage, no GST", [k.brokerage, k.gst], [0, 0]);
check("same statutory charges as Zerodha", [k.stt, k.exchange, k.sebi, k.stamp].map(near), [z.stt, z.exchange, z.sebi, z.stamp].map(near));
check("Zerodha is untouched: 40 + 18% GST on top", [z.brokerage, near(z.total - k.total - 40 - z.gst)], [40, 0]);
const t1 = trade({ id: "e", profit: 250 });
check("analyse: live costs at Zerodha unless told otherwise",
  [near(A.analyse([t1])[0].charges), near(A.analyse([t1], {}, C.BACKTEST_CHARGE_RATES)[0].charges)],
  [near(C.tradeCharges(t1)), near(C.tradeCharges(t1, C.BACKTEST_CHARGE_RATES))]);
check("broker names", [C.brokerName(C.BACKTEST_CHARGE_RATES), C.brokerName(C.CHARGE_RATES)], ["Kotak Neo", "Zerodha"]);

console.log(`${passed} passed, ${failed.length} failed`);
for (const f of failed) console.log("  FAIL  " + f);
process.exit(failed.length ? 1 : 0);
