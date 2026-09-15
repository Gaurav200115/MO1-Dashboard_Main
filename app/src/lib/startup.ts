import { runEodScan } from "@/lib/eod/job";
import { startStrategies } from "@/lib/strategy/engine";

/**
 * The daily work chain: scan the settled session, then arm the strategies on
 * what it produced.
 *
 * Extracted out of instrumentation.ts because the boot hook is not a scheduler
 * anywhere the process outlives a day. Locally it looks like one — the server is
 * restarted every morning, so `register()` fires daily and the scan lands with
 * it. On a hosted box the process comes up once and stays up, `register()` never
 * runs again, and the desk would keep serving whichever session happened to be
 * settled on the day it was deployed.
 *
 * So the sign-in drives it instead. The Kite token dies at 06:00 IST and has to
 * be minted by hand every trading morning, which makes the callback the one
 * event guaranteed to happen once a day on a machine that never restarts.
 *
 * Both halves are safe to call repeatedly. `runEodScan` is single-flight and
 * idempotent on the settled session, so boot and a sign-in arriving together
 * share one scan rather than both spending ~6,000 quote calls on it, and a
 * second sign-in the same day does no work at all.
 */
export async function runDailyStartup(trigger: string): Promise<void> {
  const outcome = await runEodScan();

  if (outcome.reason === "no-session") {
    console.log(`[eod] skipped on ${trigger} — no Kite session. Sign in, then POST /api/eod.`);
  } else if (outcome.reason === "already-done") {
    console.log(`[eod] ${outcome.detail}`);
  }

  /*
   * Chained after the scan rather than started alongside it: the engine's whole
   * watchlist is derived from the report, so starting it first would only have
   * it find no levels and stop.
   */
  const snapshots = await startStrategies();
  for (const snapshot of snapshots) {
    console.log(
      `[strategy] ${snapshot.strategyId} v${snapshot.version}: ${snapshot.status}` +
        `${snapshot.detail ? ` — ${snapshot.detail}` : ""}`
    );
  }
}

/** Fire-and-forget wrapper — the scan runs for minutes and no caller may wait on it. */
export function kickDailyStartup(trigger: string): void {
  void runDailyStartup(trigger).catch((err: unknown) => {
    console.warn(
      `[startup] ${trigger} failed:`,
      err instanceof Error ? err.message : err
    );
  });
}
