// The live desk against a stand-in Kite: every real-order path, no real order.
//
//   node scripts/test-live-desk.mjs
//
// Imports the TypeScript modules through jiti (with the @/ alias), swaps the
// broker, the clock and the alerts for fakes, and keeps the journal in a temp
// folder. Covers Monday's case - an order rejected for insufficient funds - and
// everything a fill sets in motion: the exchange stop, the trail, the exit by
// modify, a stop that fires at the exchange, a stop that cannot be placed, a
// lost reply resolved by tag, the cap, reconciliation, the switch and the kill.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..", "src");
const runtime = mkdtempSync(path.join(tmpdir(), "mo1-live-"));
process.env.KITE_RUNTIME_DIR = runtime;
delete process.env.MONGO_CONNECTION_STRING;
delete process.env.TELEGRAM_BOT_TOKEN;

const jiti = createJiti(import.meta.url, { alias: { "@": src } });
const { LiveDesk } = await jiti.import(path.join(src, "lib/execution/desk.ts"));
const { BrokerError } = await jiti.import(path.join(src, "lib/execution/types.ts"));
const math = await jiti.import(path.join(src, "lib/execution/orderMath.ts"));
const journal = await jiti.import(path.join(src, "lib/execution/journal.ts"));
const mode = await jiti.import(path.join(src, "lib/execution/mode.ts"));

let passed = 0;
const failed = [];
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) passed += 1;
  else failed.push(`${name}\n      got  ${g}\n      want ${w}`);
}

// ------------------------------------------------------------ order maths

check("tick down", math.tickDown(30.123), 30.1);
check("tick down never below 0.05", math.tickDown(0.01), 0.05);
check("tick up", math.tickUp(30.101), 30.15);
check("an exact tick stays", [math.tickDown(30.15), math.tickUp(30.15)], [30.15, 30.15]);
check("stop for a 30.00 fill on a 250 lot (R 2.20/unit): trigger 27.80, limit 26.70",
      math.stopPrices(30, 2.2), { trigger: 27.8, limit: 26.7 });
check("a tiny R still leaves two ticks between trigger and limit",
      math.stopPrices(10, 0.1), { trigger: 9.9, limit: 9.8 });
check("exit at the bid, rounded down", math.exitPrice(25.13, 25.5, 0), 25.1);
check("each retry gives up 1% more", math.exitPrice(25, 25, 2), 24.5);
check("no bid: the last price", math.exitPrice(null, 20, 0), 20);
check("entry limit: ask 30.00 + 1% = 30.30", math.entryLimit(30), 30.3);
check("entry limit: 1% of the premium, rounded up to the tick (15.10 -> 15.30)", math.entryLimit(15.1), 15.3);
check("entry limit: a dear option gets more room (140.60 -> 142.05)", math.entryLimit(140.6), 142.05);
check("entry limit: never less than two ticks over (5.50 -> 5.60, 2.30 -> 2.40)",
      [math.entryLimit(5.5), math.entryLimit(2.3)], [5.6, 2.4]);
const tag = math.orderTag("2026-11-16", "E", 7, "TVSMOTOR");
check("tag: date, kind, sequence, symbol", tag, "M11116E007TVSMOTOR");
check("tags are alphanumeric and at most 20", [
  /^[A-Z0-9]{1,20}$/.test(math.orderTag("2026-11-16", "S", 123, "M&M")),
  math.orderTag("2026-11-16", "X", 1, "BAJAJ-AUTO-VERYLONGNAME").length <= 20,
], [true, true]);

// ------------------------------------------------------------ the fakes

class FakeKite {
  constructor() {
    this.calls = [];
    this.book = new Map();
    this.next = 1;
    this.netOverride = null;
    // The best offer in the book when an IOC buy arrives. A buy limit at or
    // above it fills AT it - the exchange gives the better price - and one
    // below it finds nobody and is cancelled.
    this.ask = 30;
    // What happens to an order when placed: (order) => behaviour
    this.onPlace = () => ({});
    // What happens when an order is modified: (order, change) => void
    this.onModify = () => {};
  }
  record(order, status, extra = {}) {
    const id = String(this.next++);
    const row = { orderId: id, tag: order.tag, status, statusMessage: null, filledQty: 0,
      averagePrice: 0, orderType: order.orderType, triggerPrice: order.triggerPrice ?? 0,
      price: order.price, side: order.transactionType, tradingsymbol: order.tradingsymbol,
      quantity: order.quantity, ...extra };
    this.book.set(id, row);
    return row;
  }
  async placeOrder(order) {
    this.calls.push(["place", order]);
    const b = this.onPlace(order) ?? {};
    if (b.refuse) throw new BrokerError(b.refuse, b.kind ?? "InputException", true);
    if (b.lostReply) {
      if (b.reachedZerodha) this.record(order, b.status ?? "REJECTED", b.extra);
      throw new BrokerError("No response from server with error code: ETIMEDOUT", "NetworkException", false);
    }
    let status = b.status;
    let fill = b.fill;
    if (!status) {
      if (order.orderType === "SL") status = "TRIGGER PENDING";
      else if (order.transactionType === "BUY" && order.validity === "IOC" && this.ask != null) {
        if (this.ask <= order.price) { status = "COMPLETE"; fill = fill ?? this.ask; }
        else status = "CANCELLED";
      } else status = "COMPLETE";
    }
    const filled = status === "COMPLETE" ? order.quantity : 0;
    return this.record(order, status, { filledQty: filled, averagePrice: filled ? (fill ?? order.price) : 0,
      statusMessage: b.message ?? null, ...(b.extra ?? {}) }).orderId;
  }
  async modifyOrder(id, change) {
    this.calls.push(["modify", id, change]);
    const row = this.book.get(id);
    if (!row || ["COMPLETE", "REJECTED", "CANCELLED"].includes(row.status)) {
      throw new BrokerError(`Order cannot be modified as it is being processed`, "InputException", true);
    }
    if (change.orderType) row.orderType = change.orderType;
    if (change.price != null) row.price = change.price;
    if (change.triggerPrice != null) row.triggerPrice = change.triggerPrice;
    this.onModify(row, change);
  }
  async orderHistory(id) {
    this.calls.push(["history", id]);
    const row = this.book.get(id);
    return row ? [{ ...row }] : [];
  }
  async orders() {
    this.calls.push(["orders"]);
    return [...this.book.values()].map((r) => ({ ...r }));
  }
  async positions() {
    this.calls.push(["positions"]);
    if (this.netOverride) return this.netOverride;
    const net = new Map();
    for (const r of this.book.values()) {
      if (r.status !== "COMPLETE") continue;
      const q = (r.side === "BUY" ? 1 : -1) * r.filledQty;
      net.set(r.tradingsymbol, (net.get(r.tradingsymbol) ?? 0) + q);
    }
    return [...net].map(([tradingsymbol, quantity]) => ({ tradingsymbol, exchange: "NFO", product: "MIS", quantity }));
  }
  count(kind, pred = () => true) {
    return this.calls.filter((c) => c[0] === kind && pred(c)).length;
  }
}

const DAY = "2026-11-16";
let clock = Date.parse("2026-11-16T04:30:00Z"); // 10:00 IST

function makeDesk(kite, opts = {}) {
  const alerts = [];
  const desk = new LiveDesk({
    broker: kite,
    alert: (level, text) => alerts.push([level, text]),
    now: () => clock,
    today: () => opts.day ?? DAY,
    quotes: async (keys) => new Map(keys.map((k) => [k, quote(opts.quoteLast ?? 30, opts.quoteBid ?? 29.9)])),
    sleep: async (ms) => { clock += ms; },
    load: journal.readDay,
    persist: journal.saveDay,
    entriesOn: opts.entriesOn ?? (async () => true),
    maxOpen: () => opts.maxOpen ?? 1,
    schedule: () => () => {},
  });
  return { desk, alerts };
}

function quote(last, bid, ask = last + 0.1) {
  return { key: "NFO:X", last, bid, ask, oi: 1000, volume: 100, lastTradeAt: clock, at: clock };
}

let seq = 0;
function trade(symbol = "TVSMOTOR", over = {}) {
  seq += 1;
  return {
    _id: `${DAY}:breakout-retrace-21ema:${symbol}:A:${seq}`,
    strategyId: "breakout-retrace-21ema",
    setup: "A",
    symbol,
    instrument: { tradingsymbol: `${symbol}26NOV2900CE`, lotSize: 250, strike: 2900, type: "CE", expiry: "2026-11-26" },
    qty: 250,
    riskPerUnit: 2.2,
    stop: 27.8,
    ...over,
  };
}

function fresh(name) {
  rmSync(path.join(runtime, "live"), { recursive: true, force: true });
  globalThis.__executionMode = undefined;
  return name;
}

// ------------------------------------------------------------ Monday: no funds

fresh("monday");
{
  const kite = new FakeKite();
  kite.onPlace = (o) => o.transactionType === "BUY"
    ? { status: "REJECTED", message: "RMS:Margin Exceeds,Required:7500.00, Available:0.00 for entity account-XX12345" }
    : {};
  const { desk, alerts } = makeDesk(kite);
  const t = trade();
  await desk.onEntry(t, quote(29.95, 29.9, 30.0));
  const [p] = (await desk.status()).positions;
  check("Monday: one BUY sent - LIMIT, IOC, at the ask plus 1%, with a tag",
        kite.calls.filter((c) => c[0] === "place").map((c) => [c[1].transactionType, c[1].orderType, c[1].validity, c[1].price, c[1].quantity, /^M11116E001TVSMOTOR$/.test(c[1].tag)]),
        [["BUY", "LIMIT", "IOC", 30.3, 250, true]]);
  check("Monday: the ask it was priced from is kept beside the limit", [p.entry.ask, p.entry.price], [30, 30.3]);
  check("Monday: every step is timed - quote, signal, sent to Kite, answered",
        [typeof p.entry.quoteAt, p.entry.placedAt >= p.entry.sentAt, p.entry.ackAt >= p.entry.placedAt], ["number", true, true]);
  check("Monday: recorded as rejected, nothing entered", [p.state, p.entry.status], ["not-entered", "rejected"]);
  check("Monday: with Zerodha's reason", p.entry.reason.startsWith("RMS:Margin Exceeds"), true);
  check("Monday: no stop placed for a rejected entry", [p.stop, kite.count("place", (c) => c[1].transactionType === "SELL")], [null, 0]);
  check("Monday: a warning goes to the phone with the reason",
        alerts.some(([l, x]) => l === "warning" && x.includes("REJECTED") && x.includes("Margin Exceeds")), true);
  clock += 120_000;
  check("Monday: reconciliation finds nothing wrong", await desk.reconcile(), []);
  check("Monday: written to the day's journal on disk", (await journal.readDay(DAY)).map((x) => x.entry.status), ["rejected"]);
}

// ------------------------------------------------------------ refusals and lost replies

fresh("ip");
{
  const kite = new FakeKite();
  kite.onPlace = () => ({ refuse: "Order from an unregistered IP is not allowed", kind: "PermissionException" });
  const { desk, alerts } = makeDesk(kite);
  await desk.onEntry(trade(), quote(30, 29.9, 30));
  const [p] = (await desk.status()).positions;
  check("an answered refusal (IP not whitelisted) is final: rejected, no lookup",
        [p.entry.status, kite.count("orders"), kite.count("place")], ["rejected", 0, 1]);
  check("and the reason reaches the phone", alerts.some(([, x]) => x.includes("unregistered IP")), true);
}

fresh("lost-found");
{
  const kite = new FakeKite();
  kite.onPlace = (o) => o.transactionType === "BUY"
    ? { lostReply: true, reachedZerodha: true, status: "REJECTED", extra: { statusMessage: "insufficient funds" } }
    : {};
  const { desk } = makeDesk(kite);
  await desk.onEntry(trade(), quote(30, 29.9, 30));
  const [p] = (await desk.status()).positions;
  check("no reply, but at Zerodha: found by its tag, never sent twice",
        [kite.count("place"), p.entry.orderId != null, p.entry.status], [1, true, "rejected"]);
}

fresh("lost-missing");
{
  const kite = new FakeKite();
  kite.onPlace = () => ({ lostReply: true, reachedZerodha: false });
  const { desk, alerts } = makeDesk(kite);
  await desk.onEntry(trade(), quote(30, 29.9, 30));
  const [p] = (await desk.status()).positions;
  check("no reply and not in the book after three lookups: not placed, not retried",
        [p.entry.status, p.state, kite.count("orders"), kite.count("place")], ["not-placed", "not-entered", 3, 1]);
  check("and said so", alerts.some(([, x]) => x.includes("never reached Zerodha")), true);
}

fresh("ioc");
{
  const kite = new FakeKite();
  kite.onPlace = () => ({ status: "CANCELLED" });
  const { desk } = makeDesk(kite);
  await desk.onEntry(trade(), quote(30, 29.9, 30));
  const [p] = (await desk.status()).positions;
  check("IOC found no seller: cancelled, nothing bought", [p.entry.status, p.state, p.stop], ["cancelled", "not-entered", null]);
}

// 18 Nov: the quote said 30.00, but by the time the order arrived the best
// offer was a step higher. At exactly the ask that was cancelled; with 1% of
// room it fills - at the real offer, not at the limit.
fresh("stale-ask");
{
  const kite = new FakeKite();
  kite.ask = 30.1;
  const { desk } = makeDesk(kite);
  await desk.onEntry(trade(), quote(29.95, 29.9, 30.0));
  const [p] = (await desk.status()).positions;
  check("the offer moved up a step: limit 30.30 still fills, at the real offer 30.10",
        [p.entry.status, p.entry.price, p.entry.fillPrice], ["filled", 30.3, 30.1]);
  check("and the stop is set from what was actually paid: 30.10 - 2.20 = 27.90",
        [p.stop.trigger, p.stop.limit], [27.9, 26.8]);
}

fresh("ran-away");
{
  const kite = new FakeKite();
  kite.ask = 30.5;
  const { desk } = makeDesk(kite);
  await desk.onEntry(trade(), quote(29.95, 29.9, 30.0));
  const [p] = (await desk.status()).positions;
  check("the offer ran more than 1% away (30.50 > 30.30): not chased, cancelled",
        [p.entry.status, p.state], ["cancelled", "not-entered"]);
}

fresh("off");
{
  const kite = new FakeKite();
  const { desk } = makeDesk(kite, { entriesOn: async () => false });
  await desk.onEntry(trade(), quote(30, 29.9, 30));
  check("live orders off: nothing is sent", [kite.calls.length, (await desk.status()).positions.length], [0, 0]);
}

// ------------------------------------------------------------ Tuesday: a fill

fresh("fill");
{
  const kite = new FakeKite();
  kite.onPlace = () => ({ fill: 30.0 });
  const { desk, alerts } = makeDesk(kite, { quoteBid: 31.2, quoteLast: 31.3 });
  const t = trade();
  await desk.onEntry(t, quote(30, 29.9, 30));
  let [p] = (await desk.status()).positions;
  const sl = kite.calls.filter((c) => c[0] === "place" && c[1].transactionType === "SELL");
  check("filled: state open, fill recorded", [p.state, p.entry.status, p.entry.fillPrice, p.entry.filledQty], ["open", "filled", 30, 250]);
  check("an exchange stop rests at once: SELL SL, trigger 27.80, limit 26.70, same qty",
        sl.map((c) => [c[1].orderType, c[1].triggerPrice, c[1].price, c[1].quantity, c[1].validity, c[1].tag.slice(6, 7)]),
        [["SL", 27.8, 26.7, 250, "DAY", "S"]]);
  check("stop recorded as open", [p.stop.status, p.stop.trigger, p.stop.limit], ["open", 27.8, 26.7]);

  // The paper ladder moves the stop to +1R (32.20) - the exchange stop follows.
  await desk.onTrail({ ...t, stop: 32.2 });
  const mods = kite.calls.filter((c) => c[0] === "modify");
  check("trail: the same stop order is modified - trigger 32.20, limit 31.10",
        mods.map((c) => [c[1], c[2].triggerPrice, c[2].price]), [[p.stop.orderId, 32.2, 31.1]]);
  await desk.onTrail({ ...t, stop: 31.0 });
  check("a stop is never moved down", kite.count("modify"), 1);

  // The paper trade closes: the stop becomes a sell at the bid, and fills.
  kite.onModify = (row, change) => { if (change.orderType === "LIMIT") Object.assign(row, { status: "COMPLETE", filledQty: row.quantity, averagePrice: change.price }); };
  await desk.onExit(t, quote(31.3, 31.2, 31.4), "trail-stop");
  [p] = (await desk.status()).positions;
  const exitMod = kite.calls.filter((c) => c[0] === "modify").at(-1);
  check("exit: the stop order itself is modified into a LIMIT sell at the bid",
        [exitMod[1], exitMod[2].orderType, exitMod[2].price], [p.stop.orderId, "LIMIT", 31.2]);
  check("only one SELL order ever placed for the position",
        kite.count("place", (c) => c[1].transactionType === "SELL"), 1);
  check("closed with the real P&L: (31.20 - 30.00) x 250",
        [p.state, p.exit.fillPrice, Math.round(p.profit)], ["closed", 31.2, 300]);
  check("the fill and the exit both reached the phone",
        [alerts.some(([, x]) => x.startsWith("BUY filled")), alerts.some(([, x]) => x.startsWith("SELL filled"))], [true, true]);
  clock += 120_000;
  check("reconciliation: flat at Zerodha, flat here", await desk.reconcile(), []);
}

fresh("stop-fires");
{
  const kite = new FakeKite();
  const { desk, alerts } = makeDesk(kite);
  const t = trade();
  await desk.onEntry(t, quote(30, 29.9, 30));
  let [p] = (await desk.status()).positions;
  // The exchange stop fires and fills on its own at 27.70.
  Object.assign(kite.book.get(p.stop.orderId), { status: "COMPLETE", filledQty: 250, averagePrice: 27.7 });
  clock += 15_000;
  await desk.tick();
  [p] = (await desk.status()).positions;
  check("a stop that fires at the exchange is noticed on the next pass",
        [p.state, p.stop.status, p.exit.fillPrice, Math.round(p.profit)], ["closed", "complete", 27.7, -575]);
  check("and reported", alerts.some(([, x]) => x.includes("stopped out at the exchange")), true);
  const before = kite.count("modify");
  await desk.onExit(t, quote(27.6, 27.5, 27.7), "stop");
  check("the paper stop arriving after it sends nothing", kite.count("modify"), before);
}

fresh("stop-fails");
{
  const kite = new FakeKite();
  kite.onPlace = (o) => (o.orderType === "SL" ? { refuse: "Trigger price out of range", kind: "InputException" } : {});
  const { desk, alerts } = makeDesk(kite, { quoteBid: 29.8, quoteLast: 29.85 });
  await desk.onEntry(trade(), quote(30, 29.9, 30));
  const [p] = (await desk.status()).positions;
  const sells = kite.calls.filter((c) => c[0] === "place" && c[1].transactionType === "SELL");
  check("a stop that cannot be placed is tried twice, then the position is exited",
        sells.map((c) => c[1].orderType), ["SL", "SL", "LIMIT"]);
  // The entry's own quote is seconds old, so its bid (29.90) prices the exit.
  check("out at the bid of the freshest quote", [p.state, p.exit.reason, p.exit.fillPrice], ["closed", "stop-failed", 29.9]);
  check("with a critical alert", alerts.some(([l, x]) => l === "critical" && x.includes("NO STOP")), true);
}

fresh("gap");
{
  const kite = new FakeKite();
  const { desk } = makeDesk(kite, { quoteBid: 25.0, quoteLast: 25.1 });
  const t = trade();
  await desk.onEntry(t, quote(30, 29.9, 30));
  // Price trades below the stop's limit (26.70) while the stop is still pending.
  kite.onModify = (row, change) => { if (change.orderType === "LIMIT") Object.assign(row, { status: "COMPLETE", filledQty: row.quantity, averagePrice: change.price }); };
  await desk.onQuote(t, quote(25.1, 25.0, 25.2));
  const [p] = (await desk.status()).positions;
  check("traded through the stop's limit: the watchdog exits at the bid",
        [p.state, p.exit.reason, p.exit.fillPrice], ["closed", "gap-past-limit", 25]);
}

fresh("retry");
{
  const kite = new FakeKite();
  const { desk } = makeDesk(kite, { quoteBid: 31.0, quoteLast: 31.1 });
  const t = trade();
  await desk.onEntry(t, quote(30, 29.9, 30));
  let fills = 0;
  kite.onModify = (row, change) => {
    // The first exit price does not fill; the second does.
    if (change.orderType === "LIMIT" || change.price != null) {
      if (fills++ >= 1) Object.assign(row, { status: "COMPLETE", filledQty: row.quantity, averagePrice: change.price });
      else row.status = "OPEN";
    }
  };
  await desk.onExit(t, quote(31.1, 31.0, 31.2), "eod-flatten");
  let [p] = (await desk.status()).positions;
  check("an exit that does not fill stays closing", [p.state, p.exit.attempts], ["closing", 1]);
  await desk.tick();
  [p] = (await desk.status()).positions;
  const prices = kite.calls.filter((c) => c[0] === "modify").map((c) => c[2].price).slice(-2);
  check("the next pass gives up 1% and fills", [p.state, prices], ["closed", [31, 30.65]]);
}

// ------------------------------------------------------------ caps, books, switches

fresh("cap");
{
  const kite = new FakeKite();
  const { desk } = makeDesk(kite, { maxOpen: 1 });
  await desk.onEntry(trade("ALPHA"), quote(30, 29.9, 30));
  await desk.onEntry(trade("BRAVO"), quote(30, 29.9, 30));
  check("max 1 open: the second signal stays paper only",
        kite.calls.filter((c) => c[0] === "place" && c[1].transactionType === "BUY").map((c) => c[1].tradingsymbol),
        ["ALPHA26NOV2900CE"]);
}

fresh("reconcile");
{
  process.env.LIVE_ALLOWED = "true";
  await mode.writeMode({ mode: "live", changedAt: clock, halted: null });
  const kite = new FakeKite();
  const { desk, alerts } = makeDesk(kite, { entriesOn: mode.liveEntriesOn, maxOpen: 3 });
  await desk.onEntry(trade("ALPHA"), quote(30, 29.9, 30));
  kite.netOverride = [{ tradingsymbol: "ALPHA26NOV2900CE", exchange: "NFO", product: "MIS", quantity: 500 }];
  clock += 120_000;
  const problems = await desk.reconcile();
  check("Zerodha holds 500, the desk expects 250: a mismatch",
        problems, ["ALPHA26NOV2900CE: Zerodha holds 500, desk expects 250"]);
  check("live entries are halted", [(await mode.readMode()).halted != null, await mode.liveEntriesOn()], [true, false]);
  check("and the phone is told", alerts.some(([l, x]) => l === "critical" && x.includes("HALTED")), true);
  await desk.onEntry(trade("BRAVO"), quote(30, 29.9, 30));
  check("no live entry while halted", kite.count("place", (c) => c[1].tradingsymbol === "BRAVO26NOV2900CE"), 0);
}

fresh("switch");
{
  const kite = new FakeKite();
  const { desk, alerts } = makeDesk(kite, { entriesOn: mode.liveEntriesOn });
  delete process.env.LIVE_ALLOWED;
  check("on is refused without LIVE_ALLOWED", (await desk.setMode("live", "LIVE")).ok, false);
  process.env.LIVE_ALLOWED = "true";
  check("on is refused without typing LIVE", (await desk.setMode("live", "yes")).ok, false);
  check("on, with both", (await desk.setMode("live", "LIVE")).ok, true);
  check("the switch is on disk", (await mode.readMode()).mode, "live");
  check("and announced", alerts.some(([, x]) => x.includes("switched ON")), true);
  await desk.onEntry(trade("ALPHA"), quote(30, 29.9, 30));
  check("off is refused while a live position is open", (await desk.setMode("paper")).ok, false);

  kite.onModify = (row, change) => { if (change.orderType === "LIMIT") Object.assign(row, { status: "COMPLETE", filledQty: row.quantity, averagePrice: change.price }); };
  const killed = await desk.kill();
  const state = await mode.readMode();
  const [p] = (await desk.status()).positions;
  check("kill: live orders off and halted", [state.mode, state.halted], ["paper", "kill switch"]);
  check("kill: the open position is exited by modifying its stop", [killed.exiting, p.state, p.exit.reason], [1, "closed", "kill"]);
  check("kill: critical alert", alerts.some(([l, x]) => l === "critical" && x.includes("KILL SWITCH")), true);
  check("after the kill, off is allowed again", (await desk.setMode("paper")).ok, true);
}

fresh("resume");
{
  const kite = new FakeKite();
  const first = makeDesk(kite, { maxOpen: 3 });
  await first.desk.onEntry(trade("ALPHA"), quote(30, 29.9, 30));
  // A restart: a new desk reads the same journal.
  const second = makeDesk(kite, { maxOpen: 3 });
  const [p] = (await second.desk.status()).positions;
  check("after a restart the open position and its stop are read back", [p.state, p.stop.status], ["open", "open"]);
  await second.desk.onEntry(trade("BRAVO"), quote(30, 29.9, 30));
  const tags = kite.calls.filter((c) => c[0] === "place").map((c) => c[1].tag);
  check("and tags keep counting, never reused", new Set(tags).size === tags.length && tags.at(-2).includes("E003"), true);
}

rmSync(runtime, { recursive: true, force: true });
console.log(`${passed} passed, ${failed.length} failed`);
for (const f of failed) console.log("  FAIL  " + f);
process.exit(failed.length ? 1 : 0);
