// The dashboard's half of the capital-ledger run id (lib/backtest/key.ts).
//
//   node scripts/test-ledger-ts.mjs
//
// Must match backtest/runner.py run_key exactly - tests/test_ledger.py pins the
// same id from the Python side.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const jiti = createJiti(import.meta.url, { alias: { "@": src } });
const { runKey } = await jiti.import(path.join(src, "lib/backtest/key.ts"));

let passed = 0;
const failed = [];
function check(name, got, want) {
  if (got === want) passed += 1;
  else failed.push(`${name}\n      got  ${got}\n      want ${want}`);
}
const legs = ["C-ATR600", "A-ATR600", "B-ATR600"];
check("with Rs 35,000: the id the Python side pins", runKey(legs, "2025-10-23", "2026-11-12", 35000), "b86d9a756ff9f5d5");
check("without a capital: unchanged from before the ledger",
  runKey(legs, "2025-10-23", "2026-11-12"), runKey(legs, "2025-10-23", "2026-11-12", null));
check("a different capital is a different run",
  runKey(legs, "2025-10-23", "2026-11-12", 50000) !== runKey(legs, "2025-10-23", "2026-11-12", 35000), true);
console.log(`${passed} passed, ${failed.length} failed`);
for (const f of failed) console.log("  FAIL  " + f);
process.exit(failed.length ? 1 : 0);
