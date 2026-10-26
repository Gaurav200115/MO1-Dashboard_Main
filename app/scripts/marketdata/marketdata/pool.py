"""Parallel Dhan fetching with one database writer.

Workers only fetch; the main thread writes each answer and its done markers in one transaction,
so a crash never leaves a piece half-saved. A call Dhan cuts off (504) is split in half by
trading days, down to single days; a single day that still fails becomes a gap (retried on the
next pass, listed in the report).
"""
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait

from .config import IST, S

FIRST_BAR, LAST_BAR = 9 * 60 + 15, 15 * 60 + 29        # store 09:15-15:29 IST ("till 15:30")


def ist_minute(epoch):
    return int((epoch + 19800) % 86400 // 60)


def ist_day(epoch):
    import datetime as dt
    return dt.datetime.fromtimestamp(epoch, IST).date()


def in_session(epoch):
    return FIRST_BAR <= ist_minute(epoch) <= LAST_BAR


def windows(days, max_span):
    """Group sorted trading days into windows spanning at most max_span calendar days."""
    out, cur = [], []
    for d in sorted(days):
        if cur and (d - cur[0]).days + 1 > max_span:
            out.append(cur)
            cur = []
        cur.append(d)
    if cur:
        out.append(cur)
    return out


def fetch_split(dhan, path, make_payload, days):
    """Fetch `days` (sorted trading days) in one call, halving on a timeout.
    Returns [(days, status, body, seconds, error)] - one entry per call made."""
    single = len(days) == 1
    status, body, took, err = dhan.post(path, make_payload(days[0], days[-1]), retry_504=single)
    time.sleep(S.PAUSE_AFTER_CALL)
    if status in (None, 504) and not single:
        m = len(days) // 2
        return ([(days, status, None, took, "timed out - split")]
                + fetch_split(dhan, path, make_payload, days[:m])
                + fetch_split(dhan, path, make_payload, days[m:]))
    return [(days, status, body, took, err)]


def run(jobs, fetch, handle, workers, every=None, every_n=200, stop=None, tick=None, tick_seconds=60):
    """fetch(job) runs in a worker; handle(job, results) runs here, in the main thread.

    Jobs are handed out a few at a time rather than all queued up front (a year of options is
    ~200,000 jobs). `stop()` true -> no new job starts, the running ones finish and are saved.
    `every(pending_jobs)` runs after every `every_n` handled jobs (compression);
    `tick()` about every `tick_seconds` (progress). Returns the number of jobs handled."""
    done = 0
    it = iter(jobs)
    pool = ThreadPoolExecutor(max_workers=workers)
    pending = {}
    last_tick = time.monotonic()

    def top_up():
        while len(pending) < workers * 2 and not (stop and stop()):
            job = next(it, None)
            if job is None:
                return
            pending[pool.submit(fetch, job)] = job

    try:
        top_up()
        while pending:
            finished, _ = wait(pending, return_when=FIRST_COMPLETED)
            for f in finished:
                job = pending.pop(f)
                handle(job, f.result())          # re-raises a worker's TokenError / DailyLimit here
                done += 1
                if every and done % every_n == 0:
                    every(list(pending.values()))
            if tick and time.monotonic() - last_tick >= tick_seconds:
                tick()
                last_tick = time.monotonic()
            top_up()
    except BaseException:
        pool.shutdown(wait=True, cancel_futures=True)   # queued jobs never start; running ones finish
        raise
    pool.shutdown(wait=True)
    return done
