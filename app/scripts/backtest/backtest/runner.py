"""One run: replay a date range, session by session, and collect the trades.

The shape of a session mirrors the live desk's day. The overnight scan builds
each stock's levels from the previous session. The morning seeds a 21 EMA from
the last 84 settled 5-minute bars. Then the session runs forward one minute at a
time, and on every minute the open book is managed *before* new signals are
considered - because the desk's three-position cap is shared across every
running strategy, and a signal at 11:04 can only be taken if something has
closed by 11:04.

Two deliberate departures from DATA/BACKTEST-PLAN.md, both to avoid look-ahead:

  - The gate's open-interest and contracts-traded figures are read from the
    **previous** session's F&O bhavcopy, not the session being traded. The live
    gate takes them from the overnight scan, which is the previous session; and
    a day's own end-of-day numbers are not knowable at 10am. Reading them would
    let the replay dodge contracts that turned out to be thin that day, which
    the live desk could not do.
  - A run names a *set* of strategies rather than one. The three-position cap is
    desk-wide, so replaying the long rule alone and giving it all three slots
    reports a rule that had more room than it really had. Running both together
    is what the desk did.
"""
import hashlib
import json
import math
from collections import defaultdict

from . import db
from .config import S, ist_time
from .fills import step_position
from .gate import CLEAR, assess, fill_price
from .levels import chain_window, plan_for_stock
from .position import open_position
from .signals import Ema, evaluate_symbol, initial_state
from .strategies import SETUPS, STRATEGIES, option_type, selection

# bars.ts: the seed takes the last emaPeriod * 4 settled bars.
SEED_BAR_MULTIPLE = 4


def bucket_start(at, interval_minutes):
    """bars.ts bucketStart. IST is a whole number of 5-minute steps off UTC, so
    5-minute buckets land on :00, :05, :10 in IST as well."""
    minutes = at.hour * 60 + at.minute
    floored = (minutes // interval_minutes) * interval_minutes
    return at.replace(hour=floored // 60, minute=floored % 60, second=0, microsecond=0)


def fold_bars(bars, interval_minutes):
    """1-minute bars into closed interval bars. Returns [(bucket_start, close)].

    A bucket that saw no trades is not a bar - Kite omits those and so does
    this, for the same reason: an illiquid stock that stops ticking would
    otherwise hold its bar open and freeze its EMA.
    """
    out = []
    current, close = None, None
    for bar in bars:
        start = bucket_start(bar["at"], interval_minutes)
        if current is not None and start != current:
            out.append((current, close))
        current, close = start, bar["close"]
    if current is not None:
        out.append((current, close))
    return out


class SymbolClock:
    """One stock's 5-minute bars and EMA for one session.

    Seeded from previous sessions, then advanced by the day's own minutes. The
    EMA handed to the rule is always the one from the last *closed* bar -
    folding a bar that is still forming would put a provisional value into the
    EMA that the next minute silently changes.
    """

    def __init__(self, period, interval_minutes, seed_closes):
        self.interval = interval_minutes
        self.ema = Ema(period)
        self.ema.seed_from(seed_closes)
        self.last_bar_close = seed_closes[-1] if seed_closes else None
        self._bucket = None
        self._close = None

    @property
    def value(self):
        return self.ema.value

    def push_minute(self, bar):
        """Advances by one 1-minute bar, closing the previous bucket if it ended."""
        start = bucket_start(bar["at"], self.interval)
        if self._bucket is not None and start != self._bucket:
            self.ema.push(self._close)
            self.last_bar_close = self._close
        self._bucket, self._close = start, bar["close"]


def _session_plans(conn, day, prev, strategies, universe):
    """Each stock's levels for `day`, built from `prev` exactly as the overnight scan does."""
    meta = db.lot_sizes(conn, universe)
    factors = db.adjust_factors(conn, universe, prev, day)
    ohlc = db.session_ohlc(conn, prev, universe)

    plans = defaultdict(dict)        # strategy id -> symbol -> plan
    chains = {}
    for symbol, (high, low, close) in ohlc.items():
        info = meta.get(symbol)
        if not info or not info.get("lot_size"):
            continue

        # Prices before an ex-date are on the old scale. Left unadjusted, the
        # pivots would land far from where the stock now trades and every level
        # derived from them would be wrong.
        factor = factors.get(symbol, 1.0)
        high, low, close = high * factor, low * factor, close * factor

        expiry = db.levels_expiry(conn, prev, symbol)
        if expiry is None:
            continue
        raw = db.option_chain(conn, prev, symbol, expiry)
        chain = chain_window(raw, close)
        if not chain:
            continue
        chains[symbol] = chain

        for strategy in strategies:
            plan = plan_for_stock(symbol, (high, low, close), chain,
                                  info["lot_size"], info.get("strike_step"),
                                  strategy["params"])
            if plan is not None:
                plans[strategy["id"]][symbol] = plan
    return plans


def _seed_closes(conn, day, prev, symbols, period, interval):
    """{symbol: [closes]} - the last period*4 settled interval bars before `day`."""
    need = period * SEED_BAR_MULTIPLE
    days = []
    d = prev
    # A session is 375 minutes = 75 five-minute bars, so 84 bars reaches into the
    # session before last. Three gives room for a short or missing day.
    for _ in range(3):
        if d is None:
            break
        days.append(d)
        d = db.previous_trading_day(conn, d)
    if not days:
        return {}

    factors = db.adjust_factors(conn, symbols, min(days), day)
    out = {}
    for symbol in symbols:
        by_day = db.spot_closes(conn, days, symbol)
        bars = []
        for d in sorted(by_day):
            bars.extend(fold_bars(by_day[d], interval))
        factor = factors.get(symbol, 1.0)
        out[symbol] = [close * factor for _, close in bars[-need:]]
    return out


def replay_session(conn, day, strategies, floors, log=None, setups=None):
    """Replays one session. Returns (closed_positions, notes).

    `setups` limits which legs may fire, as {strategy id: {setup ids}}. Left out,
    every leg of every strategy passed runs - which is what the live desk does.
    Narrowing it is how a run replays setup A on its own: the state machine still
    tracks all three phases, because a break that happened while a leg was not
    selected is still a break, but only the selected legs can produce a trade.
    """
    notes = {"signals": 0, "rejected": defaultdict(int), "skipped": defaultdict(int),
             "bySetup": defaultdict(int), "symbols": 0, "incomplete": 0}

    prev = db.previous_trading_day(conn, day)
    if prev is None:
        return [], notes

    universe = db.option_universe(conn, day)
    if not universe:
        notes["skipped"]["no option universe for the month"] += 1
        return [], notes

    coverage = db.option_coverage(conn, day, universe)
    plans = _session_plans(conn, day, prev, strategies, universe)
    symbols = sorted({s for by_symbol in plans.values() for s in by_symbol})
    notes["symbols"] = len(symbols)
    if not symbols:
        return [], notes

    notes["incomplete"] = sum(1 for s in symbols
                              if coverage.get(s, 0) < db.OPTION_SERIES_PER_DAY)

    period = strategies[0]["params"]["emaPeriod"]
    interval = strategies[0]["params"]["emaIntervalMinutes"]
    seeds = _seed_closes(conn, day, prev, symbols, period, interval)

    bars = db.spot_bars(conn, day, symbols)
    symbols = [s for s in symbols if bars.get(s)]
    if not symbols:
        return [], notes

    clocks = {s: SymbolClock(period, interval, seeds.get(s, [])) for s in symbols}
    states = {(st["id"], s): initial_state(plans[st["id"]][s])
              for st in strategies for s in symbols if s in plans[st["id"]]}

    minutes = sorted({bar["at"] for s in symbols for bar in bars[s]})
    bar_at = {s: {bar["at"]: bar for bar in bars[s]} for s in symbols}

    # Option data is read once per (symbol, side) and only when a signal needs it.
    option_cache = {}
    expiry_cache = {}
    gate_cache = {}

    def option_data(symbol, side):
        key = (symbol, side)
        if key not in option_cache:
            if symbol not in expiry_cache:
                expiry_cache[symbol] = db.entry_expiry(conn, day, symbol)
            expiry = expiry_cache[symbol]
            option_cache[key] = ((None, None, None) if expiry is None
                                 else (expiry,) + db.option_day(conn, day, symbol, expiry, side))
        return option_cache[key]

    cutoff = ist_time(strategies[0]["params"]["entryCutoffIst"])
    flatten = ist_time(strategies[0]["params"]["flattenIst"])
    max_open = max(st["params"]["maxOpenTrades"] for st in strategies)

    open_positions = []
    closed = []
    taken = defaultdict(int)

    for minute in minutes:
        # The open book first: a stop that fires this minute frees a slot this
        # minute, exactly as it would live.
        still_open = []
        for position in open_positions:
            expiry, by_strike, band = option_cache[(position.symbol, position.option_type)][0:3]
            done = step_position(position, by_strike, band, minute, flatten,
                                 STRATEGIES[position.strategy_id]["risk"])
            (closed if done is not None else still_open).append(done or position)
        open_positions = still_open

        entries_open = minute.time() < cutoff

        # Every clock advances once per minute, before any strategy reads it.
        # Advancing it inside the strategy loop would tick a stock's EMA twice
        # when both rules watch it, and not at all when only the second does.
        for symbol in symbols:
            bar = bar_at[symbol].get(minute)
            if bar is not None:
                clocks[symbol].push_minute(bar)

        for strategy in strategies:
            sid = strategy["id"]
            allowed = set(setups[sid]) if setups else set(strategy["setups"])
            for symbol in symbols:
                state = states.get((sid, symbol))
                bar = bar_at[symbol].get(minute)
                if state is None or bar is None:
                    continue

                clock = clocks[symbol]
                signal = evaluate_symbol(
                    plans[sid][symbol], state, strategy["params"], bar["close"],
                    clock.value, clock.last_bar_close, minute, entries_open, allowed)
                if signal is None:
                    continue

                notes["signals"] += 1
                notes["bySetup"][signal.setup] += 1

                if len(open_positions) >= max_open:
                    notes["rejected"]["book full"] += 1
                    continue
                if taken[sid] >= strategy["params"]["maxTradesPerDay"]:
                    notes["rejected"]["daily cap"] += 1
                    continue

                position = _try_fill(conn, day, prev, strategy, signal, plans[sid][symbol],
                                     minute, floors, option_data, gate_cache, notes)
                if position is None:
                    continue

                state.trades_today += 1
                taken[sid] += 1
                open_positions.append(position)

    # Anything still open at the end of the data is flattened on its last price.
    for position in open_positions:
        position.exit_price = position.last_price
        position.exit_at = position.last_at
        position.exit_reason = "eod-flatten"
        closed.append(position)

    if log:
        log(f"{day}  {len(symbols)} stocks, {notes['signals']} signals, "
            f"{len(closed)} trades")
    return closed, notes


def _try_fill(conn, day, prev, strategy, signal, plan, minute, floors,
              option_data, gate_cache, notes):
    """Picks the contract, runs the gate, and opens the position - or explains why not."""
    side = option_type(strategy, signal.setup)
    expiry, by_strike, band = option_data(signal.symbol, side)
    if expiry is None or not by_strike:
        notes["skipped"]["no option data for the stock"] += 1
        return None

    picked = db.atm_strike_at(by_strike, band, minute)
    if picked is None:
        notes["skipped"]["no at-the-money strike at the entry minute"] += 1
        return None
    strike, entry_bar = picked

    key = (signal.symbol, side, strike)
    if key not in gate_cache:
        # The previous session's figures: what the overnight scan knew, and what
        # was knowable at the entry minute. The day's own end-of-day numbers
        # would be look-ahead.
        gate_cache[key] = (db.strike_day_stats(conn, prev, signal.symbol, expiry, strike, side),
                           db.chain_max_oi(conn, prev, signal.symbol, expiry, side),
                           db.liquidity_row(conn, day, signal.symbol))
    strike_stats, chain_max, liquidity = gate_cache[key]

    result = assess(entry_bar, strike_stats, chain_max, liquidity,
                    plan.lot_size, strategy["params"], floors)
    if not result.ok:
        notes["rejected"][result.reason or "illiquid"] += 1
        return None

    return open_position(signal, strategy, {"price": fill_price(entry_bar)},
                         plan.lot_size, expiry, strike, side, result.mark,
                         day.isoformat())


# ---------------- the run ----------------

def run_key(setup_ids, start, end):
    """A run's id, from the three things the person actually chose.

    Deliberately *not* a hash of everything that decides the result. The
    dashboard has to produce the same id to answer "you have already run this"
    the moment the dates are picked, and the dashboard cannot see PostgreSQL -
    so it cannot know the archive's revision, and a key that included it could
    only ever be computed here. Keeping the key to the chosen inputs makes the
    two sides agree by construction.

    What the key leaves out is not lost: the floors, the rule versions and the
    data revision are all stored on the run and shown next to it, so a result
    produced under different conditions is visible rather than silently reused.
    `lib/backtest/key.ts` is the other half of this and must match it.
    """
    base = "|".join([",".join(sorted(setup_ids)), str(start), str(end)])
    return hashlib.sha1(base.encode("utf-8")).hexdigest()[:16]


def fingerprint(setup_ids, start, end, floors, data_revision):
    """(run id, everything that decided the result) - the latter stored for the record."""
    setup_ids = sorted(setup_ids)
    strategy_ids, _ = selection(setup_ids)
    payload = {
        "setups": [{"setup": s, **SETUPS[s]} for s in setup_ids],
        "strategies": [{"id": sid, "version": STRATEGIES[sid]["version"],
                        "params": STRATEGIES[sid]["params"],
                        "risk": STRATEGIES[sid]["risk"]} for sid in strategy_ids],
        "from": str(start), "to": str(end),
        "floors": floors,
        "fillRule": "entry-minute-close",
        "dataRevision": data_revision,
    }
    blob = json.dumps(payload, sort_keys=True, default=str)
    payload["conditions"] = hashlib.sha1(blob.encode("utf-8")).hexdigest()[:16]
    return run_key(setup_ids, start, end), payload


def data_revision(conn, start, end):
    """Changes whenever the archive under this range changes, so a run made
    before a gap was backfilled is not silently reused afterwards."""
    row = conn.execute(
        "SELECT count(*), coalesce(max(finished_at), 'epoch') FROM done "
        "WHERE dataset = 'options_1min' AND d BETWEEN %s AND %s", (start, end)).fetchone()
    return f"{row[0]}@{row[1]:%Y%m%d%H%M%S}" if row else "0@epoch"


def summarise(positions):
    """The headline figures, computed the way the Trade Analysis page computes them."""
    rows = [p for p in positions if p.profit is not None]
    if not rows:
        return {"trades": 0, "wins": 0, "losses": 0, "winRate": None, "net": 0.0,
                "profitFactor": None, "maxDrawdown": 0.0, "expectancy": 0.0}

    net = sum(p.profit for p in rows)
    wins = [p for p in rows if p.profit >= 0.5]
    losses = [p for p in rows if p.profit <= -0.5]
    gross_win = sum(p.profit for p in wins)
    gross_loss = -sum(p.profit for p in losses)

    peak, drawdown, running = 0.0, 0.0, 0.0
    for p in sorted(rows, key=lambda x: (x.exit_at or x.entry_at)):
        running += p.profit
        peak = max(peak, running)
        drawdown = min(drawdown, running - peak)

    decided = len(wins) + len(losses)
    return {
        "trades": len(rows),
        "wins": len(wins),
        "losses": len(losses),
        "winRate": (len(wins) / decided) if decided else None,
        "net": round(net, 2),
        "profitFactor": (gross_win / gross_loss) if gross_loss > 0
                        else (math.inf if gross_win > 0 else None),
        "maxDrawdown": round(drawdown, 2),
        "expectancy": round(net / len(rows), 2),
    }


def run_range(conn, setup_ids, start, end, floors, log=None, on_progress=None):
    """Replays every trading day in [start, end]. Returns (positions, report).

    `setup_ids` names the legs to replay - A, B, C or any mix. One leg at a time
    is how you find out which of them is carrying the result; all three together
    is what the desk actually runs.
    """
    strategy_ids, chosen = selection(setup_ids)
    strategies = [STRATEGIES[sid] for sid in strategy_ids]
    days = db.trading_days(conn, start, end)
    if not days:
        raise SystemExit(f"no trading days between {start} and {end}")

    positions = []
    totals = {"signals": 0, "symbols": 0, "incomplete": 0}
    rejected = defaultdict(int)
    skipped = defaultdict(int)
    by_setup = defaultdict(int)

    for i, day in enumerate(days, 1):
        day_positions, notes = replay_session(conn, day, strategies, floors, log=log,
                                              setups=chosen)
        positions.extend(day_positions)
        totals["signals"] += notes["signals"]
        totals["symbols"] = max(totals["symbols"], notes["symbols"])
        totals["incomplete"] += notes["incomplete"]
        for k, v in notes["rejected"].items():
            rejected[k] += v
        for k, v in notes["skipped"].items():
            skipped[k] += v
        for k, v in notes["bySetup"].items():
            by_setup[k] += v
        if on_progress and i % S.PROGRESS_EVERY == 0:
            on_progress(i, len(days), day)

    gate_counts = defaultdict(int)
    for p in positions:
        gate_counts[p.gate] += 1
    gate_counts["rejected"] = sum(rejected.values())

    report = {
        "sessions": len(days),
        "setups": sorted(setup_ids),
        "summary": summarise(positions),
        "summaryExApprox": summarise([p for p in positions if p.gate == CLEAR]),
        # Each leg on its own, always - even when they were replayed together.
        # The whole point of separating them is being able to read them apart.
        "bySetup": {s: dict(summarise([p for p in positions if p.setup == s]),
                            signals=by_setup.get(s, 0))
                    for s in sorted(setup_ids)},
        "gateCounts": dict(gate_counts),
        "rejected": dict(rejected),
        "skipped": dict(skipped),
        "signals": totals["signals"],
        "incompleteStockDays": totals["incomplete"],
    }
    return positions, report
