"""A capital ledger for a backtest run (2026-11-28, as Gaurav asked for it).

A run can start with a capital - Rs 35,000 by default from the dashboard - and
from then on its balance decides which trades are taken:

  balance    the capital plus every closed trade's profit, less its charges
             (charges.py), carried across the whole run, day after day
  a trade    is taken only if its premium (price x qty) fits in what is free:
             the balance less the premium already sitting in open trades. A
             trade that does not fit is skipped, never made room for by closing
             another, and counted as `not enough capital (ledger)`.
  size       1 lot, always - the balance decides whether a trade fits, never
             how big it is, so a run stays comparable with every other run.

Money moves when a trade closes, at its exit minute, before that minute's new
signals are looked at - a stop at 10:04 frees its premium for a signal at 10:04.

The ledger keeps one row a day (open, closed P&L, charges, trades, skipped,
close) and the headline a capital curve is read by: the lowest balance, the
peak, the deepest fall from a peak in rupees and percent, and the longest run of
days spent below a previous peak. A balance at or under zero takes nothing more.
"""
from . import charges


def premium_of(position):
    return position.entry * position.qty


class Ledger:
    def __init__(self, capital):
        self.capital = float(capital)
        self.balance = self.capital
        self.peak = self.capital
        self.low = self.capital
        self.max_drawdown = 0.0          # rupees, <= 0
        self.max_drawdown_pct = 0.0      # percent of the peak it fell from, <= 0
        self.skipped = 0
        self.days = []
        self._day = None

    # ---- the day ----
    def start_day(self, day):
        self._day = {"date": str(day), "open": round(self.balance, 2), "pnl": 0.0, "charges": 0.0,
                     "trades": 0, "skipped": 0}

    def end_day(self):
        if self._day is None:
            return
        self._day["close"] = round(self.balance, 2)
        self._day["pnl"] = round(self._day["pnl"], 2)
        self._day["charges"] = round(self._day["charges"], 2)
        self.days.append(self._day)
        self._day = None

    # ---- trades ----
    def free(self, open_positions):
        """What a new trade can use: the balance less the premium in open trades."""
        return self.balance - sum(premium_of(p) for p in open_positions)

    def fits(self, open_positions, position):
        return self.balance > 0 and premium_of(position) <= self.free(open_positions) + 1e-9

    def skip(self):
        self.skipped += 1
        if self._day is not None:
            self._day["skipped"] += 1

    def close(self, position):
        """Books a closed trade: profit less charges into the balance."""
        if position.profit is None or "ledger" in position.context:
            return
        cost = charges.of_position(position)
        self.balance += position.profit - cost
        if self._day is not None:
            self._day["pnl"] += position.profit
            self._day["charges"] += cost
            self._day["trades"] += 1
        self.peak = max(self.peak, self.balance)
        self.low = min(self.low, self.balance)
        fall = self.balance - self.peak
        if fall < self.max_drawdown:
            self.max_drawdown = fall
        if self.peak > 0:
            self.max_drawdown_pct = min(self.max_drawdown_pct, fall / self.peak * 100)
        position.context["ledger"] = {"balanceAfter": round(self.balance, 2), "charges": round(cost, 2)}

    # ---- the record ----
    def report(self):
        longest, run, peak = 0, 0, self.capital
        for day in self.days:
            peak = max(peak, day["close"])
            run = run + 1 if day["close"] < peak - 1e-9 else 0
            longest = max(longest, run)
        return {
            "capital": round(self.capital, 2),
            "final": round(self.balance, 2),
            "peak": round(self.peak, 2),
            "low": round(self.low, 2),
            "maxDrawdown": round(self.max_drawdown, 2),
            "maxDrawdownPct": round(self.max_drawdown_pct, 2),
            "longestUnderwaterDays": longest,
            "skipped": self.skipped,
            "days": self.days,
        }
