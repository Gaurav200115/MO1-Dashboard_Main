/**
 * Exponential moving average, carried forward one bar at a time.
 *
 * Seeded with a simple average of the first `period` closes, which is the
 * convention every charting package uses — including the one the rule was
 * presumably eyeballed on. Seeding from the first close instead would leave the
 * line visibly off for the first fifty bars, and on a 5-minute chart that is
 * most of a session.
 *
 * Deliberately incremental rather than recomputed over a window: the engine
 * rolls this forward on every closed bar for every tracked symbol, and an EMA
 * has no fixed lookback to recompute over anyway.
 */
export class Ema {
  private value: number | null = null;
  private readonly seed: number[] = [];
  private readonly k: number;

  constructor(readonly period: number) {
    if (!Number.isInteger(period) || period < 2) {
      throw new Error(`EMA period must be an integer >= 2, got ${period}`);
    }
    this.k = 2 / (period + 1);
  }

  /** Null until `period` closes have been pushed. */
  current(): number | null {
    return this.value;
  }

  get ready(): boolean {
    return this.value !== null;
  }

  push(close: number): number | null {
    if (!Number.isFinite(close) || close <= 0) return this.value;

    if (this.value === null) {
      this.seed.push(close);
      if (this.seed.length < this.period) return null;
      this.value = this.seed.reduce((sum, v) => sum + v, 0) / this.seed.length;
      return this.value;
    }

    this.value = close * this.k + this.value * (1 - this.k);
    return this.value;
  }

  /** Bulk seed, for warming from history. Returns the resulting value. */
  seedFrom(closes: number[]): number | null {
    for (const close of closes) this.push(close);
    return this.value;
  }
}

/**
 * The whole EMA series for a list of closes — used by the backfill path, where
 * the value *as at* each historical bar is what is wanted, not just the latest.
 * Entries are null until the seed window fills.
 */
export function emaSeries(closes: number[], period: number): (number | null)[] {
  const ema = new Ema(period);
  return closes.map((close) => ema.push(close));
}

/** Distance from price to the EMA as a percentage of the EMA, unsigned. */
export function emaGapPct(price: number, ema: number): number {
  return (Math.abs(price - ema) / ema) * 100;
}

/**
 * "Near the 21 EMA". Two-sided on purpose: a pullback that wicks a few paise
 * through the line is the same event as one that stops on it, and a one-sided
 * test would take the first and reject the second.
 */
export function nearEma(price: number, ema: number, proximityPct: number): boolean {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(ema) || ema <= 0) return false;
  return emaGapPct(price, ema) <= proximityPct;
}
