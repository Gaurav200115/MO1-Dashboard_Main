// The 60-second signal tape (lib/strategy/signalTape.ts) against a fake socket
// and a fake save: what it records, that it stops at 60s, and that nothing it
// does - a broken socket, a failed save - can reach the trade.
//
//   node scripts/test-signal-tape.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
delete process.env.MONGO_CONNECTION_STRING;
const jiti = createJiti(import.meta.url, { alias: { "@": src } });
const tape = await jiti.import(path.join(src, "lib/strategy/signalTape.ts"));

let passed = 0;
const failed = [];
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) passed += 1;
  else failed.push(`${name}\n      got  ${g}\n      want ${w}`);
}

function trade(over = {}) {
  return {
    _id: "2026-11-24:breakout-retrace-21ema:TCS:A:1",
    tradingDate: "2026-11-24", symbol: "TCS", setup: "A", qty: 225, riskPerUnit: 550 / 225,
    instrument: { tradingsymbol: "TCS26DEC2440CE", token: 15_000_001, lotSize: 225 },
    ...over,
  };
}

function rig() {
  const r = { clock: 1_000, watching: new Map(), stops: 0, timers: [], saved: [] };
  r.deps = {
    watch: (token, onTick) => { r.watching.set(token, onTick); return () => { r.stops += 1; r.watching.delete(token); }; },
    now: () => r.clock,
    later: (ms, run) => r.timers.push({ ms, run }),
    save: async (t) => { r.saved.push(t); },
  };
  r.tick = (t) => r.watching.get(15_000_001)?.(t);
  r.fire = () => { for (const t of r.timers.splice(0)) t.run(); };
  return r;
}

// --- what one tape holds
{
  const r = rig();
  tape.recordSignal(trade(), 93.3, r.deps);
  check("starts a watch on the option's token, for 60 seconds",
        [[...r.watching.keys()], r.timers.map((t) => t.ms)], [[15_000_001], [60_000]]);
  r.clock = 1_200;
  r.tick({ last_price: 93.4, exchange_timestamp: new Date(1_150), volume_traded: 500,
           depth: { buy: [{ price: 93.3, quantity: 75 }], sell: [{ price: 93.45, quantity: 225 }] } });
  r.clock = 1_900;
  r.tick({ last_price: 94.1, depth: { buy: [{ price: 0, quantity: 0 }], sell: [] } });
  r.tick({ last_price: 0 }); // no trade yet: dropped
  r.clock = 61_000;
  r.fire();
  await new Promise((res) => setImmediate(res));
  const [t] = r.saved;
  check("after 60s: the watch is stopped", [r.stops, r.watching.size], [1, 0]);
  check("and one tape saved, keyed by the trade", [r.saved.length, t._id, t.tradeId], [1, trade()._id, trade()._id]);
  check("with what priced the entry", [t.tradingsymbol, t.signalAsk, Math.round(t.riskPerUnit * t.qty)], ["TCS26DEC2440CE", 93.3, 550]);
  check("every tick: received at, exchange time, last, best bid, best offer, volume",
        t.ticks, [{ at: 1_200, ex: 1_150, ltp: 93.4, bid: 93.3, ask: 93.45, volume: 500 },
                  { at: 1_900, ex: null, ltp: 94.1, bid: null, ask: null, volume: null }]);
  check("start and end times", [t.startedAt, t.endedAt, t.truncated], [1_000, 61_000, false]);
}

// --- nothing it does can reach the trade
{
  const r = rig();
  r.deps.watch = () => { throw new Error("socket gone"); };
  let threw = false;
  try { tape.recordSignal(trade(), 93.3, r.deps); } catch { threw = true; }
  check("a broken socket: nothing thrown, nothing scheduled", [threw, r.timers.length], [false, 0]);
}
{
  const r = rig();
  r.deps.save = async () => { throw new Error("Mongo down"); };
  tape.recordSignal(trade(), 93.3, r.deps);
  let threw = false;
  try { r.fire(); await new Promise((res) => setImmediate(res)); } catch { threw = true; }
  check("a failed save: swallowed", threw, false);
}
{
  const r = rig();
  tape.recordSignal(trade({ instrument: { tradingsymbol: "OLD26NOV1CE", lotSize: 1 } }), 1, r.deps);
  check("a trade without a token (from before today): nothing recorded", [r.watching.size, r.timers.length], [0, 0]);
}
{
  const r = rig();
  tape.recordSignal(trade(), null, r.deps);
  for (let i = 0; i < 3_005; i++) r.tick({ last_price: 90 + (i % 10) / 10 });
  r.fire();
  await new Promise((res) => setImmediate(res));
  check("a flood is capped at 3,000 ticks and marked", [r.saved[0].ticks.length, r.saved[0].truncated], [3_000, true]);
}

console.log(`${passed} passed, ${failed.length} failed`);
for (const f of failed) console.log("  FAIL  " + f);
process.exit(failed.length ? 1 : 0);
