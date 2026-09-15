/**
 * Stands in for a scheduler until this runs somewhere it can have one.
 *
 * Next calls `register()` once per server start and awaits it, so the scan is
 * deliberately not awaited here — it takes a couple of minutes and boot must not
 * wait on it. The job itself is idempotent on the settled session, so starting
 * the server repeatedly does the work at most once per session, and starting it
 * the next morning finds the previous evening's report already there.
 *
 * The runtime check has to *wrap* the import rather than guard-and-return above
 * it. Next builds this file for the edge compiler as well, where it replaces
 * NEXT_RUNTIME with a literal — so a positive check folds to `if (false)` and
 * webpack drops the branch. An early return leaves the import reachable, and the
 * edge build then fails on `node:fs/promises` and poisons the whole module graph
 * for every route that shares it.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { kickDailyStartup } = await import("@/lib/startup");
    const { checkConnection, describeStatus } = await import("@/lib/mongo");

    /*
     * Not awaited, and never fatal. Server selection burns the full 8s timeout
     * when the cluster is unreachable and boot must not sit on that — the desk
     * runs off the Kite feed and the reports on disk, so a dead archive is a
     * line in the log, not a reason to refuse to start. Firing it here also
     * warms the shared pool, so the first archive read does not pay for it.
     */
    void checkConnection().then((status) => {
      if (status.state === "down") console.warn(describeStatus(status));
      else console.log(describeStatus(status));
    });

    /*
     * Not awaited — the scan runs for minutes and boot must not sit on it.
     *
     * On a machine that is restarted every morning this is the trigger that
     * matters. On a hosted one it fires once in the deployment's life and the
     * Kite callback carries every day after it; see runDailyStartup.
     */
    kickDailyStartup("boot");
  }
}
