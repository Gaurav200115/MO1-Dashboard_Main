"""Charges on one round trip of a bought option - the backtest's copy of
app/src/lib/strategy/charges.ts, so a run's summary can be read after costs.

Backtest results are estimated for **Kotak Neo** (2026-11-25, as Gaurav gave
it): no brokerage and so no GST - only STT, exchange charges, SEBI fee and
stamp duty, the same at any broker. That is charges.ts's BACKTEST_CHARGE_RATES;
the live desk stays on Zerodha (CHARGE_RATES there, ZERODHA_RATES here).

Statutory rates from https://zerodha.com/charges, F&O - Options, read
2026-11-19. They change; update them in charges.ts and here together -
tests/test_charges.py fails when the two disagree. Zerodha's rates were checked
against the contract note of 19 Nov: two round trips estimate to about 137
against 138 charged.

Only executed orders are charged; a backtest trade is always a filled buy and
a filled sell, so two orders.
"""

ZERODHA_RATES = {
    "brokeragePerOrder": 20,    # flat, per executed order
    "sttSellPct": 0.15,         # sell side, on premium
    "exchangePct": 0.03553,     # NSE, on premium, both sides
    "sebiPerCrore": 10,         # per crore of premium turnover
    "stampBuyPct": 0.003,       # buy side
    "gstPct": 18,               # on brokerage + exchange + SEBI
}

# What every backtest run is charged: Kotak Neo - no brokerage, no GST.
RATES = dict(ZERODHA_RATES, brokeragePerOrder=0, gstPct=0)
BROKER = "Kotak Neo"


def round_trip(buy_value, sell_value, rates=RATES):
    """Total charges on one bought-and-sold option; values are premium x quantity."""
    turnover = buy_value + sell_value
    brokerage = 2 * rates["brokeragePerOrder"]
    stt = sell_value * rates["sttSellPct"] / 100
    exchange = turnover * rates["exchangePct"] / 100
    sebi = turnover * rates["sebiPerCrore"] / 1e7
    stamp = buy_value * rates["stampBuyPct"] / 100
    gst = (brokerage + exchange + sebi) * rates["gstPct"] / 100
    return brokerage + stt + exchange + sebi + stamp + gst


def of_position(position):
    """The estimate for a closed position; 0 while it has no exit, or no prices to price it by."""
    exit_price = getattr(position, "exit_price", None)
    if exit_price is None or getattr(position, "entry", None) is None or not getattr(position, "qty", None):
        return 0.0
    return round_trip(position.entry * position.qty, position.exit_price * position.qty)
