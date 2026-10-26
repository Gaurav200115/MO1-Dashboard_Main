"""NSE daily files: F&O bhavcopy (also the trading calendar), CM bhavcopy, corporate actions,
F&O ban list. One file per trading day; a finished day is never fetched again."""
import datetime as dt
import time

from .. import db, nse
from ..config import PROFILE, S, end_date, today_ist
from ..context import say

PAUSE = 0.4     # seconds between NSE downloads


def fo_bhavcopy(ctx):
    """Walk back from END_DATE, downloading each day's F&O bhavcopy, until the profile's number of
    trading days is found - plus RANK_DAYS more when options are downloaded, so the first month can be
    ranked on the days before it. Weekends are tried too: NSE holds the odd weekend session. A missing
    file on a past day marks it a holiday."""
    conn, n = ctx.conn, PROFILE["trading_days"]
    rank = S.RANK_DAYS if "options_1min" in S.DATASETS else 0

    def enough(found):
        """n trading days for the range, then RANK_DAYS more before the first month of the range starts
        (the first month is often partial, and it is ranked on the days before the month)."""
        if len(found) < n:
            return False
        if not rank:
            return True
        month_start = found[n - 1].replace(day=1)          # `found` runs newest first
        return sum(1 for x in found if x < month_start) >= rank

    want = n + rank + 25                                    # bound for the walk below
    cal, done = db.calendar(conn), db.done_keys(conn, "fo_bhavcopy")
    s, sessions, d, end = nse.session(), [], end_date(), end_date()
    fetched = holidays = 0
    while not enough(sessions) and (end - d).days < 3 * want + 30:
        if cal.get(d) is True and ("*", "", d) in done:
            sessions.append(d)
        elif cal.get(d) is not False:
            content, took = nse.get(s, nse.fo_url(d))
            if content is None:
                if d < today_ist():
                    db.set_calendar(conn, d, False)
                    holidays += d.weekday() < 5
                ctx.log("fo_bhavcopy", "NSE F&O bhavcopy", str(d), 404, 0, took)
            else:
                rows = nse.fo_rows(content, d)
                db.insert_rows(conn, "fo_bhavcopy", nse.FO_COLUMNS, rows)
                db.set_calendar(conn, d, True)
                db.mark_done(conn, "fo_bhavcopy", "*", "", d, len(rows))
                ctx.log("fo_bhavcopy", "NSE F&O bhavcopy", str(d), 200, len(rows), took)
                sessions.append(d)
                fetched += 1
            conn.commit()
            time.sleep(PAUSE)
        d -= dt.timedelta(days=1)
    ctx.all_sessions = sorted(sessions)              # including the ranking days before the range
    ctx.sessions = ctx.all_sessions[-n:]
    say(f"F&O bhavcopy: {len(ctx.sessions)} trading days {ctx.start} -> {ctx.end}"
        + (f" (+{len(ctx.all_sessions) - len(ctx.sessions)} before it for the liquidity ranking)"
           if len(ctx.all_sessions) > len(ctx.sessions) else "")
        + f" | downloaded {fetched}, weekday holidays found {holidays}")


def _per_day(ctx, dataset, url_for, rows_for, table=None, columns=None, want_zip=True):
    conn = ctx.conn
    done = db.done_keys(conn, dataset)
    gave_up = db.given_up(conn, dataset, S.MAX_ATTEMPTS)
    s, fetched, missing = nse.session(), 0, []
    for d in ctx.sessions:
        if ("*", "", d) in done or ("*", "", d) in gave_up:
            continue
        if ctx.time_up():
            break
        content, took = nse.get(s, url_for(d), want_zip=want_zip)
        if content is None:
            db.add_gap(conn, dataset, "*", "", d, "NSE has no file for this trading day")
            ctx.log(dataset, dataset, str(d), 404, 0, took)
            missing.append(str(d))
        else:
            rows = rows_for(content, d)
            if table:
                db.insert_rows(conn, table, columns, rows)
            db.mark_done(conn, dataset, "*", "", d, len(rows))
            ctx.log(dataset, dataset, str(d), 200, len(rows), took)
            fetched += 1
        conn.commit()
        time.sleep(PAUSE)
    say(f"{dataset}: downloaded {fetched} day(s)" + (f", NSE had no file for {missing}" if missing else ""))


def cm_bhavcopy(ctx):
    _per_day(ctx, "cm_bhavcopy", nse.cm_url, nse.cm_rows, "cm_bhavcopy", nse.CM_COLUMNS)


CA_COLUMNS = ["symbol", "ex_date", "purpose_key", "series", "company", "record_date", "purpose_raw", "action_type",
              "ratio_from", "ratio_to", "dividend_amount", "first_seen"]


def corporate_actions(ctx):
    _per_day(ctx, "corporate_actions", nse.pr_url, nse.corporate_action_rows, "corporate_actions", CA_COLUMNS)
    # prices before the ex-date, then the adjust factor (multiply prices BEFORE ex_date by it).
    # Only once the trading day just before the ex-date has been downloaded - an action announced
    # ahead of the window waits, rather than taking an older close.
    conn = ctx.conn
    conn.execute("""
        UPDATE corporate_actions ca SET prev_close = (
            SELECT close_paise / 100.0 FROM cm_bhavcopy cm
            WHERE cm.symbol = ca.symbol AND cm.series = 'EQ' AND cm.trade_date = (
                SELECT max(d) FROM trading_calendar WHERE trading_day AND d < ca.ex_date))
        WHERE prev_close IS NULL
          AND ca.ex_date <= (SELECT max(d) FROM trading_calendar) + 1
          AND (SELECT max(d) FROM trading_calendar WHERE trading_day AND d < ca.ex_date)
              IN (SELECT trade_date FROM cm_bhavcopy WHERE symbol = ca.symbol)""")
    conn.execute("""
        UPDATE corporate_actions SET adjust_factor = round((
            CASE WHEN action_type IN ('SPLIT', 'FV_CHANGE') AND ratio_from > 0 THEN ratio_to / ratio_from
                 WHEN action_type = 'BONUS' AND ratio_from > 0 THEN ratio_to / (ratio_from + ratio_to)
                 ELSE 1 END)
          * (CASE WHEN dividend_amount IS NULL THEN 1
                  WHEN prev_close > 0 THEN (prev_close - dividend_amount) / prev_close END), 6)""")
    conn.commit()


def fo_ban(ctx):
    def rows(content, d):
        return [(d, sym) for sym in nse.ban_symbols(content)]
    _per_day(ctx, "fo_ban", nse.ban_url, rows, "fo_ban", ["trade_date", "symbol"], want_zip=False)
