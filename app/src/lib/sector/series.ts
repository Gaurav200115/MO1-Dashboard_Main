import type { FloatTable } from "@/lib/float";
import type { Candle } from "@/lib/kite/history";
import { istDateString } from "@/lib/kite/history";
import { groupBySector, MIN_CONSTITUENTS } from "@/lib/sectors";
import { BASE_LEVEL, BENCHMARK, type ChainAnchor, type SectorBar, type SectorSeries } from "./types";

/**
 * Builds the chained sector indices from daily candles.
 *
 * The live strip and this share one formula — see computeSectorIndices for why
 * a free-float market-cap index equals a weight-by-previous-close mean of
 * constituent returns. The only difference is what happens to the result: the
 * live strip multiplies the day ratio by a base of 1,000 and throws it away at
 * the close, while this multiplies it into the previous session level and keeps
 * it.
 *
 *     level_t = level_{t-1} * Sum(w_i * P_i,t / P_i,t-1) / Sum(w_i)
 *     w_i     = shares_i * float_i * P_i,t-1
 *
 * So 1,000 is a base date, not a daily reset: a sector that has compounded 18%
 * since the base reads 1,180, the way an index is supposed to.
 *
 * Deliberate limitation, because it changes how the history may be read: the
 * float factors and the membership list are *current*, applied backwards over
 * the whole window. A promoter who sold down in March is treated as having sold
 * a year ago, and a stock that entered the Nifty 200 in June is in the index
 * from the base date. Both are standard for an in-house index built off one
 * snapshot, and both bias it mildly toward whatever has done well lately. It is
 * honest for ranking sectors against each other, which is all rotation asks of
 * it. It is not a tradable index history.
 */

/**
 * Below this share of the universe reporting a candle, the date is not a trading
 * session — it is a handful of stale or mispublished rows. Without the check a
 * single bad candle date fabricates a session, and with it a fake index move.
 */
const QUORUM = 0.6;

/**
 * Daily moves beyond this are corporate actions, not prices. The widest NSE
 * price band is 20% and F&O names sit inside a 10% dynamic band, so nothing
 * genuine reaches 35%. Kite adjusts its daily candles for splits and bonuses so
 * this should never fire — it exists because if it ever does, one unadjusted
 * 1:10 split would print a -90% day into the permanent history of that sector.
 */
const MAX_DAILY_MOVE = 0.35;

/** Averages the breadth counts are measured against. */
const FAST_MA = 50;
const SLOW_MA = 200;

/**
 * The exchange closes at 15:30 IST; before this hour today candle is still
 * forming, so its close is a mid-session print. Same rule and same reason as
 * lastSettledCandle in eod/report.ts.
 */
const SESSION_SETTLED_HOUR_IST = 16;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface BuildInput {
  companies: { symbol: string; sector: string }[];
  /** Symbol -> daily candles, oldest first, as Kite returns them. */
  candles: Record<string, Candle[]>;
  floats: FloatTable;
  /**
   * Continue an existing chain instead of starting a new one. Only sessions
   * strictly after `seed.date` are emitted, and the first of them is chained
   * onto the seed levels — which is what makes the daily update and the
   * from-scratch backfill one code path.
   */
  seed?: ChainAnchor;
  now?: number;
}

export interface BuildResult {
  dates: string[];
  sectors: Record<string, SectorBar[]>;
  universe: number;
  droppedOutliers: number;
  /** Candle dates the quorum rule rejected, for the log. */
  rejectedDates: string[];
}

function istHour(now: number): number {
  return new Date(now + IST_OFFSET_MS).getUTCHours();
}

/** Mean of the last `n` closes, or null while the window is not full yet. */
function tailMean(values: number[], n: number): number | null {
  if (values.length < n) return null;
  let sum = 0;
  for (let i = values.length - n; i < values.length; i += 1) sum += values[i];
  return sum / n;
}

export function buildSeries(input: BuildInput): BuildResult {
  const now = input.now ?? Date.now();
  const today = istDateString(now);
  const settled = istHour(now) >= SESSION_SETTLED_HOUR_IST;

  const groups = groupBySector(input.companies);
  const indexed = [...groups.entries()].filter(([, members]) => members.length >= MIN_CONSTITUENTS);

  /*
   * The benchmark is the whole universe on the same method, not the published
   * Nifty 200. An in-house sector measured against an index built from a
   * different membership, a different float source and a different rebalancing
   * rule shows relative strength that is partly just the two constructions
   * disagreeing with each other. Built here, every basis point of relative
   * strength is the sectors actually diverging.
   */
  const universeMembers = input.companies.filter((company) => input.floats[company.symbol]);
  const books: [string, { symbol: string }[]][] = [[BENCHMARK, universeMembers], ...indexed];

  // date -> symbol -> candle, settled sessions only.
  const byDate = new Map<string, Map<string, Candle>>();
  const counted = new Set<string>();

  for (const [symbol, candles] of Object.entries(input.candles)) {
    if (!input.floats[symbol]) continue;
    counted.add(symbol);
    for (const candle of candles) {
      const date = istDateString(candle.t);
      if (date > today) continue;
      if (date === today && !settled) continue;
      if (!Number.isFinite(candle.c) || candle.c <= 0) continue;
      let row = byDate.get(date);
      if (!row) byDate.set(date, (row = new Map()));
      row.set(symbol, candle);
    }
  }

  const quorum = Math.max(20, Math.floor(counted.size * QUORUM));
  const allDates = [...byDate.keys()].sort();
  const rejectedDates = allDates.filter((date) => (byDate.get(date)?.size ?? 0) < quorum);
  const sessions = allDates.filter((date) => (byDate.get(date)?.size ?? 0) >= quorum);

  /*
   * Breadth needs each stock own moving average, so the averages are walked
   * across the whole calendar even when only the tail is being appended.
   * Otherwise the first day of a daily update would have three sessions behind
   * it and would report a breadth number that means nothing.
   */
  const closes = new Map<string, number[]>();
  const out: Record<string, SectorBar[]> = {};
  const running = new Map<string, number>();
  for (const [name] of books) {
    out[name] = [];
    running.set(name, input.seed?.levels[name] ?? BASE_LEVEL);
  }

  let droppedOutliers = 0;
  let previous: string | null = null;

  for (const date of sessions) {
    const row = byDate.get(date);
    if (!row) continue;

    // A resumed chain re-walks the history for its moving averages and emits
    // only what is new.
    const emit = input.seed == null || date > input.seed.date;
    const prevRow = previous == null ? null : byDate.get(previous);

    if (emit && prevRow) {
      for (const [name, members] of books) {
        let weightSum = 0;
        let weightedReturn = 0;
        let priced = 0;
        let advances = 0;
        let declines = 0;
        let above50 = 0;
        let above200 = 0;
        let deep50 = 0;
        let deep200 = 0;
        let turnover = 0;
        let sawVolume = false;

        for (const member of members) {
          const candle = row.get(member.symbol);
          const prevCandle = prevRow.get(member.symbol);
          const factor = input.floats[member.symbol];
          if (!candle || !prevCandle || !factor) continue;

          const ret = candle.c / prevCandle.c;
          if (!Number.isFinite(ret) || ret <= 0) continue;
          if (Math.abs(ret - 1) > MAX_DAILY_MOVE) {
            droppedOutliers += 1;
            continue;
          }

          // Shares in crore times a rupee price gives rupees crore.
          const weight = factor.shares * factor.float * prevCandle.c;
          if (!Number.isFinite(weight) || weight <= 0) continue;

          weightSum += weight;
          weightedReturn += weight * ret;
          priced += 1;
          if (ret > 1) advances += 1;
          else if (ret < 1) declines += 1;

          const history = closes.get(member.symbol);
          if (history) {
            const fast = tailMean(history, FAST_MA);
            if (fast != null) {
              deep50 += 1;
              if (candle.c > fast) above50 += 1;
            }
            const slow = tailMean(history, SLOW_MA);
            if (slow != null) {
              deep200 += 1;
              if (candle.c > slow) above200 += 1;
            }
          }

          if (candle.v > 0) {
            turnover += (candle.c * candle.v) / 1e7;
            sawVolume = true;
          }
        }

        const level = running.get(name) ?? BASE_LEVEL;
        const ratio = weightSum > 0 ? weightedReturn / weightSum : 1;
        const next = level * ratio;
        running.set(name, next);

        out[name].push({
          date,
          level: next,
          changePct: (ratio - 1) * 100,
          priced,
          members: members.length,
          advances,
          declines,
          above50: deep50 > 0 ? above50 : null,
          above200: deep200 > 0 ? above200 : null,
          turnover: sawVolume ? turnover : null,
        });
      }
    } else if (emit && !prevRow && input.seed == null) {
      /*
       * The base session. It has no previous close to return against, so it is
       * published flat at the base level rather than skipped — the chart needs
       * the anchor point, and a reader needs to see where 1,000 was set.
       */
      for (const [name, members] of books) {
        out[name].push({
          date,
          level: BASE_LEVEL,
          changePct: 0,
          priced: members.filter((member) => row.has(member.symbol)).length,
          members: members.length,
          advances: 0,
          declines: 0,
          above50: null,
          above200: null,
          turnover: null,
        });
      }
    }

    // Appended after the bar, so a stock own close is never inside the average
    // it is being compared against.
    for (const [symbol, candle] of row) {
      let history = closes.get(symbol);
      if (!history) closes.set(symbol, (history = []));
      history.push(candle.c);
      if (history.length > SLOW_MA) history.shift();
    }

    previous = date;
  }

  const emitted = out[BENCHMARK] ?? [];

  return {
    dates: emitted.map((bar) => bar.date),
    sectors: out,
    universe: counted.size,
    droppedOutliers,
    rejectedDates,
  };
}

/** Closing levels of the last stored session — what a live day chains onto. */
export function anchorOf(series: SectorSeries): ChainAnchor | null {
  const dates = series.dates;
  if (dates.length === 0) return null;
  const date = dates[dates.length - 1];

  const levels: Record<string, number> = {};
  for (const [name, bars] of Object.entries(series.sectors)) {
    const last = bars[bars.length - 1];
    if (last && last.date === date) levels[name] = last.level;
  }
  return { date, levels };
}
