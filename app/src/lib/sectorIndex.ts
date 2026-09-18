import type { FloatFactor } from "./float";
import { BASE_LEVEL, type ChainAnchor } from "./sector/types";
import { groupBySector, MIN_CONSTITUENTS } from "./sectors";
import type { Quote } from "./types";

export { BASE_LEVEL };

/**
 * Past this many days without a stored session the chain is not trustworthy as
 * "yesterday". Four covers a long weekend — Friday to Tuesday — without firing
 * on an ordinary one.
 */
const STALE_DAYS = 4;
const DAY_MS = 86_400_000;

export interface SectorIndex {
  sector: string;
  /**
   * Chained onto the stored previous close, so this is a real index level that
   * compounds across sessions. Falls back to BASE_LEVEL only when no history
   * has been built yet.
   */
  level: number;
  changePct: number;
  /** Session the level is chained onto, and its level. Null before any backfill. */
  chainedFrom: { date: string; level: number } | null;
  /** Members in the sector, and how many carried a usable live quote. */
  members: number;
  priced: number;
  /** Traded value so far today, in rupees crore. Null until volume arrives. */
  turnover: number | null;
  /** Heaviest constituent, which is the honest caveat on a weighted index. */
  top: { symbol: string; weightPct: number } | null;
}

/** True when the chain has not been extended recently enough to be yesterday. */
export function anchorIsStale(anchor: ChainAnchor | null, now = Date.now()): boolean {
  if (!anchor) return false;
  return now - Date.parse(`${anchor.date}T00:00:00.000Z`) > STALE_DAYS * DAY_MS;
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
 *
 * `anchor` is the last stored session from the chain on disk, and it is what
 * turns this from a day gauge into an index: the ratio is multiplied into
 * yesterday level rather than into a fresh 1,000. The two halves agree by
 * construction, because the stored chain multiplies exactly this ratio computed
 * from the same previous close — the one the quote packet carries in its OHLC
 * block, which is the official close the exchange finalised overnight.
 */
export function computeSectorIndices(
  companies: { symbol: string; sector: string }[],
  quotes: Record<string, Quote>,
  floats: Record<string, FloatFactor>,
  anchor?: ChainAnchor | null
): Map<string, SectorIndex> {
  const indices = new Map<string, SectorIndex>();

  for (const [sector, members] of groupBySector(companies)) {
    if (members.length < MIN_CONSTITUENTS) continue;

    const stored = anchor?.levels[sector];
    const base = stored != null && Number.isFinite(stored) && stored > 0 ? stored : BASE_LEVEL;
    const chainedFrom =
      anchor && stored != null ? { date: anchor.date, level: stored } : null;

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
        level: base,
        changePct: 0,
        chainedFrom,
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
      level: base * ratio,
      changePct: (ratio - 1) * 100,
      chainedFrom,
      members: members.length,
      priced,
      turnover: sawVolume ? turnover : null,
      top: top ? { symbol: top.symbol, weightPct: (top.weight / weightSum) * 100 } : null,
    });
  }

  return indices;
}
