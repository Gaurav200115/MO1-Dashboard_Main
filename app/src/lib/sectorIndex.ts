import type { FloatFactor } from "./float";
import { groupBySector, MIN_CONSTITUENTS } from "./sectors";
import type { Quote } from "./types";

/** Every index is rebased here at the previous close, so 1007.3 reads as +0.73%. */
export const BASE_LEVEL = 1000;

export interface SectorIndex {
  sector: string;
  /** Rebased to BASE_LEVEL at the previous close. */
  level: number;
  changePct: number;
  /** Members in the sector, and how many carried a usable live quote. */
  members: number;
  priced: number;
  /** Traded value so far today, in rupees crore. Null until volume arrives. */
  turnover: number | null;
  /** Heaviest constituent, which is the honest caveat on a weighted index. */
  top: { symbol: string; weightPct: number } | null;
}

/**
 * Free-float market-cap weighted, the method NSE and BSE use, computed live.
 *
 * The divisor formula every exchange publishes is
 *
 *     Index = Sum(shares * float * price) / Divisor
 *
 * and dividing it by its own previous-close value cancels the divisor, leaving a
 * weighted mean of constituent day-returns:
 *
 *     Index / PrevIndex = Sum(w * P / Pprev) / Sum(w),  w = shares * float * Pprev
 *
 * The two are algebraically identical, so what follows is the exact index, not
 * an approximation of it — and because `w` uses the previous close streamed from
 * the quote packet rather than a stored price, weights re-derive themselves every
 * morning without any daily job.
 *
 * A member with no live quote is left out of both sums rather than treated as
 * unchanged; carrying it at zero return would quietly drag the index toward flat.
 */
export function computeSectorIndices(
  companies: { symbol: string; sector: string }[],
  quotes: Record<string, Quote>,
  floats: Record<string, FloatFactor>
): Map<string, SectorIndex> {
  const indices = new Map<string, SectorIndex>();

  for (const [sector, members] of groupBySector(companies)) {
    if (members.length < MIN_CONSTITUENTS) continue;

    let weightSum = 0;
    let weightedReturn = 0;
    let turnover = 0;
    let sawVolume = false;
    let priced = 0;
    let top: { symbol: string; weight: number } | null = null;

    for (const member of members) {
      const quote = quotes[member.symbol];
      const factor = floats[member.symbol];
      if (!quote || !factor) continue;

      const prevClose = quote.ohlc?.close;
      if (prevClose == null || !Number.isFinite(prevClose) || prevClose <= 0) continue;
      if (!Number.isFinite(quote.ltp) || quote.ltp <= 0) continue;

      // shares are in crore and price in rupees, so the product is rupees crore.
      const weight = factor.shares * factor.float * prevClose;
      if (!Number.isFinite(weight) || weight <= 0) continue;

      weightSum += weight;
      weightedReturn += weight * (quote.ltp / prevClose);
      priced += 1;

      if (!top || weight > top.weight) top = { symbol: member.symbol, weight };

      if (quote.volume != null && quote.volume > 0) {
        // Volume-weighted average price is the right multiplier here — this is
        // traded value, not a snapshot. LTP stands in until the VWAP arrives.
        const price = quote.atp != null && quote.atp > 0 ? quote.atp : quote.ltp;
        turnover += (price * quote.volume) / 1e7;
        sawVolume = true;
      }
    }

    if (weightSum <= 0) {
      indices.set(sector, {
        sector,
        level: BASE_LEVEL,
        changePct: 0,
        members: members.length,
        priced: 0,
        turnover: null,
        top: null,
      });
      continue;
    }

    const ratio = weightedReturn / weightSum;

    indices.set(sector, {
      sector,
      level: BASE_LEVEL * ratio,
      changePct: (ratio - 1) * 100,
      members: members.length,
      priced,
      turnover: sawVolume ? turnover : null,
      top: top ? { symbol: top.symbol, weightPct: (top.weight / weightSum) * 100 } : null,
    });
  }

  return indices;
}
