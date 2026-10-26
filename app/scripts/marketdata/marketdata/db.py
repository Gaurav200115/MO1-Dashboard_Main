"""PostgreSQL helpers: connect, create the tables, bulk insert, done markers, gaps, the call log."""
import datetime as dt

import psycopg

from .config import ROOT, need

SCHEMA = ROOT / "sql" / "schema.sql"


def connect():
    return psycopg.connect(need("DATABASE_URL"))


def init_schema(conn):
    conn.execute(SCHEMA.read_text(encoding="utf-8"))
    conn.commit()


def insert_rows(conn, table, columns, rows):
    """Bulk insert through COPY into a temp table, then INSERT ... ON CONFLICT DO NOTHING, so a
    re-run never duplicates and never fails on rows already stored. Returns rows added.
    Does not commit - the caller commits together with the done markers."""
    if not rows:
        return 0
    cols = ", ".join(columns)
    tmp = f"_load_{table}"
    conn.execute(f"CREATE TEMP TABLE IF NOT EXISTS {tmp} (LIKE {table} INCLUDING DEFAULTS) ON COMMIT DELETE ROWS")
    with conn.cursor() as cur:
        with cur.copy(f"COPY {tmp} ({cols}) FROM STDIN") as cp:
            for r in rows:
                cp.write_row(r)
        cur.execute(f"INSERT INTO {table} ({cols}) SELECT {cols} FROM {tmp} ON CONFLICT DO NOTHING")
        added = cur.rowcount
        cur.execute(f"DELETE FROM {tmp}")
    return added


def done_keys(conn, dataset, symbol=None):
    """{(symbol, series, d)} already finished for a dataset."""
    q = "SELECT symbol, series, d FROM done WHERE dataset = %s" + (" AND symbol = %s" if symbol else "")
    return {tuple(r) for r in conn.execute(q, (dataset, symbol) if symbol else (dataset,))}


def mark_done(conn, dataset, symbol, series, d, rows):
    conn.execute(
        "INSERT INTO done (dataset, symbol, series, d, rows) VALUES (%s, %s, %s, %s, %s) "
        "ON CONFLICT (dataset, symbol, series, d) DO UPDATE SET rows = EXCLUDED.rows, finished_at = now()",
        (dataset, symbol, series, d, rows))
    conn.execute("DELETE FROM gaps WHERE dataset = %s AND symbol = %s AND series = %s AND d = %s",
                 (dataset, symbol, series, d))


def add_gap(conn, dataset, symbol, series, d, reason):
    """Record a failed try; every further failure of the same piece adds one to `attempts`."""
    conn.execute(
        "INSERT INTO gaps (dataset, symbol, series, d, reason) VALUES (%s, %s, %s, %s, %s) "
        "ON CONFLICT (dataset, symbol, series, d) DO UPDATE SET reason = EXCLUDED.reason, logged_at = now(), "
        "attempts = gaps.attempts + 1", (dataset, symbol, series, d, reason[:300]))


def gaps(conn, dataset, retryable_only=False, max_attempts=None):
    """[(symbol, series, d, reason, attempts)] for a dataset; retryable_only drops the given-up ones."""
    q = "SELECT symbol, series, d, reason, attempts FROM gaps WHERE dataset = %s"
    args = [dataset]
    if retryable_only:
        q += " AND attempts < %s"
        args.append(max_attempts)
    return [tuple(r) for r in conn.execute(q + " ORDER BY d, symbol, series", args)]


def given_up(conn, dataset, max_attempts):
    """{(symbol, series, d)} that failed max_attempts times - no longer retried."""
    return {tuple(r) for r in conn.execute(
        "SELECT symbol, series, d FROM gaps WHERE dataset = %s AND attempts >= %s", (dataset, max_attempts))}


def log_call(conn, run_id, dataset, what, win, status, rows, seconds, workers=1, note=""):
    conn.execute(
        "INSERT INTO download_log (run_id, dataset, what, win, status, rows, seconds, workers, note) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (run_id, dataset, what, win, status, rows, round(seconds, 2), workers, note))


def calls_today(conn):
    """Dhan calls logged since midnight IST - for the 100,000-a-day limit."""
    return conn.execute(
        "SELECT count(*) FROM download_log WHERE dataset NOT IN ('fo_bhavcopy', 'cm_bhavcopy', "
        "'corporate_actions', 'fo_ban', 'stock_list') AND logged_at >= "
        "date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'").fetchone()[0]


def get_meta(conn, key):
    row = conn.execute("SELECT value FROM meta WHERE key = %s", (key,)).fetchone()
    return row[0] if row else None


def set_meta(conn, key, value):
    conn.execute("INSERT INTO meta (key, value) VALUES (%s, %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                 (key, str(value)))


def calendar(conn):
    return {d: t for d, t in conn.execute("SELECT d, trading_day FROM trading_calendar")}


def set_calendar(conn, d, trading):
    conn.execute("INSERT INTO trading_calendar (d, trading_day) VALUES (%s, %s) "
                 "ON CONFLICT (d) DO UPDATE SET trading_day = EXCLUDED.trading_day", (d, trading))


def compress_before(conn, table, before):
    """Compress every chunk of `table` that ends before `before` (a date or datetime).
    Chunks still being filled are left alone. Returns the number of chunks compressed."""
    if not isinstance(before, dt.datetime):
        before = dt.datetime.combine(before, dt.time(), tzinfo=dt.timezone.utc)
    chunks = conn.execute(
        "SELECT format('%%I.%%I', chunk_schema, chunk_name) FROM timescaledb_information.chunks "
        "WHERE hypertable_name = %s AND NOT is_compressed AND range_end <= %s", (table, before)).fetchall()
    for (chunk,) in chunks:
        conn.execute("SELECT compress_chunk(%s::regclass, if_not_compressed => true)", (chunk,))
    conn.commit()
    return len(chunks)
