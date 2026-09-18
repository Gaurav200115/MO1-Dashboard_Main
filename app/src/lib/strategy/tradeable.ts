import type { PremiumQuote } from "./options";
import type { LiquidityParams } from "./types";

/**
 * The pre-trade gate: is this contract worth touching at all?
 *
 * Added after a post-mortem of the first three sessions, where 9 of 36 trades
 * died inside ten seconds and between them accounted for the entire net loss —
 * the other 27 netted positive. Every one of the nine was booked at an entry
 * price far above where the contract was actually trading: SHREECEM filled at
 * 470.95 against a last traded price of 299.70, on a strike carrying 125
 * contracts of open interest against 11,625 at the fattest strike in its chain.
 *
 * Nothing had moved. There was simply no book, and the top-of-book ask was a
 * number nobody would ever have traded at. A 550 stop is around 4.5% of an ATM
 * premium, so an entry 57% above the market is eleven stops underwater before
 * the first tick — and the position is closed, correctly, at a catastrophic
 * loss the rule never authorised.
 *
 * So the rule is not what failed. The contract selection did. These checks are
 * deliberately about *the book*, not about the signal: a good setup on an
 * untradeable strike is not a trade.
 */

export type RejectReason =
  | "one-sided-book"
  | "ask-above-market"
  | "spread-too-wide"
  | "spread-eats-risk"
  | "never-traded"
  | "dead-strike";

export interface Tradeable {
  ok: true;
  /** What the entry would be filled at — the ask, having passed the checks. */
  entry: number;
  spread: number;
  /** Rupees the round trip costs at this spread, for one position. */
  spreadCost: number;
}

export interface NotTradeable {
  ok: false;
  reason: RejectReason;
  detail: string;
}

export interface BookInput {
  quote: PremiumQuote;
  /** lots x lotSize — what the spread gets multiplied by. */
  qty: number;
  /** Rupees of premium per unit that the risk budget buys. */
  riskPerUnit: number;
  params: LiquidityParams;
  /** Open interest at this strike on the traded side, from the overnight scan. */
  strikeOi: number | null;
  /** The fattest strike's open interest in the same chain and on the same side. */
  chainMaxOi: number | null;
  now?: number;
}

export function assessBook(input: BookInput): Tradeable | NotTradeable {
  const { quote, qty, riskPerUnit, params } = input;
  const now = input.now ?? Date.now();

  /*
   * Both sides or nothing. A missing side is not a wide book, it is an absent
   * one — and `fillPrice` falls back to the last traded price when a side is
   * missing, which quietly invents a fill at a price nobody is offering.
   */
  const { bid, ask } = quote;
  if (bid == null || ask == null || bid <= 0 || ask <= 0 || ask < bid) {
    return {
      ok: false,
      reason: "one-sided-book",
      detail: `book is ${bid == null ? "bidless" : ask == null ? "offerless" : `crossed (${bid}/${ask})`}`,
    };
  }

  /*
   * The check that would have stopped all nine. Only meaningful while the last
   * print is recent: on a contract that has not traded for an hour, `last` is
   * an old number and a legitimately repriced ask will look absurd against it.
   */
  const tradeAge = quote.lastTradeAt != null ? (now - quote.lastTradeAt) / 1000 : null;
  const lastIsFresh = tradeAge != null && tradeAge <= params.staleQuoteSec;
  if (lastIsFresh && quote.last > 0) {
    const overPct = ((ask - quote.last) / quote.last) * 100;
    if (overPct > params.maxAskOverLastPct) {
      return {
        ok: false,
        reason: "ask-above-market",
        detail: `ask ${ask.toFixed(2)} is ${overPct.toFixed(1)}% over a ${Math.round(
          tradeAge
        )}s-old print of ${quote.last.toFixed(2)}`,
      };
    }
  }

  const spread = ask - bid;
  const mid = (ask + bid) / 2;
  const spreadPct = (spread / mid) * 100;
  if (spreadPct > params.maxSpreadPct) {
    return {
      ok: false,
      reason: "spread-too-wide",
      detail: `${bid.toFixed(2)}/${ask.toFixed(2)} is ${spreadPct.toFixed(1)}% wide`,
    };
  }

  /*
   * The economic test rather than the cosmetic one.
   *
   * A 2% spread is cheap on a 500 rupee premium and ruinous on a 4 rupee one,
   * because the risk budget is a fixed 550 either way and the spread is paid on
   * `qty` units. Expressed per unit, the spread has to be small against the
   * distance to the stop — otherwise the position starts a meaningful fraction
   * of the way to being stopped out, and the 1:3 the rule is aiming for has to
   * clear that toll twice before it earns anything.
   */
  const spreadCost = spread * qty;
  const shareOfRisk = (spread / riskPerUnit) * 100;
  if (shareOfRisk > params.maxSpreadOfRiskPct) {
    return {
      ok: false,
      reason: "spread-eats-risk",
      detail: `round trip costs ₹${Math.round(spreadCost)}, ${shareOfRisk.toFixed(
        0
      )}% of the stop distance`,
    };
  }

  if (quote.volume != null && quote.volume <= 0) {
    return { ok: false, reason: "never-traded", detail: "no volume on this contract today" };
  }

  /*
   * Last net, and a floor rather than a quality filter — measured across the
   * same 36 trades, open-interest share barely separates winners from losers
   * (winners ran from 5% to 100%). What it does catch is the genuinely dead
   * strike: SHREECEM's 1% share is a different kind of object from a thin one.
   */
  if (input.strikeOi != null && input.chainMaxOi != null && input.chainMaxOi > 0) {
    const share = (input.strikeOi / input.chainMaxOi) * 100;
    if (share < params.minStrikeOiShare) {
      return {
        ok: false,
        reason: "dead-strike",
        detail: `open interest is ${share.toFixed(1)}% of the chain's heaviest strike`,
      };
    }
  }

  return { ok: true, entry: ask, spread, spreadCost };
}

/** Human-readable one-liner for the status panel. */
export function describeRejection(symbol: string, result: NotTradeable): string {
  return `${symbol}: skipped — ${result.reason} (${result.detail})`;
}
