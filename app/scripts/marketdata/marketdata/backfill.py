"""Run the backfill inside the nightly window (settings.RUN_WINDOW, 16:00 -> 06:00 IST): every
dataset in settings.DATASETS, a retry pass for what failed, compression, then the report.
Started at 16:00 by the systemd timer; at 06:00 it stops cleanly and carries on the next evening.

    python -m marketdata.backfill
    MARKETDATA_IGNORE_WINDOW=1 python -m marketdata.backfill     # a manual run at any hour

Safe to stop and start at any time - finished work is skipped. Exit code 2 = the Dhan token
could not be renewed (systemd tries again after 5 minutes).
"""
import datetime as dt
import sys
import time

from . import db, progress
from .config import IGNORE_WINDOW, IST, PROFILE, S, in_window, window_bounds
from .context import Context, say
from .dhan import DailyLimit, TokenError
from .jobs import checks, liquidity, minute, nse_daily, stock_list

STEPS = {
    "cm_bhavcopy": nse_daily.cm_bhavcopy,
    "corporate_actions": nse_daily.corporate_actions,
    "fo_ban": nse_daily.fo_ban,
    "spot_1min": minute.spot_1min,
    "futures_1min": minute.futures_1min,
    "options_1min": minute.options_1min,
}
DHAN_STEPS = ("spot_1min", "futures_1min", "options_1min")
LOCK_ID = 73217        # only one backfill at a time (timer, service and a manual run cannot overlap)
MARGIN = dt.timedelta(minutes=3)   # stop taking new work this long before the window closes


class WindowClosed(Exception):
    pass


def _timed(name, fn, ctx):
    if ctx.time_up():
        raise WindowClosed()
    ctx.current_job = name
    t0 = time.monotonic()
    say(f"--- {name}")
    fn(ctx)
    say(f"    {name} done in {time.monotonic() - t0:.0f} s")
    if ctx.time_up():
        raise WindowClosed()


def _wait_for_next_day(ctx):
    """Dhan's daily call limit: wait for the next IST day, unless the window closes first."""
    now = dt.datetime.now(IST)
    resume = (now + dt.timedelta(days=1)).replace(hour=0, minute=5, second=0, microsecond=0)
    if ctx.deadline and resume >= ctx.deadline:
        raise WindowClosed()
    say(f"Dhan's daily call limit reached - waiting until {resume:%Y-%m-%d %H:%M} IST")
    ctx.progress.write("running", f"Dhan's daily call limit reached - resuming at {resume:%H:%M}")
    time.sleep((resume - now).total_seconds())


def _compress(conn):
    """Compress every finished week. The last 8 days stay uncompressed, because each night adds
    the newest day there."""
    for t in ("option_1min", "spot_1min", "futures_1min", "fo_bhavcopy"):
        db.compress_before(conn, t, dt.date.today() - dt.timedelta(days=8))


def main():
    now = dt.datetime.now(IST)
    if not IGNORE_WINDOW and not in_window(now):
        start, _ = window_bounds(now)
        say(f"outside the run window {S.RUN_WINDOW[0]}-{S.RUN_WINDOW[1]} IST - next start {start:%Y-%m-%d %H:%M}")
        progress.write_waiting(f"Runs {S.RUN_WINDOW[0]}-{S.RUN_WINDOW[1]} IST")
        return
    run_id = f"{S.PROFILE}-{now:%Y%m%d-%H%M%S}"
    conn = db.connect()
    db.init_schema(conn)
    if not conn.execute("SELECT pg_try_advisory_lock(%s)", (LOCK_ID,)).fetchone()[0]:
        say("another backfill is already running - exiting")
        return
    ctx = Context(conn, run_id)
    ctx.current_job = None
    if not IGNORE_WINDOW:
        ctx.deadline = window_bounds(now)[1] - MARGIN
    ctx.progress = progress.Progress(ctx)
    ctx.on_tick = lambda: ctx.progress.write()
    say(f"backfill {run_id}: profile {S.PROFILE} ({PROFILE['trading_days']} trading days), "
        f"datasets {', '.join(S.DATASETS)}"
        + (f", stops at {ctx.deadline + MARGIN:%Y-%m-%d %H:%M} IST" if ctx.deadline else ", no time limit"))
    ctx.progress.write("starting", "Reading the stock list and the trading calendar")
    try:
        _timed("stock_list", stock_list.run, ctx)          # always: decides this run's stocks
        _timed("fo_bhavcopy", nse_daily.fo_bhavcopy, ctx)  # always: decides this run's trading days
        ctx.option_days = {}
        if "options_1min" in S.DATASETS and ctx.fno:
            _timed("liquidity", liquidity.run, ctx)        # which stocks get options, month by month
        band = minute.strike_band(ctx) if ctx.option_days else None
        contracts = len(minute.live_futures(ctx)) if "futures_1min" in S.DATASETS else 0
        ctx.progress.set_plan(band, contracts)
        ctx.progress.write("running", "")
        while True:
            try:
                for name in S.DATASETS:
                    if name in STEPS:
                        _timed(name, STEPS[name], ctx)
                        ctx.progress.write()
                for name in DHAN_STEPS:                    # one retry pass for pieces Dhan failed on
                    left = db.gaps(conn, name, retryable_only=True, max_attempts=S.MAX_ATTEMPTS)
                    if name in S.DATASETS and left:
                        say(f"retrying {len(left)} failed {name} piece(s)")
                        _timed(f"{name}", STEPS[name], ctx)
                break
            except DailyLimit:
                _wait_for_next_day(ctx)
        ctx.current_job = "compressing"
        ctx.progress.write("running", "Compressing")
        _compress(conn)
        _timed("report", checks.run, ctx)
        ctx.current_job = None
        ctx.progress.write("complete", f"Everything up to {ctx.end} is downloaded")
    except WindowClosed:
        ctx.current_job = None
        say(f"run window closed at {S.RUN_WINDOW[1]} IST - stopping; it carries on at {S.RUN_WINDOW[0]}")
        _compress(conn)
        ctx.progress.write("paused", f"Paused at {S.RUN_WINDOW[1]} - carries on at {S.RUN_WINDOW[0]}")
    except TokenError as e:
        say(f"STOPPED - {e}")
        ctx.progress.write("stopped", f"Dhan login failed: {e}")
        sys.exit(2)
    except Exception as e:
        try:
            conn.rollback()
            ctx.progress.write("stopped", f"Stopped by an error: {type(e).__name__}: {e}"[:300])
        except Exception:
            pass
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
