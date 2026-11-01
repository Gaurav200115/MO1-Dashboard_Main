"""Backtest command line. Run from app/scripts/backtest (or /opt/backtest on the VPS).

    py -3.12 run.py check                         the mirror, and both databases
    py -3.12 run.py coverage                      what the archive actually holds
    py -3.12 run.py levels   --day 2026-10-15     the overnight levels for one session
    py -3.12 run.py session  --day 2026-10-15     replay one session, print the trades
    py -3.12 run.py now      --from A --to B      replay a range here and now
    py -3.12 run.py queue    --from A --to B      hand it to the worker

Every command that replays takes --setups, defaulting to all of them:

    --setups A        the long break-and-retrace, on its own
    --setups B        the long support-hold-and-cross, on its own
    --setups C        the short, on its own
    --setups A B C    all three, sharing the desk's three-position cap
    --setups ORB      the NIFTY 15-minute opening range - backtest only, never
                      live, and always in a run of its own

`levels` and `session` print and store nothing. `now` and `queue` write to Mongo.
"""
import argparse
import datetime as dt
import sys

from backtest import db as archive
from backtest.config import S
from backtest.levels import chain_window, plan_for_stock
from backtest.runner import data_revision, fingerprint, replay_session, run_range
from backtest.strategies import (ALL_SETUPS, SETUPS, STRATEGIES, check_against_registry,
                                 describe, selection)

# Every leg the desk runs, by default. Narrow it with --setups to find out which
# leg is carrying the result. Standalone rules (ORB) are only ever asked for.
DEFAULT_SETUPS = [s for s, meta in SETUPS.items()
                  if not STRATEGIES[meta["strategy"]].get("standalone")]


def _results():
    """Imported on use, not at the top.

    `check`, `coverage`, `levels` and `session` touch nothing but PostgreSQL, and
    there is no reason they should refuse to run on a machine that has no Mongo
    driver installed. Only the commands that store a run need it.
    """
    from backtest import results
    return results


def _date(text):
    return dt.date.fromisoformat(text)


def _money(value):
    return f"{'-' if value < 0 else '+'}Rs {abs(round(value)):,}"


# ---------------- check ----------------

def cmd_check(args):
    drift = check_against_registry()
    if drift:
        print("the strategy mirror has DRIFTED from registry.ts:")
        for line in drift:
            print("  " + line)
    else:
        print("strategy mirror matches registry.ts")

    try:
        with archive.connect() as conn:
            row = conn.execute("SELECT count(*) FROM trading_calendar WHERE trading_day").fetchone()
        print(f"PostgreSQL ok - {row[0]:,} trading days in the calendar")
    except Exception as exc:
        print(f"PostgreSQL FAILED - {type(exc).__name__}")
        return 1

    try:
        results = _results()
        mongo = results.client()
        db = results.database(mongo)
        print(f"MongoDB ok - {db[results.RUNS].count_documents({}):,} runs stored")
    except Exception as exc:
        print(f"MongoDB FAILED - {type(exc).__name__}")
        return 1
    return 1 if drift else 0


# ---------------- coverage ----------------

def cmd_coverage(args):
    """What the archive holds. This is what decides which ranges are worth offering."""
    with archive.connect() as conn:
        print("OPTIONS (option_1min) - the binding constraint\n")
        row = conn.execute(
            "SELECT count(DISTINCT symbol), min(ts)::date, max(ts)::date, count(*) "
            "FROM option_1min WHERE symbol <> ALL(%s)", (archive.INDEX_SYMBOLS,)).fetchone()
        if not row or not row[0]:
            print("  EMPTY - no option minute data at all. Nothing is backtestable yet.")
        else:
            stocks, first, last, rows = row
            print(f"  {stocks} stocks, {first} to {last}, {rows:,} rows")

        print("\n  complete stock-days by month (all 14 series downloaded):")
        for month, days, symbols in conn.execute(
                "SELECT date_trunc('month', d)::date AS m, count(*) AS stock_days, "
                "       count(DISTINCT symbol) AS symbols FROM ("
                "  SELECT symbol, d FROM done WHERE dataset = 'options_1min' "
                "  GROUP BY symbol, d HAVING count(*) >= %s) x "
                "GROUP BY m ORDER BY m", (archive.OPTION_SERIES_PER_DAY,)):
            print(f"    {month:%Y-%m}   {days:>6,} stock-days   {symbols:>3} stocks")

        print("\nNIFTY OPTIONS (index_options_1min) - for the opening-range rule\n")
        row = conn.execute(
            "SELECT min(d), max(d), count(*) FROM ("
            "  SELECT d FROM done WHERE dataset = %s GROUP BY d HAVING count(*) >= %s) x",
            (archive.INDEX_DATASET, archive.INDEX_SERIES_PER_DAY)).fetchone()
        if not row or not row[2]:
            print("  none yet - add index_options_1min to the downloader's DATASETS")
        else:
            print(f"  {row[2]} complete days, {row[0]} to {row[1]}")

        print("\nSPOT (spot_1min)\n")
        row = conn.execute(
            "SELECT count(DISTINCT symbol), min(ts)::date, max(ts)::date FROM spot_1min").fetchone()
        if row and row[0]:
            print(f"  {row[0]} symbols, {row[1]} to {row[2]}")

        print("\nNSE FILES\n")
        for table in ("cm_bhavcopy", "fo_bhavcopy"):
            row = conn.execute(
                f"SELECT min(trade_date), max(trade_date), count(*) FROM {table}").fetchone()
            if row and row[2]:
                print(f"  {table:<14} {row[0]} to {row[1]}, {row[2]:,} rows")

        print("\nMONTHLY OPTION UNIVERSE (liquidity_rank)\n")
        for month, n in conn.execute(
                "SELECT month, count(*) FROM liquidity_rank WHERE selected "
                "GROUP BY month ORDER BY month"):
            print(f"  {month:%Y-%m}   {n} stocks")

        print("\nOUTSTANDING GAPS\n")
        rows = list(conn.execute(
            "SELECT dataset, count(*), max(attempts) FROM gaps GROUP BY dataset ORDER BY 2 DESC"))
        if not rows:
            print("  none")
        for dataset, n, attempts in rows:
            print(f"  {dataset:<16} {n:>6,} pieces   up to {attempts} attempts")
    return 0


# ---------------- levels ----------------

def cmd_levels(args):
    strategy = STRATEGIES[args.strategy]
    with archive.connect() as conn:
        day = args.day
        prev = archive.previous_trading_day(conn, day)
        if prev is None:
            print(f"no trading day before {day}")
            return 1
        universe = [args.symbol] if args.symbol else archive.option_universe(conn, day)
        meta = archive.lot_sizes(conn, universe)
        factors = archive.adjust_factors(conn, universe, prev, day)
        ohlc = archive.session_ohlc(conn, prev, universe)

        print(f"levels for {day}, built from {prev}\n")
        header = f"{'symbol':<14}{'close':>10}{'major resistance':>28}{'major support':>28}"
        print(header)
        print("-" * len(header))

        found = 0
        for symbol in sorted(ohlc):
            info = meta.get(symbol)
            if not info or not info.get("lot_size"):
                continue
            factor = factors.get(symbol, 1.0)
            high, low, close = (v * factor for v in ohlc[symbol])
            expiry = archive.levels_expiry(conn, prev, symbol)
            if expiry is None:
                continue
            chain = chain_window(archive.option_chain(conn, prev, symbol, expiry), close)
            plan = plan_for_stock(symbol, (high, low, close), chain,
                                  info["lot_size"], info.get("strike_step"),
                                  strategy["params"])
            if plan is None:
                continue
            found += 1

            def show(level):
                if level is None:
                    return "-"
                skew = level.skew()
                return (f"{level.pivot} {level.pivot_value:.2f} @{level.strike:g} "
                        f"{'inf' if skew == float('inf') else f'{skew:.1f}'}x")

            print(f"{symbol:<14}{close:>10.2f}{show(plan.major_resistance):>28}"
                  f"{show(plan.major_support):>28}")
            if args.verbose:
                for level in plan.marked:
                    print(f"{'':<14}  {level.pivot:<3} {level.pivot_value:>9.2f} "
                          f"strike {level.strike:<9g} gap {level.gap_pct:.3f}%  "
                          f"{level.kind}")
        print(f"\n{found} stocks have a tradeable plan")
    return 0


# ---------------- one session ----------------

def cmd_session(args):
    strategy_ids, chosen = selection(args.setups)
    strategies = [STRATEGIES[s] for s in strategy_ids]
    with archive.connect() as conn:
        positions, notes = replay_session(conn, args.day, strategies, S.GATE_FLOORS,
                                          setups=chosen)

    print(f"{args.day}: setups {describe(args.setups)} - {notes['symbols']} stocks watched, "
          f"{notes['signals']} signals, {len(positions)} trades\n")
    if notes["bySetup"]:
        print("signals by setup: " +
              ", ".join(f"{k} x{v}" for k, v in sorted(notes["bySetup"].items())))
    if notes["rejected"]:
        print("refused: " + ", ".join(f"{k} x{v}" for k, v in sorted(notes["rejected"].items())))
    if notes["skipped"]:
        print("skipped: " + ", ".join(f"{k} x{v}" for k, v in sorted(notes["skipped"].items())))
    if not positions:
        return 0

    header = (f"{'symbol':<12}{'setup':<6}{'pivot':<6}{'strike':>9}{'in':>7}{'entry':>9}"
              f"{'out':>7}{'exit':>9}  {'reason':<13}{'gate':<8}{'profit':>10}")
    print("\n" + header)
    print("-" * len(header))
    for p in sorted(positions, key=lambda x: x.entry_at):
        entered = p.entry_at.strftime("%H:%M")
        left = p.exit_at.strftime("%H:%M") if p.exit_at else "-"
        print(f"{p.symbol:<12}{p.setup:<6}{p.context['pivot']:<6}{p.strike:>9g}"
              f"{entered:>7}{p.entry:>9.2f}{left:>7}{p.exit_price:>9.2f}  "
              f"{p.exit_reason:<13}{p.gate:<8}{_money(p.profit):>10}")
    net = sum(p.profit for p in positions)
    print(f"\nnet {_money(net)}")
    return 0


# ---------------- a range ----------------

def _prepare(conn, args):
    revision = data_revision(conn, args.start, args.end, args.setups)
    run_id, payload = fingerprint(args.setups, args.start, args.end,
                                  S.GATE_FLOORS, revision)
    return run_id, payload


def cmd_queue(args):
    with archive.connect() as conn:
        run_id, payload = _prepare(conn, args)
    results = _results()
    mongo = results.client()
    db = results.database(mongo)
    results.ensure_indexes(db)

    existing = results.find_run(db, run_id)
    if existing and existing.get("status") == "done":
        print(f"already run: {run_id}\n  {existing['trades']} trades, "
              f"net {_money(existing['summary']['net'])}")
        return 0
    if existing and existing.get("status") in ("queued", "running"):
        print(f"already {existing['status']}: {run_id}")
        return 0

    results.queue_run(db, run_id, payload, args.setups, args.start, args.end)
    print(f"queued {run_id} - {args.start} to {args.end}")
    return 0


def cmd_now(args):
    with archive.connect() as conn:
        run_id, payload = _prepare(conn, args)
        results = _results()
        mongo = results.client()
        db = results.database(mongo)
        results.ensure_indexes(db)

        existing = results.find_run(db, run_id)
        if existing and existing.get("status") == "done" and not args.force:
            print(f"already run: {run_id}\n  {existing['trades']} trades, "
                  f"net {_money(existing['summary']['net'])}\n"
                  f"  pass --force to replay it anyway")
            return 0

        results.queue_run(db, run_id, payload, args.setups, args.start, args.end)
        results.record_conditions(db, run_id, payload)
        if results.claim_run(db, run_id, force=args.force) is None:
            print(f"{run_id} is already running elsewhere - not starting a second copy")
            return 1

        def progress(done, total, day):
            print(f"  {done}/{total}  {day}", end="\r", flush=True)
            results.set_progress(db, run_id, done, total, day)

        positions, report = run_range(conn, args.setups, args.start, args.end,
                                      S.GATE_FLOORS, on_progress=progress)
        results.save_results(db, run_id, positions, report)

    print(" " * 40, end="\r")
    s = report["summary"]
    print(f"\nrun {run_id}")
    print(f"  {report['sessions']} sessions, {report['signals']} signals, {s['trades']} trades")
    win_rate = "-" if s["winRate"] is None else f"{s['winRate'] * 100:.0f}%"
    profit_factor = "-" if s["profitFactor"] is None else f"{s['profitFactor']:.2f}"
    print(f"  net {_money(s['net'])}   win rate {win_rate}   "
          f"PF {profit_factor}   max DD {_money(s['maxDrawdown'])}")
    if len(report["bySetup"]) > 1:
        print("\n  by setup:")
        for setup, st in report["bySetup"].items():
            pf = "-" if st["profitFactor"] is None else format(st["profitFactor"], ".2f")
            print(f"    {setup} {SETUPS[setup]['side']:<6} {st['signals']:>4} signals  "
                  f"{st['trades']:>4} trades  net {_money(st['net']):>13}  PF {pf}")
    ex = report["summaryExApprox"]
    print(f"  excluding approx-gated trades: {ex['trades']} trades, net {_money(ex['net'])}")
    print(f"  gate: {report['gateCounts']}")
    if report["rejected"]:
        print(f"  refused: {report['rejected']}")
    if report["skipped"]:
        print(f"  skipped: {report['skipped']}")
    if report["incompleteStockDays"]:
        print(f"  stock-days with incomplete option data: {report['incompleteStockDays']}")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("check").set_defaults(fn=cmd_check)
    sub.add_parser("coverage").set_defaults(fn=cmd_coverage)

    p = sub.add_parser("levels")
    p.add_argument("--day", type=_date, required=True)
    p.add_argument("--symbol")
    p.add_argument("--strategy", default="breakout-retrace-21ema")
    p.add_argument("--verbose", action="store_true")
    p.set_defaults(fn=cmd_levels)

    p = sub.add_parser("session")
    p.add_argument("--day", type=_date, required=True)
    p.add_argument("--setups", nargs="+", default=DEFAULT_SETUPS, choices=ALL_SETUPS)
    p.set_defaults(fn=cmd_session)

    for name, fn in (("queue", cmd_queue), ("now", cmd_now)):
        p = sub.add_parser(name)
        p.add_argument("--from", dest="start", type=_date, required=True)
        p.add_argument("--to", dest="end", type=_date, required=True)
        p.add_argument("--setups", nargs="+", default=DEFAULT_SETUPS, choices=ALL_SETUPS)
        if name == "now":
            p.add_argument("--force", action="store_true")
        p.set_defaults(fn=fn)

    args = parser.parse_args()
    if getattr(args, "start", None) and args.start > args.end:
        parser.error("--from is after --to")
    if getattr(args, "start", None) and (args.end - args.start).days > S.MAX_RANGE_DAYS:
        parser.error(f"range longer than {S.MAX_RANGE_DAYS} days")
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
