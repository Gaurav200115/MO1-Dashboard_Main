/**
 * The strategy layer's vocabulary.
 *
 * Kept free of value imports from anything node-only, because both the API
 * routes and the blotter component read these shapes.
 *
 * The central idea: a *strategy definition* is an immutable, versioned record of
 * a rule, and every *trade* carries the id and version of the definition it was
 * taken under. Rules get tuned — a threshold moves, a window shortens — and once
 * that happens a blotter that only stored "strategy 1" can no longer tell you
 * which rule produced which result. Storing the version alongside each fill is
 * what keeps a season of trades honestly comparable.
 */

import type { PivotLabel } from "@/lib/eod/pivots";

export type Side = "LONG" | "SHORT";
export type OptionType = "CE" | "PE";

/** Which leg of a multi-part strategy fired. Free-form so later rules can add legs. */
export type SetupId = string;

export interface SetupDefinition {
  id: SetupId;
  label: string;
  side: Side;
  /**
   * Which major level this leg anchors on. Data rather than a branch in the
   * engine, so a strategy only warms and watches the stocks it could actually
   * trade — the short rule has no use for a stock that has a major resistance
   * and no major support, and seeding a 21 EMA for it is a wasted history call
   * against a 3 req/sec limit.
   */
  requires: "majorResistance" | "majorSupport";
  /** The entry condition in words, as specified. Shown on the trade row. */
  description: string;
}

export interface StrategyParams {
  emaPeriod: number;
  /** Candle size the EMA is computed on, in minutes. */
  emaIntervalMinutes: number;
  /**
   * How close to the EMA price must come for the pullback to count as a proper
   * retracement, as a percentage of the EMA. Measured either side, so a wick
   * through the line still counts as having reached it.
   */
  emaZonePct: number;
  /**
   * How far price must rebound off the low of that retracement before the entry
   * is taken, as a percentage of the low. This is the confirmation leg: touching
   * the EMA is the setup, turning back up off it is the trigger.
   */
  entryReboundPct: number;
  /** Minimum callOI/putOI for a resistance to count as major. */
  resistanceSkew: number;
  /** Minimum putOI/callOI for a support to count as major. */
  supportSkew: number;
  /** IST HH:MM after which no new entry is taken. Open trades keep running. */
  entryCutoffIst: string;
  /** IST HH:MM at which anything still open is closed at market. */
  flattenIst: string;
  /**
   * Positions that may be open at once. Enforced **across every running
   * strategy**, not per strategy — it is a limit on the desk's exposure, and one
   * account holding three longs and three shorts is holding six positions.
   * Carried on each definition so a stored trade records the cap it ran under.
   */
  maxOpenTrades: number;
  maxTradesPerDay: number;
  maxTradesPerSymbolPerDay: number;
}

export interface StrategyRisk {
  /** Risk budget per trade, in rupees. Sets the stop distance on the premium. */
  rupeesPerTrade: number;
  lots: number;
  /** Which strike relative to spot. ATM = the ladder strike nearest the price. */
  moneyness: "ATM";
  /** First checkpoint on the ladder, as a multiple of the risk. */
  rewardMultiple: number;
  /**
   * The multiple at which the stop first moves at all. Below this the trade runs
   * on its original stop — reaching 1:2 is progress, not a reason to tighten.
   */
  trailStartMultiple: number;
  /** Where the stop goes on that first move, as a multiple of the risk. */
  trailLockMultiple: number;
  /**
   * "ladder" — past the first move the stop follows one checkpoint behind, so
   * the trade can only ever be closed by its trailing stop.
   * "single" — one ratchet, then a hard target.
   */
  trail: "ladder" | "single";
}

export interface StrategyDefinition {
  id: string;
  /** Bumped whenever params or rules change. Trades pin to the version they ran under. */
  version: number;
  name: string;
  /**
   * The rule as it was given, verbatim, one line per clause. Never paraphrased —
   * this is what a trade is read back against months later, and a tidied-up
   * restatement is exactly how a rule quietly becomes a different rule.
   */
  spec: string[];
  setups: SetupDefinition[];
  params: StrategyParams;
  risk: StrategyRisk;
  /** ISO date the version was authored. */
  createdAt: string;
}

export interface TradeInstrument {
  tradingsymbol: string;
  strike: number;
  type: OptionType;
  expiry: string;
  lotSize: number;
}

/** The level that produced the signal, kept so a trade can be audited. */
export interface TriggerLevel {
  pivot: PivotLabel;
  kind: "support" | "resistance";
  /** The pivot price — the level itself. The strike only corroborated it. */
  value: number;
  strike: number;
  /** Dominant side over the other. Null where one side had no open interest. */
  skew: number | null;
  gapPct: number;
}

/** Where the pullback turned, and how far off the EMA that was. */
export interface Retracement {
  /**
   * The furthest point the pullback reached inside the EMA zone — its *low* for
   * a long, its *high* for a short. Named for what it is rather than for one
   * direction, because a field called `low` holding a high is how a sign error
   * survives code review.
   */
  extreme: number;
  /** Distance from that point to the EMA, as a percentage of the EMA. */
  emaGapPct: number;
  /** When price first entered the zone. */
  at: number;
  /** How far the turn off the extreme had gone when the entry was taken, in percent. */
  turnPct: number;
}

export interface TradeTrigger {
  setup: SetupId;
  /** Setup A: the resistance that was broken. Setup B: the level crossed. */
  level: TriggerLevel;
  /** Setup B only — the major support price had to be holding above. */
  basis: TriggerLevel | null;
  /** When price first crossed the level. Null when entry and cross coincide. */
  crossedAt: number | null;
  /** The 21 EMA at entry, from the last closed bar. */
  ema: number;
  /** Setup A only — the pullback the entry was taken off. Null for setup B. */
  retracement: Retracement | null;
  /** Underlying price at entry, as opposed to the option premium paid. */
  spot: number;
}

export type ExitReason =
  | "stop"
  | "trail-stop"
  | "eod-flatten"
  | "manual"
  | "no-quote";

/** One ratchet of the trailing ladder. */
export interface LadderStep {
  at: number;
  /** 2 is the first ratchet — the 1:2 that moves the stop to breakeven-plus-1R. */
  step: number;
  stop: number;
  target: number;
  /** Rupee profit the new stop locks in. */
  locked: number;
}

export interface Fill {
  price: number;
  at: number;
}

/**
 * One paper trade.
 *
 * `buy`, `sell`, `profit` and the timestamps on each fill are the record that
 * was asked for; everything else is the context needed to ask *why* a losing
 * week lost, which a blotter of four columns can never answer.
 */
export interface StrategyTrade {
  _id: string;
  strategyId: string;
  strategyVersion: number;
  /** Denormalised so a trade row can name its strategy without a join. */
  strategyName: string;
  setup: SetupId;
  setupLabel: string;

  /** IST date the trade was opened on — the blotter's grouping key. */
  tradingDate: string;
  symbol: string;
  side: Side;
  instrument: TradeInstrument;
  /** lots x lotSize. The multiplier every rupee figure here is derived from. */
  qty: number;

  buy: Fill;
  sell: (Fill & { reason: ExitReason }) | null;
  /** Rupees. Null while open. */
  profit: number | null;

  /** Live premium stop and target. Both move as the ladder ratchets. */
  stop: number;
  target: number;
  /** 1 until the first ratchet, then 2, 3, … */
  step: number;
  /** Rupees of premium per unit that the configured risk buys. */
  riskPerUnit: number;
  /**
   * True when the premium was cheaper than the risk budget, so the real stop is
   * the premium going to zero rather than the rupee figure asked for. Recorded
   * rather than silently accepted — it means the trade risked less than planned.
   */
  riskCapped: boolean;

  /** Last seen premium while open, so the blotter can show running P&L. */
  mtm: (Fill & { profit: number }) | null;
  status: "open" | "closed";
  ladder: LadderStep[];
  trigger: TradeTrigger;

  /** Always true here — this desk has no order placement. */
  paper: boolean;
  openedAt: Date;
  closedAt: Date | null;
}

/** Aggregate for one strategy on one day, for the blotter header. */
export interface TradeDaySummary {
  tradingDate: string;
  strategyId: string;
  strategyName: string;
  trades: number;
  open: number;
  wins: number;
  losses: number;
  profit: number;
}

/* --- Engine state, kept here rather than in engine.ts ----------------------
 *
 * engine.ts reaches for node:fs, mongodb and kiteconnect. The blotter renders
 * these shapes in the browser, and a value import from that module would drag
 * the whole server graph into the client bundle — the same reason eod/types.ts
 * exists apart from eod/report.ts.
 */

export type EngineStatus =
  | "idle"
  | "starting"
  | "running"
  | "no-session"
  | "no-levels"
  | "stopped"
  | "error";

export type PhaseA = "idle" | "below" | "crossed" | "retraced" | "spent";
export type PhaseB = "idle" | "watching" | "spent";
/** Setup C, the short: above the support, broken it, pulled back to the EMA. */
export type PhaseC = "idle" | "above" | "broken" | "retraced" | "spent";

export interface SymbolStatus {
  symbol: string;
  name: string;
  phaseA: PhaseA;
  phaseB: PhaseB;
  phaseC: PhaseC;
  note: string | null;
  ltp: number | null;
  ema: number | null;
  emaReady: boolean;
  majorResistance: number | null;
  majorSupport: number | null;
}

export interface EngineSnapshot {
  strategyId: string;
  strategyName: string;
  version: number;
  status: EngineStatus;
  detail: string | null;
  tradingDate: string | null;
  /** Session the levels being traded were derived from. */
  basedOn: string | null;
  watching: number;
  emaReady: number;
  entriesOpen: boolean;
  entryCutoffIst: string;
  openTrades: number;
  /** Positions open across every strategy, and the desk-wide cap on them. */
  deskOpenTrades: number;
  deskMaxOpen: number;
  tradesToday: number;
  lastSignalAt: number | null;
  /** Most recent notes, newest last — warm-up gaps, skipped entries, write failures. */
  errors: string[];
}
