"""Average Daily Range, and the entry thresholds measured in it.

Backtest-only, for the ADR variants of the retrace rules (setups A-ADR and
C-ADR). The live rule measures its pullback zone and its entry turn as a fixed
percentage of price - 0.4% and 0.2% - which is the same ruler for every stock.
The ADR variant measures both in units of the stock's own daily range instead,
so a calm stock is asked for a smaller pullback and a wild one for a larger one.

Definition, as agreed with Gaurav on 2026-11-13:

  ADR%   mean over the last 14 completed sessions of (high - low) / close,
         from the NSE equity bhavcopy. Taken in percent rather than rupees so a
         split inside the window cannot distort it - each day's range is on
         that day's own scale.
  ADR    ADR% of the previous session's official close, in rupees.
  zone   adrZoneMultiple x ADR     - how close to the 21 EMA counts as a retrace
  turn   adrTurnMultiple x ADR     - how far off the extreme the entry triggers

The multiples are calibrated so the *typical* stock behaves exactly as the live
rule does. Measured from Mongo `daily_levels` on 2026-11-13 (186 stocks, 5,570
stock-days, 7 Sep - 13 Nov 2026), the median 14-session ADR is 2.716% of price,
so 0.4% = 0.147 ADR and 0.2% = 0.074 ADR - rounded to 0.15 and 0.075. A stock
on that median gets a 0.41% zone and a 0.20% turn; a calmer one gets less, a
wilder one more.

Everything here is known before 09:15: the window ends on the previous session,
so the replay cannot see the day it is trading.
"""
import math


def daily_range_pct(high, low, close):
    """One session's range as a percent of its close. None for a row that cannot be one."""
    if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in (high, low, close)):
        return None
    if close <= 0 or low <= 0 or high < low:
        return None
    return (high - low) / close * 100


def adr_pct(sessions, period):
    """Mean daily range, in percent, over the last `period` sessions.

    `sessions` is [(date, high, low, close)] in any order. Returns None unless
    there are `period` usable sessions - a stock with less history than the
    window has no ADR, and is not given a made-up one.
    """
    usable = []
    for row in sorted(sessions, key=lambda r: r[0]):
        r = daily_range_pct(row[1], row[2], row[3])
        if r is not None:
            usable.append(r)
    if len(usable) < period:
        return None
    window = usable[-period:]
    return sum(window) / len(window)


class PctRuler:
    """The live rule: zone and turn as a fixed percent of price.

    Every expression here is the one signals.py used before the ADR variant
    existed, copied rather than re-derived, so the live mirror's arithmetic -
    and its rounding at the boundaries - cannot move.
    """
    ready = True

    def __init__(self, params):
        self.zone_pct = params["emaZonePct"]
        self.turn_pct = params["entryReboundPct"]

    def near(self, price, ema):
        if not (math.isfinite(price) and price > 0 and math.isfinite(ema) and ema > 0):
            return False
        return abs(price - ema) / ema * 100 <= self.zone_pct

    def closed_below_zone(self, close, ema):
        return close < ema * (1 - self.zone_pct / 100)

    def closed_above_zone(self, close, ema):
        return close > ema * (1 + self.zone_pct / 100)

    def pulled_back(self, high, price):
        if high <= 0:
            return False
        return (high - price) / high * 100 >= self.turn_pct

    def rallied(self, low, price):
        if low <= 0:
            return False
        return (price - low) / low * 100 >= self.turn_pct

    def trigger_up(self, low):
        return low * (1 + self.turn_pct / 100)

    def trigger_down(self, high):
        return high * (1 - self.turn_pct / 100)

    def record(self):
        return None


class AdrRuler:
    """The ADR variant: zone and turn as fixed rupee distances for the day.

    Both are set once, before the open, from the stock's ADR and its previous
    close - so unlike the percent rule they do not drift with the EMA or the
    pullback's extreme during the session.
    """

    def __init__(self, plan, params):
        self.period = params["adrPeriod"]
        self.zone_multiple = params["adrZoneMultiple"]
        self.turn_multiple = params["adrTurnMultiple"]
        self.pct = getattr(plan, "adr_pct", None)
        self.ready = self.pct is not None and self.pct > 0 and plan.close > 0
        self.rupees = self.pct / 100 * plan.close if self.ready else None
        self.zone = self.zone_multiple * self.rupees if self.ready else None
        self.turn = self.turn_multiple * self.rupees if self.ready else None

    def near(self, price, ema):
        if not (math.isfinite(price) and price > 0 and math.isfinite(ema) and ema > 0):
            return False
        return abs(price - ema) <= self.zone

    def closed_below_zone(self, close, ema):
        return close < ema - self.zone

    def closed_above_zone(self, close, ema):
        return close > ema + self.zone

    def pulled_back(self, high, price):
        if high <= 0:
            return False
        return high - price >= self.turn

    def rallied(self, low, price):
        if low <= 0:
            return False
        return price - low >= self.turn

    def trigger_up(self, low):
        return low + self.turn

    def trigger_down(self, high):
        return high - self.turn

    def record(self):
        """What a trade stores, so a result can be read back against the band it used."""
        if not self.ready:
            return None
        return {"period": self.period, "pct": self.pct, "rupees": self.rupees,
                "zone": self.zone, "turn": self.turn,
                "zoneMultiple": self.zone_multiple, "turnMultiple": self.turn_multiple}


def ruler(plan, params):
    """The ruler a strategy measures its entry with: ADR when it says so, percent otherwise."""
    if params.get("entryBasis") == "adr":
        return AdrRuler(plan, params)
    return PctRuler(params)
