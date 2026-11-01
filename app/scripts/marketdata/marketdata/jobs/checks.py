"""The run's report: completeness, correctness against NSE, gaps, speed, disk - and the estimate
for one year of every F&O stock. Written to logs/report_<run>.txt and printed."""
import statistics

from .. import db
from ..config import LOGS, S, window_hours
from ..context import say

TRADING_DAYS_PER_YEAR = 250


def _q(ctx, sql, args=()):
    return ctx.conn.execute(sql, args).fetchall()


def run(ctx):
    # The VPS has one CPU core: parallel query workers only add shared-memory use.
    ctx.conn.execute("SET max_parallel_workers_per_gather = 0")
    lines = []
    out = lines.append
    n = len(ctx.sessions)
    rng = (ctx.start, ctx.end)
    syms = sorted(ctx.universe)
    fno = sorted(ctx.fno)
    out(f"MARKET DATA BACKFILL REPORT - run {ctx.run_id}")
    out(f"profile {S.PROFILE}: {n} trading days {ctx.start} -> {ctx.end}, {len(syms)} stocks ({len(fno)} with F&O)")
    out("")

    out("NSE files (days saved / trading days):")
    for ds in ("fo_bhavcopy", "cm_bhavcopy", "corporate_actions", "fo_ban"):
        (k,), = _q(ctx, "SELECT count(*) FROM done WHERE dataset = %s AND d BETWEEN %s AND %s", (ds, *rng))
        gaps = db.gaps(ctx.conn, ds)
        out(f"   {ds:<18} {k}/{n}" + (f"   missing: {[str(g[2]) for g in gaps]}" if gaps else ""))
    (ca,), = _q(ctx, "SELECT count(*) FROM corporate_actions WHERE ex_date BETWEEN %s AND %s", rng)
    (other,), = _q(ctx, "SELECT count(*) FROM corporate_actions WHERE action_type = 'OTHER' AND ex_date BETWEEN %s AND %s", rng)
    out(f"   corporate actions with an ex-date in the window: {ca} ({other} unparsed as OTHER)")
    out("")

    out("Spot 1-minute (days with 375 bars / days saved):")
    for sym, days, full, low in _q(ctx, """
            SELECT symbol, count(*), count(*) FILTER (WHERE n = 375), min(n) FROM (
                SELECT symbol, (ts AT TIME ZONE 'Asia/Kolkata')::date AS d, count(*) AS n FROM spot_1min
                WHERE symbol = ANY(%s) AND ts >= %s AND ts < %s::date + 1 GROUP BY 1, 2) x GROUP BY 1 ORDER BY 1""",
            (list(S.INDEX_SPOT) + syms, *rng)):
        out(f"   {sym:<12} {full}/{days}" + (f"   fewest bars in a day: {low}" if full < days else ""))
    out("")

    out("Futures 1-minute, live contracts (days, bars a day):")
    for sym, exp, days, med in _q(ctx, """
            SELECT symbol, expiry_date, count(*), percentile_cont(0.5) WITHIN GROUP (ORDER BY n) FROM (
                SELECT symbol, expiry_date, (ts AT TIME ZONE 'Asia/Kolkata')::date AS d, count(*) AS n FROM futures_1min
                WHERE symbol = ANY(%s) AND ts >= %s AND ts < %s::date + 1 GROUP BY 1, 2, 3) x GROUP BY 1, 2 ORDER BY 1, 2""",
            (fno, *rng)):
        out(f"   {sym:<12} {exp}  {days} days, {int(med)} bars a day")
    out("")

    band = db.get_meta(ctx.conn, f"strike_band:{S.EXPIRY_FLAG}{S.EXPIRY_CODE}")
    band = int(band) if band else S.STRIKE_BAND
    series_n = (2 * band + 1) * len(S.OPTION_TYPES)
    out(f"Options 1-minute: {S.EXPIRY_FLAG}{S.EXPIRY_CODE}, ATM+-{band}, {'/'.join(S.OPTION_TYPES)} = {series_n} series a stock")
    complete = dict(_q(ctx, """
        SELECT symbol, count(*) FROM (SELECT symbol, d FROM done WHERE dataset = 'options_1min' AND symbol = ANY(%s)
            AND d BETWEEN %s AND %s AND series LIKE %s GROUP BY 1, 2 HAVING count(*) = %s) x GROUP BY 1""",
        (fno, *rng, f"{S.EXPIRY_FLAG}{S.EXPIRY_CODE}:%", series_n)))
    rows = dict(_q(ctx, "SELECT symbol, count(*) FROM option_1min WHERE symbol = ANY(%s) AND ts >= %s AND ts < %s::date + 1 "
                        "GROUP BY 1", (fno, *rng)))
    per_min = {(s, t): (lo, hi) for s, t, lo, hi in _q(ctx, """
        SELECT symbol, option_type, min(n), max(n) FROM (SELECT symbol, option_type, ts, count(*) AS n FROM option_1min
            WHERE symbol = ANY(%s) AND ts >= %s AND ts < %s::date + 1 GROUP BY 1, 2, 3) x GROUP BY 1, 2""", (fno, *rng))}
    opt_days = getattr(ctx, "option_days", {}) or {}
    out(f"   stocks chosen by liquidity: {len(opt_days)} across the range (top {S.OPTION_STOCKS} a month, "
        f"ATM OI at least {S.MIN_ATM_OI_LOTS} lots) - see table liquidity_rank")
    for sym in sorted(opt_days):
        ce, pe = per_min.get((sym, "CE"), (0, 0)), per_min.get((sym, "PE"), (0, 0))
        out(f"   {sym:<12} complete days {complete.get(sym, 0)}/{len(opt_days[sym])}, {rows.get(sym, 0):>9,} rows, strikes a minute "
            f"CE {ce[0]}-{ce[1]} PE {pe[0]}-{pe[1]} (expected {2 * band + 1})")
    check_from = ctx.sessions[-20:][0]                # a sample: a wrong expiry shows on any day
    (total, ok), = _q(ctx, """
        SELECT count(*), count(*) FILTER (WHERE o.open_paise = f.open_paise) FROM option_1min o
        JOIN fo_bhavcopy f ON f.symbol = o.symbol AND f.instrument = 'OPTSTK' AND f.expiry_date = o.expiry_date
         AND f.strike_paise = o.strike_paise AND f.option_type = o.option_type
         AND f.trade_date = (o.ts AT TIME ZONE 'Asia/Kolkata')::date
        WHERE o.symbol = ANY(%s) AND o.ts >= %s AND o.ts < %s::date + 1
          AND (o.ts AT TIME ZONE 'Asia/Kolkata')::time = '09:15'""", (fno, check_from, ctx.end))
    out(f"   expiry check, last {len(ctx.sessions[-20:])} trading days - 09:15 open equals NSE's official open: "
        f"{ok}/{total}")
    gaps = db.gaps(ctx.conn, "options_1min")
    out(f"   strikes Dhan failed on (after the retry pass): {len(gaps)}"
        + "".join(f"\n      {g[0]} {g[1]} {g[2]}: {g[3]}" for g in gaps[:20]))
    out("")

    calls = _q(ctx, "SELECT dataset, status, seconds FROM download_log WHERE run_id = %s", (ctx.run_id,))
    opt = [c for c in calls if c[0] == "options_1min"]
    speed = db.get_meta(ctx.conn, f"speed:{ctx.run_id}")
    out("Speed (this run):")
    out(f"   Dhan calls: {sum(c[0] in ('spot_1min', 'futures_1min', 'options_1min') for c in calls)} "
        f"| option calls {len(opt)}, timed out {sum(c[1] in (None, 504) for c in opt)}, "
        f"failed {sum(c[1] not in (None, 200, 504) for c in opt)}, "
        f"median {statistics.median([c[2] for c in opt]) if opt else 0:.1f} s")
    est = None
    if speed:
        secs, sd, w = speed.split("/")
        per_sd = float(secs[:-1]) / int(sd[:-2])
        calls_per_sd = len(opt) / int(sd[:-2])
        (fno_total,), = _q(ctx, "SELECT count(*) FROM stocks WHERE in_nifty200 AND has_fno")
        all_fno = min(S.OPTION_STOCKS, fno_total)
        year_sd = all_fno * series_n * TRADING_DAYS_PER_YEAR
        est = (per_sd * year_sd, calls_per_sd * year_sd, all_fno)
        out(f"   options: {per_sd:.2f} s per series-day with {w[:-1]} in parallel ({calls_per_sd:.2f} calls per series-day)")
    out("")

    out("Disk:")
    for t in ("option_1min", "spot_1min", "futures_1min", "fo_bhavcopy"):
        st = _q(ctx, "SELECT before_compression_total_bytes, after_compression_total_bytes FROM hypertable_compression_stats(%s)", (t,))
        (size,), = _q(ctx, "SELECT hypertable_size(%s)", (t,))
        b, a = (st[0] if st else (None, None))
        out(f"   {t:<14} {size / 1e6:8.1f} MB on disk" + (f"   (compressed {b / 1e6:.1f} -> {a / 1e6:.1f} MB, {b / a:.1f}x)" if b and a else ""))
    (dbsize,), = _q(ctx, "SELECT pg_database_size(current_database())")
    out(f"   whole database {dbsize / 1e6:.1f} MB")
    if est:
        secs, ncalls, all_fno = est
        (opt_size,), = _q(ctx, "SELECT hypertable_size('option_1min')")
        st = _q(ctx, "SELECT before_compression_total_bytes, after_compression_total_bytes "
                     "FROM hypertable_compression_stats('option_1min')")
        if st and st[0][0] and st[0][1]:          # the newest week is not compressed yet: project it
            b, a = st[0]
            opt_size = a + (opt_size - a) * a / b
        (sd_stored,), = _q(ctx, "SELECT count(*) FROM done WHERE dataset = 'options_1min'")
        out("")
        days = max(secs / 86400, ncalls / S.DAILY_CALL_LIMIT)     # the daily call limit can set the pace
        nights = secs / 3600 / window_hours()
        out(f"ONE YEAR, the {all_fno} most liquid F&O stocks each month, {series_n} series each, at this speed:")
        out(f"   ~{nights:.0f} nights of {window_hours():.0f} h ({S.RUN_WINDOW[0]}-{S.RUN_WINDOW[1]} IST)")
        out(f"   options ~{days:.1f} days ({secs / 3600:.0f} h of Dhan time; ~{ncalls:,.0f} calls, and Dhan allows "
            f"{S.DAILY_CALL_LIMIT:,} a day in this setup)")
        if sd_stored:
            out(f"   options disk ~{opt_size / sd_stored * all_fno * series_n * TRADING_DAYS_PER_YEAR / 1e9:.1f} GB "
                "(at this run's compression)")

    LOGS.mkdir(parents=True, exist_ok=True)
    path = LOGS / f"report_{ctx.run_id}.txt"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n" + "\n".join(lines), flush=True)
    say(f"report saved: {path}")
