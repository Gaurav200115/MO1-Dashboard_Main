/**
 * Zerodha's charges on one round trip of a bought option - an estimate of what
 * the contract note will show, so paper and backtest results can be read after
 * costs.
 *
 * Rates from https://zerodha.com/charges, F&O - Options, read 2026-11-19. They
 * change; this is the one place to update them. Checked against the contract
 * note of 19 Nov: two round trips (TITAN, ASHOKLEY, about 9-10k of premium
 * each way) estimate to about 137 against 138 charged.
 *
 * Only executed orders are charged - a cancelled or rejected order costs
 * nothing - so a paper or backtest trade, which is always a filled buy and a
 * filled sell, is two orders.
 */
export const CHARGE_RATES = {
  /** Flat, per executed order. */
  brokeragePerOrder: 20,
  /** On the sell side, on premium. */
  sttSellPct: 0.15,
  /** NSE, on premium, both sides. */
  exchangePct: 0.03553,
  /** Per crore of premium turnover. */
  sebiPerCrore: 10,
  /** On the buy side. */
  stampBuyPct: 0.003,
  /** On brokerage + exchange charges + SEBI fee. */
  gstPct: 18,
} as const;

/**
 * Kotak Neo, for backtest results only (2026-11-25, as Gaurav gave it): no
 * brokerage, and so no GST - only the statutory charges, which are the same at
 * any broker. The live desk still trades through Zerodha and keeps
 * CHARGE_RATES above. scripts/backtest/backtest/charges.py holds the same
 * numbers; tests/test_charges.py fails when the two disagree.
 */
export const BACKTEST_CHARGE_RATES = {
  /** Flat, per executed order. */
  brokeragePerOrder: 0,
  /** On the sell side, on premium. */
  sttSellPct: 0.15,
  /** NSE, on premium, both sides. */
  exchangePct: 0.03553,
  /** Per crore of premium turnover. */
  sebiPerCrore: 10,
  /** On the buy side. */
  stampBuyPct: 0.003,
  /** On brokerage + exchange charges + SEBI fee. */
  gstPct: 0,
} as const;

export type ChargeRates = { [K in keyof typeof CHARGE_RATES]: number };

/** Who the charges are estimated for, as the page names them. */
export function brokerName(rates: ChargeRates): string {
  return rates === BACKTEST_CHARGE_RATES ? "Kotak Neo" : "Zerodha";
}

export interface Charges {
  brokerage: number;
  stt: number;
  exchange: number;
  sebi: number;
  stamp: number;
  gst: number;
  total: number;
}

/** Charges on one bought-and-sold option: buy and sell values are premium x quantity. */
export function roundTripCharges(buyValue: number, sellValue: number, rates: ChargeRates = CHARGE_RATES): Charges {
  const turnover = buyValue + sellValue;
  const brokerage = 2 * rates.brokeragePerOrder;
  const stt = (sellValue * rates.sttSellPct) / 100;
  const exchange = (turnover * rates.exchangePct) / 100;
  const sebi = (turnover * rates.sebiPerCrore) / 1e7;
  const stamp = (buyValue * rates.stampBuyPct) / 100;
  const gst = ((brokerage + exchange + sebi) * rates.gstPct) / 100;
  return { brokerage, stt, exchange, sebi, stamp, gst, total: brokerage + stt + exchange + sebi + stamp + gst };
}

/** The estimate for a closed trade, or 0 when it has no sell yet. */
export function tradeCharges(
  trade: {
    qty: number;
    buy: { price: number };
    sell: { price: number } | null;
  },
  rates: ChargeRates = CHARGE_RATES
): number {
  if (!trade.sell) return 0;
  return roundTripCharges(trade.buy.price * trade.qty, trade.sell.price * trade.qty, rates).total;
}
