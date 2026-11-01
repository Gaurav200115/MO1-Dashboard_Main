"""The pre-trade book gate, as much of it as the archive can answer.

The live gate (app/src/lib/strategy/tradeable.ts) exists because of a measured
failure: 9 of the first 36 trades died inside ten seconds and between them
accounted for the entire net loss. Every one had been filled at an ask far above
where the contract was actually trading - SHREECEM at 470.95 against a last
print of 299.70, on a strike carrying 125 contracts of open interest against
11,625 at the fattest strike in its chain. Nothing had moved. There was no book.

A backtest that skips the gate does not reproduce the desk; it reproduces the
desk before the gate existed, and it will report losses the live rule would
never have taken. So the gate has to be here in some form.

Of its six checks, two reproduce **exactly** - same test, same numbers:

    the contract traded at all      option_1min.volume
    strike OI >= 3% of chain max    fo_bhavcopy.open_interest

The other four are spread tests, and the archive holds no quotes at all. They
are stood in for by liquidity, on the gate's own reasoning: the books that
failed it were thin ones. Every trade is marked with how much of it rested on
that substitution, and the run reports its headline both with and without the
marked trades. If those two numbers are far apart, the result depends on the
approximation rather than on the rule.
"""
from dataclasses import dataclass

CLEAR, APPROX, REJECTED = "clear", "approx", "rejected"


@dataclass
class GateResult:
    mark: str                 # clear | approx | rejected
    reason: str | None        # why, when rejected
    detail: str
    measures: dict            # what was measured, stored on the trade

    @property
    def ok(self):
        return self.mark != REJECTED


def _band(value, floor_min, floor_clear):
    """CLEAR above the clear floor, APPROX between the two, REJECTED below.

    A missing measurement returns APPROX, not CLEAR: we do not know, and saying
    so is the whole point of the mark.
    """
    if value is None:
        return APPROX
    if value < floor_min:
        return REJECTED
    return CLEAR if value >= floor_clear else APPROX


def assess(entry_bar, strike_stats, chain_max_oi, liquidity, lot_size, params, floors):
    """Returns a GateResult for one signal's chosen contract.

    `entry_bar`     the option_1min row at the entry minute, for the strike bought
    `strike_stats`  that strike's own fo_bhavcopy open_interest and contracts
    `chain_max_oi`  the heaviest strike's OI in the same chain, same side
    `liquidity`     the stock's liquidity_rank row for the month
    `params`        the strategy's own params - minStrikeOiShare comes from here,
                    so the exact check uses the live threshold and not a copy
    """
    measures = {}

    # --- check 5, reproduced exactly: did this contract trade at all? ---------
    volume = entry_bar.get("volume") if entry_bar else None
    measures["entryMinuteVolume"] = volume
    if entry_bar is None:
        return GateResult(REJECTED, "never-traded",
                          "no minute bar for this contract at the entry minute", measures)
    if not volume or volume <= 0:
        return GateResult(REJECTED, "never-traded",
                          "no volume on this contract in the entry minute", measures)

    # --- check 6, reproduced exactly: strike OI against the chain's heaviest --
    strike_oi = strike_stats.get("open_interest")
    measures["strikeOi"] = strike_oi
    measures["chainMaxOi"] = chain_max_oi
    if strike_oi is not None and chain_max_oi:
        share = strike_oi / chain_max_oi * 100
        measures["strikeOiSharePct"] = round(share, 2)
        if share < params["minStrikeOiShare"]:
            return GateResult(REJECTED, "dead-strike",
                              f"open interest is {share:.1f}% of the chain's heaviest strike",
                              measures)

    # --- checks 1-4, approximated: the spread tests -------------------------
    # Strongest proxy first. A rejection by any one of them is a rejection; the
    # mark is the weakest band any of them returned.
    marks = []

    lots = (volume / lot_size) if lot_size else None
    measures["entryMinuteLots"] = round(lots, 2) if lots is not None else None
    marks.append(("entry-minute lots", lots,
                  _band(lots, floors["entry_minute_lots_min"], floors["entry_minute_lots_clear"])))

    contracts = strike_stats.get("contracts")
    measures["dayContracts"] = contracts
    marks.append(("contracts that day", contracts,
                  _band(contracts, floors["day_contracts_min"], floors["day_contracts_clear"])))

    turnover = liquidity.get("turnover_median")
    measures["turnoverMedian"] = turnover
    marks.append(("monthly turnover", turnover,
                  _band(turnover, floors["turnover_median_min"], floors["turnover_median_clear"])))

    atm_oi = liquidity.get("atm_oi_lots")
    measures["atmOiLots"] = atm_oi
    marks.append(("monthly ATM OI", atm_oi,
                  _band(atm_oi, floors["atm_oi_lots_min"], floors["atm_oi_lots_clear"])))

    for label, value, mark in marks:
        if mark == REJECTED:
            return GateResult(REJECTED, "illiquid", f"{label} is {value:g}, below the floor", measures)

    near = [label for label, _, mark in marks if mark == APPROX]
    if near:
        return GateResult(APPROX, None,
                          "near the floor on " + ", ".join(near), measures)

    return GateResult(CLEAR, None, "comfortably above every liquidity floor", measures)


def fill_price(entry_bar):
    """What the entry is filled at.

    The live desk crosses the spread and pays the ask. There is no ask here, so
    the fill is the entry minute's close - the price the rule is evaluated on.
    That is optimistic by half a spread on every trade, and it is the single
    largest reason a backtest result will read better than the live record. It
    is stated in the run's limits rather than hidden in a constant.
    """
    return entry_bar["close"]
