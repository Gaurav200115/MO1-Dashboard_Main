import { runEodScan } from "./job";

/**
 * The nightly EOD scan, at 21:00 IST.
 *
 * In-process rather than a Render Cron Job or an external caller, because the
 * desk now runs around the clock and a timer inside a process that never stops
 * is the whole of what a scheduler needs to be here. It also sidesteps the
 * problem an external cron would have: `/api/eod` sits behind the login
 * middleware and answers 401 to anything without a session, so a cron service
 * would need a shared secret carved through the door. Nothing has to be opened
 * up for this.
 *
 * Only the scan. Not the sector chain (its candles are not final at 21:00 — see
 * the note in sector/series.ts) and not the strategy engine, which has nothing
 * to arm against a closed market. Both of those still ride the morning sign-in.
 *
 * What the 21:00 run produces is deliberately *provisional*. Kite consolidates
 * its daily candle overnight to the closing-auction price, and on a measured
 * evening 154 of 163 closes were still moving — by a median 0.31%, which is the
 * width of the confluence band itself. So this run writes levels with
 * `verifiedAt: null`, and the first run after midnight (the morning sign-in)
 * re-reads the finalised candle and recomputes the pivots against the archived
 * option chain. The desk shows a Provisional badge until then.
 *
 * Failure is not worth handling specially. Every outcome this can have —
 * no Kite session because the token died at 06:00, a weekend where the last
 * settled session already has a report, a scan already done — is something
 * `runEodScan` returns rather than throws, and any of them is repaired by the
 * next morning's sign-in, which scans whatever is missing.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

/** 21:00 IST — five and a half hours after the close, well clear of settlement. */
export const SCAN_HOUR_IST = 21;
export const SCAN_MINUTE_IST = 0;

/** The configured time as "21:00", so log lines cannot drift from the constants. */
const SCAN_LABEL = `${String(SCAN_HOUR_IST).padStart(2, "0")}:${String(SCAN_MINUTE_IST).padStart(2, "0")}`;

/**
 * Milliseconds until the next 21:00 IST.
 *
 * Built by shifting into IST, reading the wall clock there, and shifting back,
 * which is the same trick istDateString uses. India has no daylight saving, so
 * a fixed offset is exact rather than an approximation.
 */
export function msUntilNextScan(now = Date.now()): number {
  const ist = new Date(now + IST_OFFSET_MS);

  const target = Date.UTC(
    ist.getUTCFullYear(),
    ist.getUTCMonth(),
    ist.getUTCDate(),
    SCAN_HOUR_IST,
    SCAN_MINUTE_IST,
    0,
    0
  );

  const utc = target - IST_OFFSET_MS;
  // Past it already today, so aim at tomorrow. Strictly greater rather than
  // greater-or-equal: a process that boots at exactly 21:00:00.000 should wait
  // a day, not fire instantly and then again in a second.
  return utc > now ? utc - now : utc + DAY_MS - now;
}

/** The next run as an IST wall-clock string, for the boot log. */
export function nextScanLabel(now = Date.now()): string {
  const at = now + msUntilNextScan(now);
  return `${new Date(at + IST_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ")} IST`;
}

const globalRef = globalThis as typeof globalThis & {
  __eodScheduleTimer?: NodeJS.Timeout | null;
};

/**
 * Arms the timer, and re-arms it from inside the fire.
 *
 * Chained timeouts rather than a 24-hour setInterval: an interval drifts, and
 * more importantly it measures from the last fire rather than from the clock,
 * so a slow scan would walk the run time later every night until it was no
 * longer an evening job at all. Recomputing the delay each time pins it to
 * 21:00 forever.
 *
 * Pinned to globalThis so Next's dev hot reload replaces the timer instead of
 * stacking a second one on every file save.
 */
export function startEodSchedule(): void {
  if (globalRef.__eodScheduleTimer) clearTimeout(globalRef.__eodScheduleTimer);

  const arm = () => {
    const delay = msUntilNextScan();

    const timer = setTimeout(() => {
      console.log(`[eod] nightly ${SCAN_LABEL} IST scan starting`);

      void runEodScan()
        .then((outcome) => {
          console.log(
            `[eod] nightly run: ${outcome.reason}${outcome.detail ? ` — ${outcome.detail}` : ""}`
          );
        })
        .catch((err: unknown) => {
          // runEodScan already swallows its own failures into an outcome, so
          // reaching here means something unexpected. Never let it kill the
          // chain — tomorrow's run has to happen regardless.
          console.warn("[eod] nightly run failed:", err instanceof Error ? err.message : err);
        })
        .finally(arm);
    }, delay);

    // The HTTP server is what keeps this process alive; this timer should not
    // be a reason on its own. Same treatment as the feed's own intervals.
    timer.unref();
    globalRef.__eodScheduleTimer = timer;

    // Logged on every arming, not just the first. Re-arming happens inside the
    // fire, so without this the only evidence that the chain survived a run
    // would be the run after it — a night later.
    console.log(`[eod] nightly scan armed — next at ${nextScanLabel()}`);
  };

  arm();
}
