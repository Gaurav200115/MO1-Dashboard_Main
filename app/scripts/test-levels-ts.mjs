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

check("live is long v10 / short v6", [BREAKOUT_RETRACE_21EMA.version, BREAKDOWN_RETRACE_21EMA.version], [10, 6]);
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

console.log(`${passed} passed, ${failed.length} failed`);
for (const f of failed) console.log("  FAIL  " + f);
process.exit(failed.length ? 1 : 0);
