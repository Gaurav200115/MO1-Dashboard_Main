"""A stand-in for the PostgreSQL archive, answering exactly the queries db.py asks.

Shared by the session tests so the long rule, the short rule and both together
are all exercised through `replay_session` itself rather than through a
hand-rolled loop per test. Several stocks, each with its own previous session,
option chain and minute prices.

Everything is built in rupees and converted to paise on the way out, because
that is the boundary the real tables sit on.
"""
import datetime as dt
from dataclasses import dataclass, field

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))


def at(day, h, m):
    return dt.datetime.combine(day, dt.time(h, m), tzinfo=IST)


@dataclass
class Stock:
    """One stock's fixture for one session."""
    symbol: str
    # Previous session's high, low and close - what the pivots are built from.
    ohlc: tuple
    # {strike: (call_oi, put_oi)}. A strike is an OI level only where one side
    # carries 1.8x the other; balanced strikes are deliberately invisible.
    chain: dict
    # {minute: spot price}
    prices: dict
    # Where the EMA is seeded, from previous sessions.
    seed: float
    # Fallback strike for offset 0 when a minute has no spot price. The offset
     # is otherwise recomputed every minute from spot, exactly as Dhan does -
     # which is the behaviour section 6.1 of the plan warns about, so the tests
     # should be exposed to it rather than shielded from it.
    atm: float
    # {minute: (open, high, low, close)} for that strike; other strikes are
    # shifted by `skew_per_strike` so a wrong strike pick shows up as a wrong price.
    premium: dict
    lot: int = 250
    strike_step: float = 10.0
    skew_per_strike: float = 4.0
    # Lots traded at the strike in a minute; 0 makes the gate refuse.
    volume: int = 5000
    # That strike's own previous-session open interest, against the chain's heaviest.
    strike_oi: float = 500_000.0
    chain_max_oi: float = 1_000_000.0
    strikes: tuple = field(default=tuple(range(900, 1121, 10)))


class Result:
    def __init__(self, rows):
        self.rows = rows

    def __iter__(self):
        return iter(self.rows)

    def fetchone(self):
        return self.rows[0] if self.rows else None


class FakeArchive:
    """Answers db.py's queries for a set of stocks on one session."""

    def __init__(self, day, stocks, expiry=None, prev=None):
        self.day = day
        self.prev = prev or (day - dt.timedelta(days=1))
        self.expiry = expiry or (day + dt.timedelta(days=13))
        self.stocks = {s.symbol: s for s in stocks}
        self.asked = []

    # -- helpers -----------------------------------------------------------

    def _option_rows(self, stock, option_type):
        rows = []
        for minute, (o, h, l, c) in sorted(stock.premium.items()):
            spot = stock.prices.get(minute)
            centre = (min(stock.strikes, key=lambda k: abs(k - spot))
                      if spot is not None else stock.atm)
            for strike in stock.strikes:
                offset = int(round((strike - centre) / stock.strike_step))
                # A call loses value as the strike rises; a put gains. Getting
                # this backwards would make a wrong strike pick look harmless.
                shift = offset * stock.skew_per_strike * (1 if option_type == "CE" else -1)
                rows.append((
                    minute, int(round(strike * 100)), offset,
                    int(round(max(0.05, o - shift) * 100)),
                    int(round(max(0.05, h - shift) * 100)),
                    int(round(max(0.05, l - shift) * 100)),
                    int(round(max(0.05, c - shift) * 100)),
                    stock.volume, int(round((spot if spot is not None else stock.atm) * 100))))
        return rows

    # -- the query surface -------------------------------------------------

    def execute(self, sql, params=()):
        self.asked.append(sql)
        q = " ".join(sql.split())

        if "FROM trading_calendar" in q and "BETWEEN" in q:
            return Result([(self.day,)])
        if "FROM trading_calendar" in q:
            return Result([(self.prev,)]) if params and params[0] == self.day else Result(
                [(params[0] - dt.timedelta(days=1),)])

        if "FROM liquidity_rank WHERE selected" in q:
            return Result([(s,) for s in self.stocks])
        if "FROM liquidity_rank WHERE month" in q:
            return Result([(100_000_000, 5_000)])

        if "FROM done" in q:
            return Result([(s, 14) for s in self.stocks])
        if "FROM gaps" in q:
            return Result([])

        if "FROM stocks" in q:
            return Result([(s.symbol, s.lot, s.strike_step) for s in self.stocks.values()])
        if "FROM corporate_actions" in q:
            return Result([])

        if "FROM cm_bhavcopy" in q:
            return Result([(s.symbol, *(int(round(v * 100)) for v in s.ohlc))
                           for s in self.stocks.values()])

        if "min(expiry_date) FROM fo_bhavcopy" in q:
            return Result([(self.expiry,)])
        if "strike_paise, option_type, open_interest FROM fo_bhavcopy" in q:
            stock = self.stocks[params[1]]
            rows = []
            for strike, (call_oi, put_oi) in stock.chain.items():
                rows.append((int(round(strike * 100)), "CE", call_oi))
                rows.append((int(round(strike * 100)), "PE", put_oi))
            return Result(rows)
        if "max(open_interest) FROM fo_bhavcopy" in q:
            return Result([(self.stocks[params[1]].chain_max_oi,)])
        if "open_interest, contracts FROM fo_bhavcopy" in q:
            return Result([(self.stocks[params[1]].strike_oi, 2_000)])

        if "min(expiry_date) FROM option_1min" in q:
            return Result([(self.expiry,)])
        if "FROM option_1min" in q:
            return Result(self._option_rows(self.stocks[params[0]], params[2]))

        if "FROM spot_1min" in q and "symbol = ANY" in q:
            rows = []
            for stock in self.stocks.values():
                for minute, price in sorted(stock.prices.items()):
                    p = int(round(price * 100))
                    rows.append((stock.symbol, minute, p, p, p, p, 10_000))
            return Result(rows)
        if "FROM spot_1min" in q:
            # The EMA seed: three previous sessions, flat at the stock's seed level.
            stock = self.stocks[params[0]]
            rows = []
            for back in (3, 2, 1):
                d = self.day - dt.timedelta(days=back)
                for minute in range(200):
                    rows.append((at(d, 9, 15) + dt.timedelta(minutes=minute),
                                 int(round(stock.seed * 100))))
            return Result(rows)

        raise AssertionError("unexpected query: " + q[:140])


def flat_premium(day, value, minutes=range(15, 60), hour=9):
    """A premium that does not move - for a trade meant to reach the flatten."""
    return {at(day, hour, m): (value, value, value, value) for m in minutes}


def premium_falling_through(day, held, fallen, at_minute, hour=9, minutes=range(15, 60)):
    """Holds at `held`, then trades down through to `fallen` at `at_minute`.

    Trades *through* rather than gapping, so the fill is the stop itself and the
    test is measuring the ladder rather than the gap rule.
    """
    out = {}
    for m in minutes:
        t = at(day, hour, m)
        if m < at_minute:
            out[t] = (held, held, held, held)
        elif m == at_minute:
            out[t] = (held, held, fallen, fallen)
        else:
            out[t] = (fallen, fallen, fallen, fallen)
    return out
