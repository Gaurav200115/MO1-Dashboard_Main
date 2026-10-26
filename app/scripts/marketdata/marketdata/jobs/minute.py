"""Dhan 1-minute bars: spot, live futures, options. Saved per symbol per day; only 09:15-15:29 IST."""
import datetime as dt
import time
from collections import Counter
from functools import partial

from .. import db, pool
from ..config import S
from ..context import say
from ..nse import paise

INTRADAY = "/charts/intraday"
ROLLING = "/charts/rollingoption"
SPOT_WINDOW = 85           # Dhan allows 90 days per intraday call
OPTION_FIELDS = ["open", "high", "low", "close", "iv", "volume", "strike", "oi", "spot"]   # oi/iv not stored
SIDE = {"CALL": ("ce", "CE"), "PUT": ("pe", "PE")}


def _arrays(body, key=None):
    data = (body or {}).get("data") if key else body
    block = (data or {}).get(key) if key else (data or {})
    return block if block and block.get("timestamp") else None


def _handle(ctx, dataset, symbol, series, job_days, results, rows_for_day, table, columns, workers):
    """Write one job's answers: rows + done markers per day in one transaction; gaps for failures."""
    conn = ctx.conn
    for days, status, body, took, err in results:
        saved = 0
        if status == 200:
            for d in days:
                rows = rows_for_day(body, d)
                if rows is None:                      # cannot be stored (e.g. no expiry) - a gap
                    db.add_gap(conn, dataset, symbol, series, d, "no expiry for this day in the F&O bhavcopy")
                    continue
                db.insert_rows(conn, table, columns, rows)
                db.mark_done(conn, dataset, symbol, series, d, len(rows))
                saved += len(rows)
        elif not (status in (None, 504) and len(days) > 1):   # a split's halves follow in `results`
            for d in days:
                db.add_gap(conn, dataset, symbol, series, d, f"HTTP {status} {err}")
        ctx.log(dataset, f"{symbol} {series}", f"{days[0]}..{days[-1]}", status, saved, took, workers, err)
    conn.commit()


def _todo(ctx, dataset, symbol, series, days=None):
    """Trading days still to fetch: not done, and not given up after MAX_ATTEMPTS failed tries."""
    done = ctx._done_cache.setdefault(dataset, db.done_keys(ctx.conn, dataset))
    gave_up = ctx._done_cache.setdefault(f"{dataset}:gave_up", db.given_up(ctx.conn, dataset, S.MAX_ATTEMPTS))
    return [d for d in (ctx.sessions if days is None else days)
            if (symbol, series, d) not in done and (symbol, series, d) not in gave_up]


def _bars_by_day(block):
    """{date: [(epoch, o, h, l, c, v, ...)]} for the minutes 09:15-15:29."""
    out = {}
    keys = [k for k in ("open", "high", "low", "close", "volume", "strike", "spot") if k in block]
    for i, ep in enumerate(block["timestamp"]):
        if pool.in_session(ep):
            out.setdefault(pool.ist_day(ep), []).append((ep, *[block[k][i] for k in keys]))
    return out, keys


def _ts(ep):
    return dt.datetime.fromtimestamp(ep, dt.timezone.utc)


# ---------------------------------------------------------------- spot

def spot_1min(ctx):
    ctx._done_cache = {}
    symbols = list(S.INDEX_SPOT) + [s for s in ctx.universe if s in ctx.security_id]
    jobs = []
    for sym in symbols:
        seg, inst = ("IDX_I", "INDEX") if sym in S.INDEX_SPOT else ("NSE_EQ", "EQUITY")
        for days in pool.windows(_todo(ctx, "spot_1min", sym, "1m"), SPOT_WINDOW):
            jobs.append((sym, seg, inst, ctx.security_id[sym], days))
    t0 = time.monotonic()

    def fetch(job):
        sym, seg, inst, sid, days = job
        def payload(a, b):           # from 09:00: a 09:15 start time drops the 09:15 bar (measured)
            return {"securityId": str(sid), "exchangeSegment": seg, "instrument": inst, "interval": S.INTERVAL,
                    "oi": False, "fromDate": f"{a} 09:00:00", "toDate": f"{b} 15:30:00"}
        return pool.fetch_split(ctx.dhan, INTRADAY, payload, days)

    def rows_for_day(sym, body, d):
        block = _arrays(body)
        if not block:
            return []
        by_day, keys = _bars_by_day(block)
        return [(_ts(ep), sym, paise(o), paise(h), paise(l), paise(c), int(v or 0))
                for ep, o, h, l, c, v, *_ in by_day.get(d, [])]

    def handle(job, results):
        sym = job[0]
        _handle(ctx, "spot_1min", sym, "1m", job[4], results, partial(rows_for_day, sym), "spot_1min",
                ["ts", "symbol", "open_paise", "high_paise", "low_paise", "close_paise", "volume"], S.WORKERS)

    pool.run(jobs, fetch, handle, S.WORKERS, stop=ctx.time_up, tick=ctx.tick)
    say(f"spot 1-minute: {len(symbols)} symbols, {len(jobs)} calls planned, {time.monotonic() - t0:.0f} s")


# ---------------------------------------------------------------- futures (live contracts only)

def live_futures(ctx):
    """[(underlying, Dhan ID, expiry)] for the live stock futures of this run's F&O stocks."""
    sm = ctx.instruments()
    fut = sm[(sm.SEM_EXM_EXCH_ID == "NSE") & (sm.SEM_INSTRUMENT_NAME == "FUTSTK")].copy()
    fut["underlying"] = fut.SEM_TRADING_SYMBOL.astype(str).str.rsplit("-", n=2).str[0]       # RELIANCE-Oct2026-FUT
    fut["expiry"] = fut.SEM_EXPIRY_DATE.astype(str).str[:10]
    return [(r.underlying, int(r.SEM_SMST_SECURITY_ID), dt.date.fromisoformat(r.expiry))
            for r in fut[fut.underlying.isin(ctx.fno)].itertuples(index=False)]


def futures_1min(ctx):
    """Dhan serves intraday bars only for futures that are still trading (expired: empty, measured);
    end-of-day for every contract is in fo_bhavcopy."""
    ctx._done_cache = {}
    jobs = []
    for sym, sid, expiry in live_futures(ctx):
        series = f"FUT:{expiry}"
        for days in pool.windows(_todo(ctx, "futures_1min", sym, series), SPOT_WINDOW):
            jobs.append((sym, sid, expiry, series, days))
    t0 = time.monotonic()

    def fetch(job):
        _, sid, _, _, days = job
        def payload(a, b):
            return {"securityId": str(sid), "exchangeSegment": "NSE_FNO", "instrument": "FUTSTK",
                    "interval": S.INTERVAL, "oi": False, "fromDate": f"{a} 09:00:00", "toDate": f"{b} 15:30:00"}
        return pool.fetch_split(ctx.dhan, INTRADAY, payload, days)

    def handle(job, results):
        sym, _, expiry, series, days = job

        def rows_for_day(body, d):
            block = _arrays(body)
            if not block:
                return []
            by_day, _ = _bars_by_day(block)
            return [(_ts(ep), sym, expiry, paise(o), paise(h), paise(l), paise(c), int(v or 0))
                    for ep, o, h, l, c, v, *_ in by_day.get(d, [])]
        _handle(ctx, "futures_1min", sym, series, days, results, rows_for_day, "futures_1min",
                ["ts", "symbol", "expiry_date", "open_paise", "high_paise", "low_paise", "close_paise", "volume"],
                S.WORKERS)

    pool.run(jobs, fetch, handle, S.WORKERS, stop=ctx.time_up, tick=ctx.tick)
    say(f"futures 1-minute: {len(jobs)} calls planned for live contracts, {time.monotonic() - t0:.0f} s")


# ---------------------------------------------------------------- options

def _offsets(n):
    return [f"ATM-{k}" for k in range(n, 0, -1)] + ["ATM"] + [f"ATM+{k}" for k in range(1, n + 1)]


def _offset_int(label):
    return 0 if label == "ATM" else int(label[3:])


def _option_payload(sid, offset, opt, a, b):
    return {"exchangeSegment": "NSE_FNO", "interval": S.INTERVAL, "securityId": sid, "instrument": "OPTSTK",
            "expiryFlag": S.EXPIRY_FLAG, "expiryCode": S.EXPIRY_CODE, "strike": offset, "drvOptionType": opt,
            "requiredData": OPTION_FIELDS, "fromDate": str(a), "toDate": str(b)}


def strike_band(ctx):
    """STRIKE_BAND if Dhan really serves it for stock options, else 3 (Dhan's documented limit).
    Decided once with two calls and remembered in the `meta` table."""
    want = S.STRIKE_BAND
    if want <= 3:                                     # within Dhan's documented limit - nothing to check
        return want
    key = f"strike_band:{S.EXPIRY_FLAG}{S.EXPIRY_CODE}:{want}"
    known = db.get_meta(ctx.conn, key)
    if known:
        return int(known)
    sym = sorted(ctx.fno)[0]
    d = ctx.end
    answers = {}
    for k in (3, want):
        status, body, took, err = ctx.dhan.post(ROLLING, _option_payload(ctx.security_id[sym], f"ATM+{k}", "CALL", d, d))
        ctx.log("options_1min", f"{sym} band check ATM+{k}", str(d), status, 0, took)
        block = _arrays(body, "ce") if status == 200 else None
        answers[k] = dict(zip(block["timestamp"], block["strike"])) if block else {}
    common = set(answers[3]) & set(answers[want])
    wider = sum(answers[want][t] > answers[3][t] for t in common)
    band = want if common and wider >= 0.9 * len(common) else 3
    db.set_meta(ctx.conn, key, band)
    ctx.conn.commit()
    say(f"strike band: Dhan {'serves' if band == want else 'does NOT serve'} ATM+-{want} for stock options "
        f"({wider}/{len(common)} minutes wider than ATM+3 on {sym}) -> using ATM+-{band}")
    return band


def options_1min(ctx):
    ctx._done_cache = {}
    band = strike_band(ctx)
    flag, code = S.EXPIRY_FLAG, S.EXPIRY_CODE

    # expiry of the series Dhan serves for each stock and day, from that day's F&O bhavcopy
    exp_rows = ctx.conn.execute(
        "SELECT symbol, trade_date, array_agg(DISTINCT expiry_date ORDER BY expiry_date) FROM fo_bhavcopy "
        "WHERE instrument = 'OPTSTK' AND symbol = ANY(%s) AND trade_date BETWEEN %s AND %s GROUP BY 1, 2",
        (sorted(ctx.option_days), ctx.start, ctx.end)).fetchall()
    expiry_of = {}
    for sym, d, exps in exp_rows:
        if flag == "MONTH":
            last = {}
            for e in exps:
                last[(e.year, e.month)] = e
            exps = sorted(last.values())
        later = [e for e in exps if e >= d]           # the expiring contract counts on its expiry day
        if len(later) >= code:
            expiry_of[(sym, d)] = later[code - 1]

    jobs = []                                         # only the months a stock was among the most liquid
    for sym, sym_days in sorted(ctx.option_days.items()):
        for offset in _offsets(band):
            for opt in S.OPTION_TYPES:
                series = f"{flag}{code}:{offset}:{opt}"
                for days in pool.windows(_todo(ctx, "options_1min", sym, series, sym_days), S.WINDOW_DAYS):
                    jobs.append((sym, offset, opt, series, days))
    jobs.sort(key=lambda j: (j[4][0], j[0]))          # oldest week first, so finished weeks can be compressed
    series_days = sum(len(j[4]) for j in jobs)
    say(f"options: {len(ctx.option_days)} stocks (the most liquid, month by month) x ATM+-{band} x "
        f"{'/'.join(S.OPTION_TYPES)} = {len(_offsets(band)) * len(S.OPTION_TYPES)} series each, "
        f"{len(jobs)} jobs planned, {series_days} series-days left, {S.WORKERS} in parallel")
    t0 = time.monotonic()
    starts = Counter(j[4][0] for j in jobs)
    handled = [0]                                     # series-days actually fetched (a pause stops early)

    def fetch(job):
        sym, offset, opt, _, days = job
        return pool.fetch_split(ctx.dhan, ROLLING, partial(_option_payload, ctx.security_id[sym], offset, opt), days)

    def handle(job, results):
        sym, offset, opt, series, days = job
        key, kind = SIDE[opt]
        off = _offset_int(offset)

        def rows_for_day(body, d):
            block = _arrays(body, key)
            if not block:
                return []
            expiry = expiry_of.get((sym, d))
            if expiry is None:
                return None
            by_day, keys = _bars_by_day(block)
            i = {k: n + 1 for n, k in enumerate(keys)}
            return [(_ts(b[0]), sym, expiry, paise(b[i["strike"]]), kind, off, paise(b[i["open"]]),
                     paise(b[i["high"]]), paise(b[i["low"]]), paise(b[i["close"]]), int(b[i["volume"]] or 0),
                     paise(b[i["spot"]])) for b in by_day.get(d, [])]
        _handle(ctx, "options_1min", sym, series, days, results, rows_for_day, "option_1min",
                ["ts", "symbol", "expiry_date", "strike_paise", "option_type", "strike_offset", "open_paise",
                 "high_paise", "low_paise", "close_paise", "volume", "spot_paise"], S.WORKERS)
        starts[days[0]] -= 1
        handled[0] += len(days)

    def compress_finished(_pending):
        open_starts = [d for d, n in starts.items() if n > 0]
        if open_starts:
            db.compress_before(ctx.conn, "option_1min", min(open_starts) - dt.timedelta(days=1))

    pool.run(jobs, fetch, handle, S.WORKERS, every=compress_finished, stop=ctx.time_up, tick=ctx.tick)
    took = time.monotonic() - t0
    if handled[0]:                                    # added up over the main pass and the retry pass
        prev = db.get_meta(ctx.conn, f"speed:{ctx.run_id}")
        p_secs, p_sd = (float(prev.split("/")[0][:-1]), int(prev.split("/")[1][:-2])) if prev else (0.0, 0)
        db.set_meta(ctx.conn, f"speed:{ctx.run_id}", f"{p_secs + took:.1f}s/{p_sd + handled[0]}sd/{S.WORKERS}w")
        ctx.conn.commit()
    say(f"options: {len(jobs)} jobs planned, {handled[0]} series-days fetched, {took / 60:.1f} min"
        + (f", {took / handled[0]:.2f} s per series-day" if handled[0] else ""))
