"""Replaying one whole session against a stand-in archive.

The point of this file is that it exercises `replay_session` itself - the
overnight levels, the EMA seed, the minute loop, the contract pick, the gate and
the exit - with no PostgreSQL. The stand-in answers exactly the queries db.py
asks, with data built so one setup-A trade must fire at a known minute, on a
known strike, and close on its stop.

When this runs against the real archive the only new variable is the data. The
wiring is already known to work.

    py -3.12 tests/test_session.py
"""
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from settings import GATE_FLOORS
from backtest import strategies as S
from backtest.runner import (SymbolClock, bucket_start, fingerprint, fold_bars,
                             replay_session, summarise)

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
DAY = dt.date(2026, 10, 15)
PREV = dt.date(2026, 10, 14)
EXPIRY = dt.date(2026, 10, 28)
SYMBOL = "TEST"
LOT = 250

passed, failed = 0, []


def check(name, got, want):
    global passed
    if got == want:
        passed += 1
    else:
        failed.append(f"{name}\n      got  {got}\n      want {want}")


def at(h, m, day=DAY):
    return dt.datetime.combine(day, dt.time(h, m), tzinfo=IST)


# ---------------- the stand-in archive ----------------
#
# Previous session: high 1030, low 970, close 1000.
#   P = 1000, range = 60  ->  R1 = 1022.92, R2 = 1037.08, R3 = 1060
# One strike confirms: 1020 sits 0.286% from R1 and 1.65% from R2, so the band
# leaves it only one pivot to pair with, and it carries 10x the call OI. Every
# other strike is balanced, so nothing else is marked and no support is found -
# which leaves only setup A able to arm and keeps this test unambiguous.

CHAIN = {}
for k in range(960, 1041, 10):
    CHAIN[k] = (1000.0, 100.0) if k == 1020 else (500.0, 500.0)


def spot_day_bars():
    """The day's 1-minute closes, built so setup A fires at 09:26.

    09:15-09:19  1020   below the level (and not far enough under the EMA to
                        count as the setup failing)
    09:20        1025   crosses R1 at 1022.92
    09:21-09:24  1027   the high since the break
    09:25        1023   back inside 0.4% of the EMA, 0.39% off that high
    09:26        1026   0.29% up off the retracement low -> entry
    """
    prices = {}
    for m in range(15, 20):
        prices[at(9, m)] = 1020.0
    prices[at(9, 20)] = 1025.0
    for m in range(21, 25):
        prices[at(9, m)] = 1027.0
    prices[at(9, 25)] = 1023.0
    for m in range(26, 45):
        prices[at(9, m)] = 1026.0
    return [{"at": t, "open": p, "high": p, "low": p, "close": p, "volume": 10000}
            for t, p in sorted(prices.items())]


def option_rows():
    """CE minute bars. The premium holds, then trades down through the stop at 09:40.

    Entry 25.00 on a 250 lot: R = 2.20, so the stop sits at 22.80. The 09:40
    bar opens at 25.00 and falls to 22.00, so it trades *through* the stop
    rather than gapping past it - the fill is the stop itself.
    """
    rows = {}
    for minute in range(15, 60):
        t = at(9, minute)
        held, fallen = 25.0, 22.0
        if minute < 40:
            o = h = l = c = held
        elif minute == 40:
            o, h, l, c = held, held, fallen, fallen
        else:
            o = h = l = c = fallen
        for strike in range(990, 1051, 10):
            offset = (strike - 1030) // 10
            adj = offset * 4.0
            rows[(float(strike), t)] = {
                "at": t, "strike": float(strike), "offset": offset,
                "open": max(0.05, o - adj), "high": max(0.05, h - adj),
                "low": max(0.05, l - adj), "close": max(0.05, c - adj),
                "volume": 5000, "spot": 1026.0}
    return rows


class Result:
    def __init__(self, rows):
        self.rows = rows

    def __iter__(self):
        return iter(self.rows)

    def fetchone(self):
        return self.rows[0] if self.rows else None


class FakeArchive:
    """Answers exactly the queries db.py asks, and records which ones were asked."""

    def __init__(self):
        self.option = option_rows()
        self.asked = []

    def execute(self, sql, params=()):
        self.asked.append(sql)
        q = " ".join(sql.split())

        if "FROM trading_calendar" in q and "BETWEEN" in q:
            return Result([(DAY,)])
        if "FROM trading_calendar" in q:
            day = params[0]
            return Result([(day - dt.timedelta(days=1),)])
        if "FROM liquidity_rank WHERE selected" in q:
            return Result([(SYMBOL,)])
        if "FROM liquidity_rank WHERE month" in q:
            return Result([(100_000_000, 5_000)])
        if "FROM done" in q:
            return Result([(SYMBOL, 14)])
        if "FROM gaps" in q:
            return Result([])
        if "FROM stocks" in q:
            return Result([(SYMBOL, LOT, 10.0)])
        if "FROM corporate_actions" in q:
            return Result([])
        if "FROM cm_bhavcopy" in q:
            return Result([(SYMBOL, 103000, 97000, 100000)])
        if "min(expiry_date) FROM fo_bhavcopy" in q:
            return Result([(EXPIRY,)])
        if "strike_paise, option_type, open_interest FROM fo_bhavcopy" in q:
            rows = []
            for strike, (call_oi, put_oi) in CHAIN.items():
                rows.append((strike * 100, "CE", call_oi))
                rows.append((strike * 100, "PE", put_oi))
            return Result(rows)
        if "max(open_interest) FROM fo_bhavcopy" in q:
            return Result([(1_000_000,)])
        if "open_interest, contracts FROM fo_bhavcopy" in q:
            return Result([(500_000, 2_000)])
        if "min(expiry_date) FROM option_1min" in q:
            return Result([(EXPIRY,)])
        if "FROM option_1min" in q:
            rows = []
            for (strike, t), bar in sorted(self.option.items(), key=lambda kv: (kv[0][1], kv[0][0])):
                rows.append((t, int(strike * 100), bar["offset"],
                             int(bar["open"] * 100), int(bar["high"] * 100),
                             int(bar["low"] * 100), int(bar["close"] * 100),
                             bar["volume"], int(bar["spot"] * 100)))
            return Result(rows)
        if "FROM spot_1min" in q and "symbol = ANY" in q:
            return Result([(SYMBOL, b["at"], int(b["open"] * 100), int(b["high"] * 100),
                            int(b["low"] * 100), int(b["close"] * 100), b["volume"])
                           for b in spot_day_bars()])
        if "FROM spot_1min" in q:
            # The EMA seed: three previous sessions, flat at 1015, which is
            # enough settled 5-minute bars for a 21-period EMA to seed at 1015.
            rows = []
            for back in (3, 2, 1):
                d = DAY - dt.timedelta(days=back)
                for minute in range(200):
                    rows.append((dt.datetime.combine(d, dt.time(9, 15), tzinfo=IST)
                                 + dt.timedelta(minutes=minute), 102200))
            return Result(rows)
        raise AssertionError("unexpected query: " + q[:120])


# ---------------- the pure helpers ----------------

check("5-minute buckets land on :15 in IST", bucket_start(at(9, 17), 5), at(9, 15))
check("and on :20", bucket_start(at(9, 20), 5), at(9, 20))
check("and on the hour", bucket_start(at(10, 3), 5), at(10, 0))

bars = [{"at": at(9, m), "close": float(m)} for m in range(15, 26)]
check("1-minute bars fold into 5-minute bars",
      fold_bars(bars, 5), [(at(9, 15), 19.0), (at(9, 20), 24.0), (at(9, 25), 25.0)])

clock = SymbolClock(21, 5, [1015.0] * 84)
check("the EMA seeds from the previous sessions", clock.value, 1015.0)
check("and the last closed bar comes with it", clock.last_bar_close, 1015.0)

# A forming bucket must not reach the EMA until it closes.
clock.push_minute({"at": at(9, 15), "close": 1100.0})
check("a forming bar does not move the EMA", clock.value, 1015.0)
clock.push_minute({"at": at(9, 16), "close": 1100.0})
check("still not while the bucket is open", clock.value, 1015.0)
clock.push_minute({"at": at(9, 20), "close": 1100.0})
check("it moves when the bucket closes", round(clock.value, 2), round(1100 * (2 / 22) + 1015 * (20 / 22), 2))


# ---------------- the session ----------------

long_rule = S.BREAKOUT_RETRACE_21EMA
conn = FakeArchive()
positions, notes = replay_session(conn, DAY, [long_rule], GATE_FLOORS)

check("one trade came out of the session", len(positions), 1)

if positions:
    p = positions[0]
    check("it is the long rule", p.strategy_id, "breakout-retrace-21ema")
    check("under the version in the registry", p.strategy_version, 7)
    check("on setup A", p.setup, "A")
    check("it bought a call", p.option_type, "CE")
    check("entered at the rebound minute", p.entry_at, at(9, 26))
    check("on the at-the-money strike", p.strike, 1030.0)
    check("at the entry minute's close", p.entry, 25.0)
    check("one lot", p.qty, LOT)
    check("risking 550 over the lot", round(p.risk_per_unit, 2), 2.2)
    check("stop one R below the fill", round(p.stop, 2), 22.80)
    check("the gate cleared it", p.gate, "clear")
    check("it closed on its stop", p.exit_reason, "stop")
    check("at the stop price", round(p.exit_price, 2), 22.80)
    check("losing exactly one R", round(p.profit), -550)
    check("anchored on the pivot it broke", p.context["pivot"], "R1")
    check("which the strike confirmed", p.context["levelStrike"], 1020.0)

check("the signal was counted", notes["signals"], 1)
check("the stock-day was complete", notes["incomplete"], 0)

# The gate must be able to refuse. A contract nobody traded in the entry minute
# is the SHREECEM case the live gate was built to stop.
quiet = FakeArchive()
for key in quiet.option:
    quiet.option[key] = dict(quiet.option[key], volume=0)
none_taken, quiet_notes = replay_session(quiet, DAY, [long_rule], GATE_FLOORS)
check("a contract with no volume is not traded", len(none_taken), 0)
check("and the refusal is counted", quiet_notes["rejected"].get("never-traded"), 1)

# A dead strike - open interest far below the chain's heaviest - is refused too.
dead = FakeArchive()
dead_execute = dead.execute


def thin(sql, params=()):
    if "open_interest, contracts FROM fo_bhavcopy" in " ".join(sql.split()):
        return Result([(1_000, 2_000)])          # 0.1% of the chain max
    return dead_execute(sql, params)


dead.execute = thin
none_taken, dead_notes = replay_session(dead, DAY, [long_rule], GATE_FLOORS)
check("a dead strike is not traded", len(none_taken), 0)
check("and is counted as such", dead_notes["rejected"].get("dead-strike"), 1)


# ---------------- the run's identity ----------------

floors = GATE_FLOORS
a, pa = fingerprint(["A"], DAY, DAY, floors, "100@20261015")
b, _ = fingerprint(["A"], DAY, DAY, floors, "100@20261015")
check("the same request gives the same run id", a, b)
e, _ = fingerprint(["A", "B"], DAY, DAY, floors, "100@20261015")
check("adding a setup is a different run", a == e, False)
check("every leg is its own run",
      len({fingerprint([s], DAY, DAY, floors, "x")[0] for s in ("A", "B", "C")}), 3)
f, _ = fingerprint(["A"], DAY, DAY + dt.timedelta(days=1), floors, "100@20261015")
check("a different range is a different run", a == f, False)
check("the order the setups are named in does not matter",
      fingerprint(["C", "A"], DAY, DAY, floors, "x")[0],
      fingerprint(["A", "C"], DAY, DAY, floors, "x")[0])

# The id is only what was asked for. What actually decided the result - the
# floors, the rule versions, how much of the archive existed - is recorded
# beside it, so a run made under different conditions is visible rather than
# silently reused.
_, pc = fingerprint(["A"], DAY, DAY, floors, "101@20261016")
check("more data in the archive changes the recorded conditions",
      pa["conditions"] == pc["conditions"], False)
_, pd = fingerprint(["A"], DAY, DAY, dict(floors, day_contracts_min=1), "100@20261015")
check("so do different gate floors", pa["conditions"] == pd["conditions"], False)

# The dashboard computes the same id in TypeScript (lib/backtest/key.ts). If
# these two ever disagree, "already run" silently stops working.
import hashlib as _h
expected = _h.sha1(f"A|{DAY}|{DAY}".encode()).hexdigest()[:16]
check("the id is a plain sha1 of the request, as key.ts computes it", a, expected)


# ---------------- the summary ----------------

class Fake:
    def __init__(self, profit, order):
        self.profit, self.exit_at, self.entry_at = profit, order, order


rows = [Fake(1100, 1), Fake(-550, 2), Fake(-550, 3), Fake(2200, 4)]
stats = summarise(rows)
check("net is the sum", stats["net"], 2200.0)
check("wins and losses are counted", (stats["wins"], stats["losses"]), (2, 2))
check("profit factor is gross win over gross loss", stats["profitFactor"], 3300 / 1100)
check("max drawdown is the worst peak-to-trough", stats["maxDrawdown"], -1100.0)
check("expectancy is net per trade", stats["expectancy"], 550.0)
check("an empty book summarises to nothing", summarise([])["trades"], 0)

print(f"{passed} passed, {len(failed)} failed")
for f in failed:
    print("  FAIL  " + f)
sys.exit(1 if failed else 0)
