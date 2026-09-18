import { runEodScan } from "@/lib/eod/job";
import { updateSectorHistory } from "@/lib/sector/job";
import { seedFromReports } from "@/lib/sector/seed";
import { readSeries } from "@/lib/sector/store";
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
   * After the scan rather than before it, so the year of daily candles the scan
   * just pulled is still in the six-hour history cache. Extending the chain then
   * costs only the Nifty 200 members that have no options — about fifteen calls
   * instead of two hundred.
   *
   * Never fatal: the chain is a research asset, and a day missed from it is
   * recovered by the next run, which rebuilds every session after the last one
   * stored.
   */
  try {
    const sectors = await updateSectorHistory();
    if (sectors.ran) {
      console.log(
        `[sectors] ${sectors.reason} — ${sectors.sessions} sessions to ${sectors.to}` +
          `${sectors.failed ? ` (${sectors.failed.length} symbols unread)` : ""}`
      );
    } else if (sectors.reason === "no-session") {
      /*
       * No token, so no candles — but the EOD reports on disk carry the same
       * closes for the F&O names, and a short provisional chain beats an index
       * that resets to 1,000 every morning. The next signed-in run replaces it.
       */
      const chain = await readSeries();
      if (!chain) {
        const seeded = await seedFromReports();
        console.log(
          seeded.ran
            ? `[sectors] no Kite session — seeded ${seeded.sessions} sessions from the EOD reports ` +
                `(${seeded.from} to ${seeded.to}), provisional until a backfill`
            : `[sectors] skipped on ${trigger} — ${sectors.detail}; seed unavailable (${seeded.detail})`
        );
      } else {
        console.log(`[sectors] skipped on ${trigger} — ${sectors.detail}`);
      }
    } else if (sectors.reason !== "up-to-date") {
      console.log(`[sectors] skipped on ${trigger} — ${sectors.detail ?? sectors.reason}`);
    }
  } catch (err) {
    console.warn("[sectors] update failed:", err instanceof Error ? err.message : err);
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
