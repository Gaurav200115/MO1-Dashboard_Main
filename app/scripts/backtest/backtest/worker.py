"""The long-running worker: takes queued runs one at a time and replays them.

A separate service from the downloader on purpose. A three-month backtest should
not be able to delay the nightly download, and a download failure should not be
able to stop a backtest.

One run at a time, deliberately. The replay is PostgreSQL-bound and two of them
would mostly contend for the same pages; and a queue that is visibly one-deep is
easier to reason about from the dashboard than a pool.

    py -3.12 -m backtest.worker           # runs until stopped
    py -3.12 -m backtest.worker --once    # takes one run, then exits
"""
import argparse
import datetime as dt
import sys
import time
import traceback

from . import db as archive
from . import results
from .config import LOGS, S
from .runner import data_revision, fingerprint, run_range
from .strategies import SETUPS, check_against_registry, describe


def log(message):
    line = f"{dt.datetime.now():%Y-%m-%d %H:%M:%S}  {message}"
    print(line, flush=True)
    try:
        LOGS.mkdir(parents=True, exist_ok=True)
        with (LOGS / "worker.log").open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass          # a log that cannot be written is not a reason to stop a run


def _setups_of(strategy_ids):
    """Every leg of the named strategies - for a row queued before runs named setups."""
    return sorted(s for s, meta in SETUPS.items() if meta["strategy"] in strategy_ids)


def execute(run, conn, db):
    """Replays one claimed run and records the result."""
    run_id = run["_id"]
    start = dt.date.fromisoformat(run["from"])
    end = dt.date.fromisoformat(run["to"])
    # Older rows name strategies; a run is a set of setups now.
    setup_ids = run.get("setups") or _setups_of(run.get("strategyIds") or [])

    # A run queued from the dashboard carries no floors and no data revision -
    # the dashboard cannot see PostgreSQL, so it cannot know either. They are
    # filled in here and written back onto the run, which is also what makes
    # them visible next to the result rather than implicit in it.
    floors = run.get("gateFloors") or S.GATE_FLOORS
    _, payload = fingerprint(setup_ids, start, end, floors,
                             data_revision(conn, start, end))
    results.record_conditions(db, run_id, payload)

    log(f"run {run_id}: setups {describe(setup_ids)} from {start} to {end}")

    def on_progress(done, total, day):
        results.set_progress(db, run_id, done, total, day)

    positions, report = run_range(conn, setup_ids, start, end,
                                  floors, log=None, on_progress=on_progress)
    results.save_results(db, run_id, positions, report)

    summary = report["summary"]
    counts = report["gateCounts"]
    log(f"run {run_id}: done - {summary['trades']} trades, net {summary['net']:,.0f}, "
        f"{counts.get('clear', 0)} clear / {counts.get('approx', 0)} approx / "
        f"{counts.get('rejected', 0)} refused")


def publish_coverage(conn, db):
    """Refreshes the archive snapshot the dashboard shows beside the date pickers."""
    try:
        results.save_coverage(db, archive.archive_coverage(conn))
    except Exception as exc:                       # a snapshot is not worth failing over
        log(f"could not publish coverage: {exc}")


def poll_once(conn, db):
    """Claims and runs one queued run. Returns True if one was found."""
    run = results.claim_next(db)
    if run is None:
        return False
    try:
        execute(run, conn, db)
    except Exception as exc:                       # a bad run must not kill the worker
        log(f"run {run['_id']}: FAILED - {exc}")
        log(traceback.format_exc())
        results.fail_run(db, run["_id"], exc)
    return True


def main():
    parser = argparse.ArgumentParser(description="Backtest worker")
    parser.add_argument("--once", action="store_true",
                        help="take one queued run, then exit")
    args = parser.parse_args()

    # A run of a rule that is not the rule the desk trades is worse than no run
    # at all, because it looks like evidence. Checked before anything is claimed.
    drift = check_against_registry()
    if drift:
        log("refusing to start - the strategy mirror has drifted from registry.ts:")
        for line in drift:
            log("  " + line)
        return 1

    mongo = results.client()
    db = results.database(mongo)
    results.ensure_indexes(db)

    with archive.connect() as conn:
        publish_coverage(conn, db)

        if args.once:
            if not poll_once(conn, db):
                log("nothing queued")
            return 0

        log(f"worker started - polling every {S.POLL_SECONDS}s")
        idle = 0
        while True:
            try:
                if poll_once(conn, db):
                    publish_coverage(conn, db)     # a run may have been waiting on new data
                    idle = 0
                else:
                    idle += 1
                    # The archive only changes overnight, so once an hour is
                    # plenty and keeps the poll loop cheap.
                    if idle % max(1, 3600 // S.POLL_SECONDS) == 0:
                        publish_coverage(conn, db)
                    time.sleep(S.POLL_SECONDS)
            except KeyboardInterrupt:
                log("stopped")
                return 0
            except Exception as exc:
                log(f"worker error: {exc}")
                time.sleep(S.POLL_SECONDS)


if __name__ == "__main__":
    sys.exit(main())
