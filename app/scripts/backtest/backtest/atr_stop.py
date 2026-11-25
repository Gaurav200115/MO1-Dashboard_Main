"""The ATR stop - backtest only, for A/B/C-ATR and A/B/C-ATR600.

The -SK legs stop every trade a fixed 550 rupees of premium under the fill,
whatever the stock. This variant sizes the stop from the stock's own recent
movement instead. Defined with Gaurav on 2026-11-25:

  ATR     the stock's ATR(14) on 5-minute bars, as a chart shows it: true range
          per bar (high - low, or the gap from the previous bar's close when that
          is larger), Wilder-smoothed, seeded with the plain mean of the first 14.
          The bars run on across sessions - the three sessions before the day
          seed it, exactly as they seed the 21 EMA - so the first bar of a
          session carries the overnight gap, as it does on the chart.
          Only *closed* bars count: an entry at 10:02 reads the ATR as of the
          09:55 bar, never the 10:00 bar still forming.
  stop    ATR / 3, applied straight to the option premium in points: ATR 14.40
          puts the stop 4.80 under the fill. Not converted through a delta -
          his rule, chosen knowing an ATM option moves about half the stock, so
          the stock has to come back about 2/3 of an ATR to hit it.
  R       the stop in rupees at 1 lot: ATR / 3 x the lot quantity. No floor, no
          ceiling - the 550 is gone.

Two versions, differing only in the ladder:

  own-r   (A/B/C-ATR)    the -SK ladder in this trade's own R: stop to cost at
                         +1.5R, at +2R the stop goes to +1R, then one rung behind.
  fixed   (A/B/C-ATR600) the same ladder in fixed Rs 600 steps whatever the stop:
                         cost at +900, +600 locked at +1,200, then every +600.

A trade's `riskPerUnit` is always the ATR stop, so the dashboard's R column is the
real risk in both. In the fixed version the ladder steps in its own unit
(`Position.ladder_unit`), which is why the two can differ.
"""
def bucket_start(at, interval_minutes):
    """runner.bucket_start, imported late: the runner imports this module."""
    from .runner import bucket_start as start
    return start(at, interval_minutes)


def fold_ohlc(bars, interval_minutes):
    """1-minute bars into interval bars. Returns [(bucket_start, high, low, close)].

    A bucket that saw no trades is not a bar, as with the EMA's bars.
    """
    out = []
    current = high = low = close = None
    for bar in bars:
        start = bucket_start(bar["at"], interval_minutes)
        if current is not None and start != current:
            out.append((current, high, low, close))
            current = None
        if current is None:
            current, high, low = start, bar["high"], bar["low"]
        else:
            high, low = max(high, bar["high"]), min(low, bar["low"])
        close = bar["close"]
    if current is not None:
        out.append((current, high, low, close))
    return out


class AtrClock:
    """One stock's 5-minute ATR for one session, advanced a minute at a time."""

    def __init__(self, period, interval_minutes, seed_bars=()):
        self.period = period
        self.interval = interval_minutes
        self.value = None
        self.bars = 0
        self._prev_close = None
        self._first = []
        self._bucket = None
        self._high = self._low = self._close = None
        for _, high, low, close in seed_bars:
            self._close_bar(high, low, close)

    def _close_bar(self, high, low, close):
        if self._prev_close is None:
            tr = high - low
        else:
            tr = max(high - low, abs(high - self._prev_close), abs(low - self._prev_close))
        self._prev_close = close
        self.bars += 1
        if self.value is None:
            self._first.append(tr)
            if len(self._first) == self.period:
                self.value = sum(self._first) / self.period
        else:
            self.value = (self.value * (self.period - 1) + tr) / self.period

    def push_minute(self, bar):
        """Advances by one 1-minute bar, closing the previous bucket if it ended."""
        start = bucket_start(bar["at"], self.interval)
        if self._bucket is not None and start != self._bucket:
            self._close_bar(self._high, self._low, self._close)
            self._bucket = None
        if self._bucket is None:
            self._bucket, self._high, self._low = start, bar["high"], bar["low"]
        else:
            self._high, self._low = max(self._high, bar["high"]), min(self._low, bar["low"])
        self._close = bar["close"]


def applies(strategy):
    return strategy["risk"].get("stopBasis") == "atr"


def in_run(strategies):
    """(period, interval) when any strategy in the run stops on the ATR, else None."""
    for strategy in strategies:
        if applies(strategy):
            return strategy["risk"]["atrPeriod"], strategy["risk"]["atrIntervalMinutes"]
    return None


def plan(atr, qty, risk):
    """The stop for one trade, from the ATR at the entry minute. None when there is none."""
    if atr is None or atr <= 0:
        return None
    points = atr / risk["atrStopDivisor"]
    rupees = points * qty
    fixed = risk["ladderBasis"] == "fixed"
    return {
        "atr": atr,
        "period": risk["atrPeriod"],
        "intervalMinutes": risk["atrIntervalMinutes"],
        "divisor": risk["atrStopDivisor"],
        "points": points,
        "rupees": rupees,
        "ladderBasis": risk["ladderBasis"],
        "ladderRupees": risk["rupeesPerTrade"] if fixed else rupees,
    }


def sized_risk(risk, stop):
    """The risk a position is opened with: R is the ATR stop in rupees."""
    return dict(risk, rupeesPerTrade=stop["rupees"])


def arm(position, stop, risk):
    """Fits a just-opened position to its ladder. The stop itself is already the
    ATR stop (sized_risk); the fixed version moves its target and every rung onto
    the Rs 600 unit."""
    if stop["ladderBasis"] == "fixed":
        position.ladder_unit = stop["ladderRupees"] / position.qty
        position.target = position.entry + risk["rewardMultiple"] * position.ladder_unit
    position.context["atrStop"] = dict(stop, stop=position.stop, target=position.target)
    return position


def ladder_risk(position, risk):
    """The risk a position's ladder is stepped with: the rupees each rung locks are
    this trade's own R, or the fixed 600. Unchanged for any other position."""
    stop = position.context.get("atrStop")
    if stop is None:
        return risk
    return dict(risk, rupeesPerTrade=stop["ladderRupees"])
