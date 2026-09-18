import { BENCHMARK, type SectorBar, type SectorSeries } from "./types";

/**
 * Sector rotation, computed off the stored chain.
 *
 * Rotation is a relative question, never an absolute one. In a month where the
 * market falls 6%, a sector down 2% is the leadership — reading the raw column
 * would have you sell it. So everything here is measured against the in-house
 * whole-universe benchmark, and the raw returns are carried only as context.
 *
 * Three views of the same thing, because each answers a different question:
 *
 *   Relative return    Who has won, over 1w / 1m / 3m / 6m. Backward-looking and
 *                      the one everyone quotes. Says nothing about whether the
 *                      lead is still widening.
 *
 *   RS-Ratio and       Where a sector sits in the cycle and which way it is
 *   RS-Momentum        travelling. This is the Relative Rotation Graph, and it
 *                      is the reason rotation is worth tracking at all: money
 *                      leaves a leader long before its trailing return stops
 *                      looking good.
 *
 *   Breadth and        Whether the move is the whole sector or its two heaviest
 *   turnover share     names, and whether real money is behind it. A sector
 *                      leading on relative return with breadth at 20% is one
 *                      stock wearing a sector costume.
 *
 * The RRG quadrants rotate CLOCKWISE and that ordering is the whole model:
 *
 *   Improving -> Leading -> Weakening -> Lagging -> Improving
 *   (bottom-left) (top-right) (bottom-right... )
 *
 *   Leading    ratio >= 100, momentum >= 100   outperforming and still gaining
 *   Weakening  ratio >= 100, momentum <  100   still ahead, but the lead is
 *                                              shrinking — first exit signal
 *   Lagging    ratio <  100, momentum <  100   behind and falling further
 *   Improving  ratio <  100, momentum >= 100   still behind, but closing —
 *                                              first entry signal
 *
 * The trade is at the two hinges, not in the middle: buy in Improving before
 * the trailing return confirms it, trim in Weakening while it still looks good.
 * A sector that crosses back into the quadrant it came from without completing
 * the loop is a failed rotation, which is why the tail matters more than the
 * dot — a long, smooth clockwise tail is a real rotation, a short scribble near
 * the middle is noise.
 */

export type Quadrant = "leading" | "weakening" | "lagging" | "improving";

export const QUADRANT_LABEL: Record<Quadrant, string> = {
  leading: "Leading",
  weakening: "Weakening",
  lagging: "Lagging",
  improving: "Improving",
};

/**
 * Horizons in trading sessions. A month is 21 sessions rather than a calendar
 * month so the lookback is the same amount of *market* in every reading.
 */
export const HORIZONS = { d1: 1, w1: 5, m1: 21, m3: 63, m6: 126 } as const;
export type Horizon = keyof typeof HORIZONS;
export type Horizons<T> = Record<Horizon, T>;

/**
 * RRG parameters.
 *
 * The published JdK RS-Ratio and RS-Momentum formulas are proprietary, so this
 * is the accepted open replication: normalise the relative strength line and
 * its rate of change to a mean of 100 by z-scoring each over a trailing window.
 * It is not identical to a StockCharts RRG to two decimals; it puts sectors in
 * the same quadrants and rotates them in the same order, which is what the tool
 * is for. Anything read off it should be read as a quadrant and a direction,
 * never as a precise coordinate.
 *
 * A quarter of sessions for the normalising window: short enough that a regime
 * change shows up inside a few weeks, long enough that one gap day does not
 * throw a sector across a quadrant line.
 */
export const RS_WINDOW = 50;
/** Momentum is the change in RS-Ratio over two weeks, then normalised itself. */
export const MOM_LOOKBACK = 10;
/** Sessions of travel drawn behind each dot. Ten is one fortnight of rotation. */
export const TAIL_LENGTH = 10;

/** Sessions needed before the second z-score has a full window behind it. */
export const MIN_DEPTH = 2 * RS_WINDOW + MOM_LOOKBACK + TAIL_LENGTH;

export interface RotationPoint {
  date: string;
  rsRatio: number;
  rsMomentum: number;
}

export interface RotationRow {
  sector: string;
  /** Chained level and last session move, straight off the stored bar. */
  level: number;
  changePct: number;
  /** Total return over each horizon, in percent. */
  ret: Horizons<number | null>;
  /** Return minus the benchmark over the same window, in percentage points. */
  excess: Horizons<number | null>;

  rsRatio: number | null;
  rsMomentum: number | null;
  quadrant: Quadrant | null;
  /** How long it has been in that quadrant, in sessions. Capped at the tail. */
  sessionsInQuadrant: number | null;
  /**
   * Distance from the (100, 100) centre. Near zero is a sector doing nothing
   * relative to the market, whatever quadrant the sign happens to put it in.
   */
  distance: number | null;
  tail: RotationPoint[];

  /** Position on the excess ranking named by `rankedOn`, 1 = strongest. */
  rank: number;
  /** Places gained over the last week on that same measure. Positive is climbing. */
  rankChange: number | null;

  breadth: {
    above50Pct: number | null;
    above200Pct: number | null;
    /** Advancing minus declining constituents on the last session. */
    net: number;
  };

  turnover: number | null;
  /** Share of all sector turnover on the last session, in percent. */
  turnoverSharePct: number | null;
  /**
   * That share against its own 20-session average, in percentage points.
   * Positive is money arriving in the sector rather than merely price moving.
   */
  turnoverDriftPct: number | null;
}

export interface RotationView {
  asOf: string;
  depth: number;
  /**
   * The horizon the table is ranked on. Normally one month; a chain too young
   * for that window falls back, and the panel says so rather than presenting a
   * one-day ranking as if it were a rotation.
   */
  rankedOn: Horizon;
  /** False until there is enough history for the RRG coordinates to exist. */
  ready: boolean;
  benchmark: {
    level: number;
    changePct: number;
    ret: Horizons<number | null>;
    breadth: { above50Pct: number | null; above200Pct: number | null; net: number };
  };
  rows: RotationRow[];
  params: {
    rsWindow: number;
    momLookback: number;
    tail: number;
    horizons: typeof HORIZONS;
  };
}

/** Trailing z-score of `values` ending at `i`, or null while the window is short. */
function zAt(values: (number | null)[], i: number, window: number): number | null {
  if (i < window - 1) return null;

  let sum = 0;
  for (let k = i - window + 1; k <= i; k += 1) {
    const value = values[k];
    if (value == null || !Number.isFinite(value)) return null;
    sum += value;
  }
  const mean = sum / window;

  let variance = 0;
  for (let k = i - window + 1; k <= i; k += 1) variance += ((values[k] as number) - mean) ** 2;
  const sd = Math.sqrt(variance / window);

  // A flat relative-strength line has no dispersion to normalise against, so it
  // sits exactly at the centre rather than dividing by zero.
  if (!Number.isFinite(sd) || sd === 0) return 0;
  return ((values[i] as number) - mean) / sd;
}

function quadrantOf(ratio: number, momentum: number): Quadrant {
  if (ratio >= 100) return momentum >= 100 ? "leading" : "weakening";
  return momentum >= 100 ? "improving" : "lagging";
}

/** Total return over `back` sessions ending at `i`, in percent. */
function retOver(bars: SectorBar[], i: number, back: number): number | null {
  const from = i - back;
  if (from < 0) return null;
  const start = bars[from].level;
  if (!Number.isFinite(start) || start <= 0) return null;
  return (bars[i].level / start - 1) * 100;
}

function horizonReturns(bars: SectorBar[], i: number): Horizons<number | null> {
  return {
    d1: retOver(bars, i, HORIZONS.d1),
    w1: retOver(bars, i, HORIZONS.w1),
    m1: retOver(bars, i, HORIZONS.m1),
    m3: retOver(bars, i, HORIZONS.m3),
    m6: retOver(bars, i, HORIZONS.m6),
  };
}

function excessOf(
  sector: Horizons<number | null>,
  bench: Horizons<number | null>
): Horizons<number | null> {
  const out = {} as Horizons<number | null>;
  for (const key of Object.keys(HORIZONS) as Horizon[]) {
    const a = sector[key];
    const b = bench[key];
    out[key] = a == null || b == null ? null : a - b;
  }
  return out;
}

function pct(part: number | null, whole: number): number | null {
  if (part == null || whole <= 0) return null;
  return (part / whole) * 100;
}

/**
 * Aligns a sector to the benchmark calendar.
 *
 * A sector whose bars are one short — a constituent halted on the last session
 * cannot cause this, but a partially written file can — would otherwise be
 * compared against the wrong benchmark day, and every relative number after it
 * would be quietly off by a session.
 */
function alignedLevels(bars: SectorBar[], dates: string[]): (number | null)[] {
  const byDate = new Map(bars.map((bar) => [bar.date, bar.level]));
  return dates.map((date) => byDate.get(date) ?? null);
}

export function computeRotation(series: SectorSeries): RotationView | null {
  const dates = series.dates;
  const benchBars = series.sectors[BENCHMARK];
  if (!dates || dates.length === 0 || !benchBars || benchBars.length === 0) return null;

  const last = dates.length - 1;
  const benchLevels = alignedLevels(benchBars, dates);
  const benchRet = horizonReturns(benchBars, benchBars.length - 1);
  const benchLast = benchBars[benchBars.length - 1];

  const names = Object.keys(series.sectors).filter((name) => name !== BENCHMARK).sort();

  // Total turnover across sectors, for the share column. The benchmark is left
  // out of it — it is the same money counted a second time.
  const totalTurnover = names.reduce((sum, name) => {
    const bars = series.sectors[name];
    const bar = bars[bars.length - 1];
    return sum + (bar?.turnover ?? 0);
  }, 0);

  const rows: RotationRow[] = [];

  for (const name of names) {
    const bars = series.sectors[name];
    if (!bars || bars.length === 0) continue;
    const bar = bars[bars.length - 1];
    const levels = alignedLevels(bars, dates);

    /*
     * The relative strength line: sector level over benchmark level, scaled to
     * 100 at nothing in particular. Only its *shape* is used, since both the
     * z-score and the rate of change are invariant to the scale — which is what
     * makes it safe that the two chains share a base date but not a base value.
     */
    const rs: (number | null)[] = dates.map((_, i) => {
      const s = levels[i];
      const b = benchLevels[i];
      return s == null || b == null || b <= 0 ? null : (s / b) * 100;
    });

    const ratio: (number | null)[] = dates.map((_, i) => {
      const z = zAt(rs, i, RS_WINDOW);
      return z == null ? null : 100 + z;
    });

    const roc: (number | null)[] = dates.map((_, i) => {
      const now = ratio[i];
      const then = ratio[i - MOM_LOOKBACK];
      return now == null || then == null ? null : now - then;
    });

    const momentum: (number | null)[] = dates.map((_, i) => {
      const z = zAt(roc, i, RS_WINDOW);
      return z == null ? null : 100 + z;
    });

    const tail: RotationPoint[] = [];
    for (let i = Math.max(0, last - TAIL_LENGTH + 1); i <= last; i += 1) {
      const r = ratio[i];
      const m = momentum[i];
      if (r == null || m == null) continue;
      tail.push({ date: dates[i], rsRatio: r, rsMomentum: m });
    }

    const rsRatio = ratio[last];
    const rsMomentum = momentum[last];
    const quadrant = rsRatio != null && rsMomentum != null ? quadrantOf(rsRatio, rsMomentum) : null;

    let sessionsInQuadrant: number | null = null;
    if (quadrant) {
      sessionsInQuadrant = 0;
      for (let i = last; i >= 0; i -= 1) {
        const r = ratio[i];
        const m = momentum[i];
        if (r == null || m == null || quadrantOf(r, m) !== quadrant) break;
        sessionsInQuadrant += 1;
      }
    }

    const ret = horizonReturns(bars, bars.length - 1);

    // Turnover share against its own recent normal. Comparing a sector share to
    // another sector share says only that banks are bigger than media; comparing
    // it to its own average says money moved.
    const window = bars.slice(-20);
    const shares = window
      .map((row) => row.turnover)
      .filter((value): value is number => value != null && value > 0);
    const meanTurnover = shares.length > 0 ? shares.reduce((a, b) => a + b, 0) / shares.length : null;

    rows.push({
      sector: name,
      level: bar.level,
      changePct: bar.changePct,
      ret,
      excess: excessOf(ret, benchRet),
      rsRatio,
      rsMomentum,
      quadrant,
      sessionsInQuadrant,
      distance:
        rsRatio != null && rsMomentum != null
          ? Math.hypot(rsRatio - 100, rsMomentum - 100)
          : null,
      tail,
      rank: 0,
      rankChange: null,
      breadth: {
        above50Pct: pct(bar.above50, bar.priced),
        above200Pct: pct(bar.above200, bar.priced),
        net: bar.advances - bar.declines,
      },
      turnover: bar.turnover,
      turnoverSharePct: pct(bar.turnover, totalTurnover),
      turnoverDriftPct:
        bar.turnover != null && meanTurnover != null && meanTurnover > 0
          ? (bar.turnover / meanTurnover - 1) * 100
          : null,
    });
  }

  /*
   * Ranked on one-month excess return: long enough to be a rotation rather than
   * a single session, short enough to still be the current one.
   *
   * A young chain has no one-month window yet, and ranking on a column that is
   * null for every row leaves the table in whatever order the sectors happened
   * to be in — alphabetical, wearing rank numbers, which reads as a result. So
   * it falls back to the longest horizon the history can actually support and
   * says which one that was.
   */
  const rankedOn: Horizon =
    rows.some((row) => row.excess.m1 != null)
      ? "m1"
      : rows.some((row) => row.excess.w1 != null)
        ? "w1"
        : "d1";

  // Nulls last and in a fixed order — subtracting two infinities gives NaN, and
  // a NaN comparator leaves the array in its input order rather than sorting it.
  const ranked = [...rows].sort((a, b) => {
    const x = a.excess[rankedOn];
    const y = b.excess[rankedOn];
    if (x == null && y == null) return a.sector.localeCompare(b.sector);
    if (x == null) return 1;
    if (y == null) return -1;
    return y - x;
  });
  ranked.forEach((row, i) => {
    row.rank = i + 1;
  });

  /*
   * The rank a week ago, on the same measure — the column worth reading first,
   * since a sector climbing four places is rotating whether or not it has
   * reached the top of the table yet.
   */
  const back = HORIZONS[rankedOn];
  const weekAgo = last - HORIZONS.w1;
  if (weekAgo - back >= 0) {
    const then = names
      .map((name) => {
        const bars = series.sectors[name];
        const i = bars.findIndex((row) => row.date === dates[weekAgo]);
        if (i < 0) return null;
        const benchIndex = benchBars.findIndex((row) => row.date === dates[weekAgo]);
        if (benchIndex < 0) return null;
        const benchThen = retOver(benchBars, benchIndex, back);
        const own = retOver(bars, i, back);
        if (own == null || benchThen == null) return null;
        return { sector: name, excess: own - benchThen };
      })
      .filter((entry): entry is { sector: string; excess: number } => entry != null)
      .sort((a, b) => b.excess - a.excess);

    const previousRank = new Map(then.map((entry, i) => [entry.sector, i + 1]));
    for (const row of ranked) {
      const before = previousRank.get(row.sector);
      if (before != null) row.rankChange = before - row.rank;
    }
  }

  return {
    asOf: dates[last],
    depth: dates.length,
    rankedOn,
    ready: dates.length >= MIN_DEPTH,
    benchmark: {
      level: benchLast.level,
      changePct: benchLast.changePct,
      ret: benchRet,
      breadth: {
        above50Pct: pct(benchLast.above50, benchLast.priced),
        above200Pct: pct(benchLast.above200, benchLast.priced),
        net: benchLast.advances - benchLast.declines,
      },
    },
    rows: ranked,
    params: { rsWindow: RS_WINDOW, momLookback: MOM_LOOKBACK, tail: TAIL_LENGTH, horizons: HORIZONS },
  };
}
