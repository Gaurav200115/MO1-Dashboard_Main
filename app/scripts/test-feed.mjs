// The Kite price feed and the 09:00 sign-in reminder - the two things that kept
// the desk from trading on 17 Nov.
//
//   node scripts/test-feed.mjs        (from app/, which holds public/data/index.json)
//
// The feed runs against scripts/fakes/kiteconnect.cjs, which mimics the real
// library's two traps: one module-wide listener list, and a disconnect() that
// arms process.exit(1) for the next drop when auto-reconnect is on. Time runs
// on node's mock timers, so a session can expire without waiting three hours.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..", "src");
const runtime = mkdtempSync(path.join(tmpdir(), "mo1-feed-"));
process.env.KITE_RUNTIME_DIR = runtime;
process.env.KITE_API_KEY = "test-key";
process.env.KITE_API_SECRET = "test-secret";

const jiti = createJiti(import.meta.url, {
  alias: { "@": src, kiteconnect: path.join(here, "fakes", "kiteconnect.cjs") },
});
const { __fake: fake } = await jiti.import("kiteconnect");
const session = await jiti.import(path.join(src, "lib/kite/session.ts"));
const { getFeed } = await jiti.import(path.join(src, "lib/kite/feed.ts"));
const reminder = await jiti.import(path.join(src, "lib/notify/loginReminder.ts"));

let passed = 0;
const failed = [];
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) passed += 1;
  else failed.push(`${name}\n      got  ${g}\n      want ${w}`);
}

// Real I/O (the session file, the instrument cache) still has to finish after
// a fake-timer tick. setImmediate and performance.now are left real for this:
// spin until `until()` holds, or two real seconds pass.
async function settle(until = () => false) {
  const deadline = performance.now() + 2_000;
  do {
    await new Promise((resolve) => setImmediate(resolve));
  } while (!until() && performance.now() < deadline);
}

// ------------------------------------------------------------ the 09:00 reminder

const IST = (iso) => Date.parse(`${iso}+05:30`);
const H = 3_600_000;
check("Tue 08:00 IST -> 09:00 the same day", reminder.msUntilNextReminder(IST("2026-11-17T08:00:00")), 1 * H);
check("exactly 09:00:00.000 -> the next weekday, never twice", reminder.msUntilNextReminder(IST("2026-11-17T09:00:00")), 24 * H);
check("Fri 10:00 -> Mon 09:00, skipping the weekend", reminder.msUntilNextReminder(IST("2026-11-20T10:00:00")), 71 * H);
check("Sat 20:00 -> Mon 09:00", reminder.msUntilNextReminder(IST("2026-11-21T20:00:00")), 37 * H);
check("Sun 23:30 -> Mon 09:00", reminder.msUntilNextReminder(IST("2026-11-22T23:30:00")), 9.5 * H);
process.env.DESK_URL = "https://mo1-dashboard.tech/";
check("the link is DESK_URL + /api/kite/login", reminder.loginUrl(), "https://mo1-dashboard.tech/api/kite/login");
delete process.env.DESK_URL;
check("no DESK_URL, no link", reminder.loginUrl(), null);
const notIn = reminder.reminderText(false, "https://x/api/kite/login");
check("not signed in: says so, with the link",
      [notIn.includes("NOT connected"), notIn.includes("https://x/api/kite/login")], [true, true]);
check("signed in already: says nothing to do, still gives the link",
      reminder.reminderText(true, "https://x/api/kite/login").includes("already connected"), true);

// ------------------------------------------------------------ the feed

const start = Date.parse("2026-11-18T03:00:00Z"); // 08:30 IST
mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: start });

await session.writeSession({ accessToken: "token-1", userId: "XX0000", userName: null, mintedAt: start,
                             expiresAt: session.nextTokenExpiry(start) });
const feed = getFeed();

let state = await feed.ensureStarted();
check("started with a session: one socket, connecting", [state.status, fake.state.tickers.length], ["connecting", 1]);
check("the library's own reconnect is switched OFF", fake.state.autoReconnectCalls, [false]);
fake.emit("connect");
check("connected: live", feed.state().status, "live");

// The sign-in: a fresh token, and the old socket closed. This is what killed the desk.
await session.writeSession({ accessToken: "token-2", userId: "XX0000", userName: null, mintedAt: start,
                             expiresAt: session.nextTokenExpiry(start) });
state = await feed.restart();
check("sign-in: the old socket is closed and a new one opened",
      [fake.state.tickers[0].disconnected, fake.state.tickers.length, state.status], [true, 2, "connecting"]);
check("with the new token", fake.state.tickers[1].params.access_token, "token-2");
fake.emit("connect");
fake.emit("close"); // the old socket's close arrives late, and every listener hears it
await settle();
check("the old socket's close does not knock the new one over", feed.state().status, "live");
check("and nothing would have exited the process", fake.state.exits, 0);
mock.timers.tick(70_000);
await settle();
check("no reconnect was started by it", fake.state.tickers.length, 2);

// A real drop of the current socket: reconnect after 5s, by itself.
fake.emit("disconnect");
check("a drop: reconnecting in 5s", [feed.state().status, /5s/.test(feed.state().detail)], ["reconnecting", true]);
mock.timers.tick(5_000);
await settle();
check("5s later a new socket is opened", fake.state.tickers.length, 3);
fake.emit("connect");
check("and it is live again", feed.state().status, "live");
fake.emit("disconnect");
mock.timers.tick(5_000);
await settle();
fake.emit("disconnect"); // the retry fails too
check("a second failure in a row waits 10s", /10s/.test(feed.state().detail ?? ""), true);
mock.timers.tick(10_000);
await settle();
fake.emit("connect");
check("and recovers", feed.state().status, "live");
check("through every drop, still nothing that could exit the process",
      [fake.state.exits, fake.state.autoReconnectCalls.every((t) => t === false)], [0, true]);

// The token dies at 06:00 IST. The socket may stay up past it; the desk must not.
const sockets = fake.state.tickers.length;
mock.timers.tick(session.nextTokenExpiry(start) - Date.now() + 61_000);
await settle();
check("past 06:00 the feed says no-session - which is what shows Connect Kite",
      [feed.state().status, /06:00/.test(feed.state().detail ?? "")], ["no-session", true]);
check("and the stale socket is closed", fake.state.tickers.at(-1).disconnected, true);
mock.timers.tick(10 * 60_000);
await settle();
check("it does not keep retrying with a dead token", fake.state.tickers.length, sockets);

mock.timers.reset();
rmSync(runtime, { recursive: true, force: true });
console.log(`${passed} passed, ${failed.length} failed`);
for (const f of failed) console.log("  FAIL  " + f);
process.exit(failed.length ? 1 : 0);
