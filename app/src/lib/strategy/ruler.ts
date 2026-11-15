import { nearEma } from "./ema";
import type { SymbolPlan } from "./levels";
import type { StrategyParams, TradeAdr } from "./types";

/**
 * What the retrace legs (setups A and C) measure their distances with.
 *
 * Four distances, whatever the ruler: how close to the 21 EMA counts as a
 * retrace, the minimum pullback off the post-break extreme, the turn that
 * triggers the entry, and how far a closed bar may sit through the EMA before
 * the setup is dead. signals.ts asks the ruler for each and never does the
 * arithmetic itself.
 *
 * Two rulers. The percent ruler is the rule up to long v8 / short v4 and keeps
 * its arithmetic exactly — the expressions are the ones signals.ts used, moved
 * here. The ADR ruler (long v9 / short v5 on) measures in the stock's own
 * average daily range, set once before the open.
 *
 * The backtest's twin is app/scripts/backtest/backtest/adr.py — PctRuler and
 * AdrRuler there are this file, line for line. Change one, change both.
 */
export interface Ruler {
  /** False only for the ADR ruler on a stock with no ADR: A and C cannot arm. */
  readonly ready: boolean;
  near(price: number, ema: number): boolean;
  closedBelowZone(close: number, ema: number): boolean;
  closedAboveZone(close: number, ema: number): boolean;
  /** Long: has price come down far enough off the high since the break? */
  pulledBack(high: number, price: number): boolean;
  /** Short: has price come up far enough off the low since the break? */
  rallied(low: number, price: number): boolean;
  triggerUp(low: number): number;
  triggerDown(high: number): number;
  /** What a trade stores about the band. Null under the percent rule. */
  record(): TradeAdr | null;
}

class PctRuler implements Ruler {
  readonly ready = true;
  private readonly zonePct: number;
  private readonly turnPct: number;

  constructor(params: StrategyParams) {
    if (params.emaZonePct == null || params.entryReboundPct == null) {
      throw new Error("percent rule needs emaZonePct and entryReboundPct");
    }
    this.zonePct = params.emaZonePct;
    this.turnPct = params.entryReboundPct;
  }

  near(price: number, ema: number): boolean {
    return nearEma(price, ema, this.zonePct);
  }

  closedBelowZone(close: number, ema: number): boolean {
    return close < ema * (1 - this.zonePct / 100);
  }

  closedAboveZone(close: number, ema: number): boolean {
    return close > ema * (1 + this.zonePct / 100);
  }

  pulledBack(high: number, price: number): boolean {
    if (high <= 0) return false;
    return ((high - price) / high) * 100 >= this.turnPct;
  }

  rallied(low: number, price: number): boolean {
    if (low <= 0) return false;
    return ((price - low) / low) * 100 >= this.turnPct;
  }

  triggerUp(low: number): number {
    return low * (1 + this.turnPct / 100);
  }

  triggerDown(high: number): number {
    return high * (1 - this.turnPct / 100);
  }

  record(): TradeAdr | null {
    return null;
  }
}

class AdrRuler implements Ruler {
  readonly ready: boolean;
  private readonly band: TradeAdr | null;

  constructor(plan: SymbolPlan, params: StrategyParams) {
    if (params.adrPeriod == null || params.adrZoneMultiple == null || params.adrTurnMultiple == null) {
      throw new Error("ADR rule needs adrPeriod, adrZoneMultiple and adrTurnMultiple");
    }
    const pct = plan.adrPct;
    this.ready = pct != null && pct > 0 && plan.close > 0;
    if (!this.ready || pct == null) {
      this.band = null;
      return;
    }
    // Rupees for the day, from the previous official close: fixed before the
    // open, so unlike the percent rule they do not drift with the EMA or with
    // the pullback's extreme during the session.
    const rupees = (pct / 100) * plan.close;
    this.band = {
      period: params.adrPeriod,
      pct,
      rupees,
      zone: params.adrZoneMultiple * rupees,
      turn: params.adrTurnMultiple * rupees,
      zoneMultiple: params.adrZoneMultiple,
      turnMultiple: params.adrTurnMultiple,
    };
  }

  private get zone(): number {
    return this.band?.zone ?? 0;
  }

  private get turn(): number {
    return this.band?.turn ?? 0;
  }

  near(price: number, ema: number): boolean {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(ema) || ema <= 0) return false;
    return Math.abs(price - ema) <= this.zone;
  }

  closedBelowZone(close: number, ema: number): boolean {
    return close < ema - this.zone;
  }

  closedAboveZone(close: number, ema: number): boolean {
    return close > ema + this.zone;
  }

  pulledBack(high: number, price: number): boolean {
    if (high <= 0) return false;
    return high - price >= this.turn;
  }

  rallied(low: number, price: number): boolean {
    if (low <= 0) return false;
    return price - low >= this.turn;
  }

  triggerUp(low: number): number {
    return low + this.turn;
  }

  triggerDown(high: number): number {
    return high - this.turn;
  }

  record(): TradeAdr | null {
    return this.band ? { ...this.band } : null;
  }
}

/** The ruler a strategy measures its entry with: ADR when it says so, percent otherwise. */
export function rulerFor(plan: SymbolPlan, params: StrategyParams): Ruler {
  return params.entryBasis === "adr" ? new AdrRuler(plan, params) : new PctRuler(params);
}

/** Does this strategy need an ADR for each stock it watches? */
export function usesAdr(params: StrategyParams): boolean {
  return params.entryBasis === "adr";
}
