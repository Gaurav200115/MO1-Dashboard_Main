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
export function roundTripCharges(buyValue: number, sellValue: number, rates = CHARGE_RATES): Charges {
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
export function tradeCharges(trade: {
  qty: number;
  buy: { price: number };
  sell: { price: number } | null;
}): number {
  if (!trade.sell) return 0;
  return roundTripCharges(trade.buy.price * trade.qty, trade.sell.price * trade.qty).total;
}
