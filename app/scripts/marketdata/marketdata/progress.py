"""Download progress for the MO1 dashboard: progress/progress.json (no secrets, world-readable)
and the same JSON in the Postgres table `progress`.

A "piece" is one finished unit of work in the `done` table: one NSE file-day, or one symbol x
series x trading day of minute bars. Progress = pieces done / pieces planned for this run's range.
"""
import datetime as dt
import json
import os
import time

from . import db
from .jobs import minute
from .config import IST, PROFILE, PROGRESS_DIR, S, window_bounds, window_hours

LABELS = {
    "fo_bhavcopy": "NSE F&O bhavcopy (end of day, every contract)",
    "cm_bhavcopy": "NSE cash-market bhavcopy",
    "corporate_actions": "Corporate actions",
    "fo_ban": "F&O ban list",
    "spot_1min": "Spot 1-minute",
    "vix_1min": f"India VIX 1-minute (last {S.VIX_YEARS} years)",
    "futures_1min": "Futures 1-minute (live contracts)",
    "options_1min": "Options 1-minute",
}


class Progress:
    def __init__(self, ctx):
        self.ctx = ctx
        self.plan = {}            # dataset -> (planned pieces, symbols, series LIKE pattern)
        self.state = "starting"
        self.message = ""
        self.started = dt.datetime.now(IST)
        self.opt_mark = None      # (monotonic time, options done) when options started this run
        self.band = None
        self.vix_from = None

    def set_plan(self, band, futures_contracts):
        ctx, n = self.ctx, len(self.ctx.sessions)
        self.band = band
        fno = sorted(ctx.fno)
        for name in ["fo_bhavcopy"] + [d for d in S.DATASETS if d in LABELS and d != "fo_bhavcopy"]:
            if name in ("fo_bhavcopy", "cm_bhavcopy", "corporate_actions", "fo_ban"):
                self.plan[name] = (n, ["*"], "%")
            elif name == "spot_1min":
                syms = list(S.INDEX_SPOT) + [s for s in ctx.universe if s in ctx.security_id]
                self.plan[name] = (len(syms) * n, syms, "1m")
            elif name == "vix_1min":
                days = minute.vix_days(ctx)
                self.vix_from = days[0]
                self.plan[name] = (len(days), [S.VIX], "1m")
            elif name == "futures_1min":
                self.plan[name] = (futures_contracts * n, fno, "FUT:%")
            elif name == "options_1min" and band:
                series = (2 * band + 1) * len(S.OPTION_TYPES)
                pieces = sum(len(days) for days in ctx.option_days.values()) * series
                self.plan[name] = (pieces, sorted(ctx.option_days), f"{S.EXPIRY_FLAG}{S.EXPIRY_CODE}:%")

    def _done(self, name, syms, pattern):
        conn = self.ctx.conn
        if name == "options_1min":                    # only the stock-months that were selected
            return conn.execute(
                "SELECT count(*) FROM done d JOIN liquidity_rank r ON r.symbol = d.symbol AND r.selected "
                "AND r.month = date_trunc('month', d.d)::date WHERE d.dataset = %s AND d.d BETWEEN %s AND %s "
                "AND d.series LIKE %s", (name, self.ctx.start, self.ctx.end, pattern)).fetchone()[0]
        start = self.vix_from if name == "vix_1min" else self.ctx.start      # VIX has its own range
        return conn.execute(
            "SELECT count(*) FROM done WHERE dataset = %s AND d BETWEEN %s AND %s AND symbol = ANY(%s) "
            "AND series LIKE %s", (name, start, self.ctx.end, syms, pattern)).fetchone()[0]

    def _secs_per_piece(self, opt_done):
        """Options speed: this run's if it has been going a few minutes, else earlier runs'."""
        if getattr(self.ctx, "current_job", None) == "options_1min":
            if self.opt_mark is None:
                self.opt_mark = (time.monotonic(), opt_done)
            t0, d0 = self.opt_mark
            if opt_done - d0 >= 50 and time.monotonic() - t0 > 120:
                return (time.monotonic() - t0) / (opt_done - d0)
        secs = pieces = 0.0
        for (value,) in self.ctx.conn.execute("SELECT value FROM meta WHERE key LIKE 'speed:%%'"):
            s, p, _ = value.split("/")
            secs, pieces = secs + float(s[:-1]), pieces + int(p[:-2])
        return secs / pieces if pieces else None

    def write(self, state=None, message=None):
        if state:
            self.state = state
        if message is not None:
            self.message = message
        ctx = self.ctx
        now = dt.datetime.now(IST)
        datasets, total_done, total_planned = [], 0, 0
        opt_left = None
        if ctx.sessions:
            for name, (planned, syms, pattern) in self.plan.items():
                done = min(self._done(name, syms, pattern), planned)
                datasets.append({"key": name, "label": LABELS[name], "done": done, "total": planned})
                total_done, total_planned = total_done + done, total_planned + planned
                if name == "options_1min":                # given-up pieces are not work still to do
                    gave_up = ctx.conn.execute("SELECT count(*) FROM gaps WHERE dataset = 'options_1min' "
                                               "AND attempts >= %s", (S.MAX_ATTEMPTS,)).fetchone()[0]
                    opt_left, opt_done = max(0, planned - done - gave_up), done
        eta = None
        if opt_left:
            spp = self._secs_per_piece(opt_done)
            if spp:
                hours = opt_left * spp / 3600
                eta = {"secondsPerPiece": round(spp, 2), "hoursLeft": round(hours, 1),
                       "nightsLeft": round(hours / window_hours(), 1)}
        start, end = window_bounds(now)
        next_start = start if now < start else window_bounds(end + dt.timedelta(minutes=1))[0]
        failed = [{"dataset": r[0], "symbol": r[1], "series": r[2], "day": str(r[3]), "attempts": r[4],
                   "reason": r[5], "status": "gave up" if r[4] >= S.MAX_ATTEMPTS else "retrying",
                   "lastTry": r[6].astimezone(IST).isoformat(timespec="minutes")}
                  for r in ctx.conn.execute(
                      "SELECT dataset, symbol, series, d, attempts, reason, logged_at FROM gaps "
                      "ORDER BY attempts DESC, d DESC LIMIT 100")]
        n_retrying, n_gave_up = ctx.conn.execute(
            "SELECT count(*) FILTER (WHERE attempts < %s), count(*) FILTER (WHERE attempts >= %s) FROM gaps",
            (S.MAX_ATTEMPTS, S.MAX_ATTEMPTS)).fetchone()
        data = {
            "updatedAt": now.isoformat(timespec="seconds"),
            "state": self.state,                       # starting running paused waiting complete stopped
            "message": self.message,
            "runId": ctx.run_id,
            "profile": S.PROFILE,
            "currentJob": getattr(ctx, "current_job", None),
            "range": {"from": str(ctx.start) if ctx.sessions else None,
                      "to": str(ctx.end) if ctx.sessions else None, "tradingDays": len(ctx.sessions)},
            "window": {"from": S.RUN_WINDOW[0], "to": S.RUN_WINDOW[1], "hours": window_hours(),
                       "endsAt": end.isoformat(timespec="seconds") if now >= start else None,
                       "nextStart": next_start.isoformat(timespec="seconds")},
            "stocks": len(ctx.universe), "fnoStocks": len(ctx.fno),
            "strikeBand": self.band,
            "overall": {"done": total_done, "total": total_planned},
            "datasets": datasets,
            "eta": eta,
            "failedPieces": n_retrying + n_gave_up,
            "failed": {"retrying": n_retrying, "gaveUp": n_gave_up, "maxAttempts": S.MAX_ATTEMPTS,
                       "items": failed},
            "optionStocks": {"perMonth": S.OPTION_STOCKS, "thisMonth": getattr(ctx, "option_stocks_now", None),
                             "acrossRange": len(getattr(ctx, "option_days", {}) or {}),
                             "minAtmOiLots": S.MIN_ATM_OI_LOTS},
            "dhanCallsToday": db.calls_today(ctx.conn) if ctx.conn else None,
            "tradingDaysTarget": PROFILE["trading_days"],
        }
        write_json(data)
        ctx.conn.execute("INSERT INTO progress (id, updated_at, data) VALUES (1, now(), %s) ON CONFLICT (id) "
                         "DO UPDATE SET updated_at = now(), data = EXCLUDED.data", (json.dumps(data),))
        ctx.conn.commit()
        return data


def write_json(data):
    PROGRESS_DIR.mkdir(parents=True, exist_ok=True)
    path = PROGRESS_DIR / "progress.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    if os.name == "posix":
        os.chmod(PROGRESS_DIR, 0o755)
        os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def write_waiting(message):
    """Outside the run window: update only the state, keep the last counts."""
    path = PROGRESS_DIR / "progress.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {"overall": {"done": 0, "total": 0}, "datasets": []}
    now = dt.datetime.now(IST)
    start, _ = window_bounds(now)
    data.update({"updatedAt": now.isoformat(timespec="seconds"), "state": "waiting", "message": message,
                 "window": {**data.get("window", {}), "from": S.RUN_WINDOW[0], "to": S.RUN_WINDOW[1],
                            "nextStart": start.isoformat(timespec="seconds"), "endsAt": None}})
    write_json(data)
