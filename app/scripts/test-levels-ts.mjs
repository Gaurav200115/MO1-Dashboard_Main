// The live desk's major-level pick (lib/strategy/levels.ts) against the
// backtest's: long v10 / short v6 must choose exactly what A-SK / C-SK chose.
//
//   node scripts/test-levels-ts.mjs
//
// The same cases as test_pivot_skew.py's "the pick" section.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const jiti = createJiti(import.meta.url, { alias: { "@": src } });
const { planForStock } = await jiti.import(path.join(src, "lib/strategy/levels.ts"));
const { BREAKOUT_RETRACE_21EMA, BREAKDOWN_RETRACE_21EMA } = await jiti.import(
  path.join(src, "lib/strategy/registry.ts")
);

let passed = 0;
const failed = [];
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) passed += 1;
  else failed.push(`${name}\n      got  ${g}\n      want ${w}`);
}

function level(pivot, kind, skew, gap) {
  const other = 100;
  const [callOi, putOi] = kind === "resistance" ? [skew * other, other] : [other, skew * other];
  return { pivot, pivotValue: 1000, kind, strike: 1000, callOi, putOi, ratio: null, gapPct: gap,
           precious: false, reachPct: 1 };
}

function pick(levels, params) {
  const plan = planForStock({ symbol: "TEST", name: "Test", sector: "X", levels,
                              session: { close: 1000, date: "2026-11-13" }, adr: null }, params);
  return plan ? [plan.majorResistance?.pivot ?? null, plan.majorSupport?.pivot ?? null] : [null, null];
}

const LONG = BREAKOUT_RETRACE_21EMA.params;
const SHORT = BREAKDOWN_RETRACE_21EMA.params;
const OLD = { ...LONG, pivotMinSkew: undefined, resistanceSkew: 4, supportSkew: 5 };

check("live is long v11 / short v7", [BREAKOUT_RETRACE_21EMA.version, BREAKDOWN_RETRACE_21EMA.version], [11, 7]);
check("both read the same table", LONG.pivotMinSkew, SHORT.pivotMinSkew);
check("5x for R1/R3/S1/S3, any for R2/S2/P", LONG.pivotMinSkew, { R1: 5, R3: 5, S1: 5, S3: 5, R2: 0, S2: 0, P: 0 });
check("the per-side bars are gone", [LONG.resistanceSkew, LONG.supportSkew], [undefined, undefined]);

const support = level("S1", "support", 10, 0.5);
check("R1 at 4.5x vs R2 at 2x: the old rule took R1",
      pick([level("R1", "resistance", 4.5, 0.1), level("R2", "resistance", 2, 0.3), support], OLD), ["R1", "S1"]);
check("v10 takes R2", pick([level("R1", "resistance", 4.5, 0.1), level("R2", "resistance", 2, 0.3), support], LONG), ["R2", "S1"]);
check("both qualify: the closer R2 wins",
      pick([level("R1", "resistance", 6, 0.2), level("R2", "resistance", 2, 0.1), support], LONG), ["R2", "S1"]);
check("a lone R3 at 4.5x: no major resistance", pick([level("R3", "resistance", 4.5, 0.1), support], LONG), [null, "S1"]);
check("exactly 5.00x passes", pick([level("R1", "resistance", 5, 0.1), support], LONG), ["R1", "S1"]);
check("4.99x does not", pick([level("R1", "resistance", 4.99, 0.1), support], LONG), [null, "S1"]);
check("S2 at 3x beats a farther S1 at 6x",
      pick([level("S2", "support", 3, 0.1), level("S1", "support", 6, 0.3)], SHORT), [null, "S2"]);
check("P as a support at 2x qualifies", pick([level("P", "support", 2, 0.1)], SHORT), [null, "P"]);
check("S3 at 4.9x alone: no plan at all", pick([level("S3", "support", 4.9, 0.1)], SHORT), [null, null]);

// ---------------- the step-cost gate (long v11 / short v7) ----------------
const { assessBook } = await jiti.import(path.join(src, "lib/strategy/tradeable.ts"));
const now = Date.parse("2026-11-19T05:00:00Z");
const book = (ask, tickSize, qty, params = LONG) => assessBook({
  quote: { key: "NFO:X", last: ask, bid: ask - tickSize, ask, oi: 100000, volume: 100000, lastTradeAt: now, at: now },
  qty, riskPerUnit: 550 / qty, params, strikeOi: null, chainMaxOi: null, tickSize, now });
check("the gate is at 20% of the risk", LONG.maxStepCostOfRiskPct, 20);
const eternal = book(3.9, 0.05, 2425);
check("ETERNAL lot 2,425 on five paise: one step 121 > 110 -> step-too-costly",
      [eternal.ok, eternal.reason], [false, "step-too-costly"]);
check("the same lot on one paisa (24 a step) passes", book(3.91, 0.01, 2425).ok, true);
check("IDFCFIRSTB lot 9,275 on one paisa (93 a step) passes", book(1.26, 0.01, 9275).ok, true);
check("a normal lot (250 x 0.05) passes", book(30, 0.05, 250).ok, true);
check("a rule without the setting (v10) does not check it",
      book(3.9, 0.05, 2425, { ...LONG, maxStepCostOfRiskPct: undefined }).ok, true);
check("an unknown tick skips the check", book(3.9, null, 2425).ok, true);

// ---------------- estimated charges (paper and backtest analysis) ----------------
const { roundTripCharges } = await jiti.import(path.join(src, "lib/strategy/charges.ts"));
const { analyse, stats } = await jiti.import(path.join(src, "lib/strategy/analysis.ts"));
const titan = roundTripCharges(54.9 * 175, 54.9 * 175 - 901).total;
const ashok = roundTripCharges(1.81 * 5000, 1.81 * 5000 + 550).total;
check("19 Nov contract note: two round trips ~ 138", Math.round(titan + ashok), 138);
const t = (id, buy, sell, qty, at) => ({ _id: id, tradingDate: "2026-11-19", status: "closed", qty, riskPerUnit: 550 / qty,
  buy: { price: buy, at }, sell: { price: sell, at: at + 60000, reason: "stop" }, profit: (sell - buy) * qty,
  strategyId: "s", strategyVersion: 11, setup: "A", symbol: "X", ladder: [], trigger: { level: { pivot: "R1", skew: 6 } },
  instrument: { tradingsymbol: "X", type: "CE" } });
const rows = analyse([t("a", 30, 36, 250, 1), t("b", 30, 27.8, 250, 2)]);
const st = stats(rows);
const want = rows.reduce((x, r) => x + r.charges, 0);
check("analysis: charges summed per round trip", Math.round(st.charges * 100), Math.round(want * 100));
check("analysis: net after charges = net - charges", Math.round(st.netAfterCharges * 100), Math.round((st.net - want) * 100));

console.log(`${passed} passed, ${failed.length} failed`);
for (const f of failed) console.log("  FAIL  " + f);
process.exit(failed.length ? 1 : 0);
