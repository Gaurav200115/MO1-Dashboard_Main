import type { ExitReason, LadderStep, StrategyRisk, StrategyTrade } from "./types";

/**
 * Turning a rupee risk budget into premium levels, and walking the trailing
 * ladder.
 *
 * All of it is arithmetic on one number: the risk unit, R, expressed per unit of
 * the option rather than per trade. A 550 rupee budget on a 250-unit lot is
 * 2.20 of premium, so the stop sits 2.20 below the fill and every rung of the
 * ladder is another 2.20. Working in per-unit terms keeps the ladder identical
 * across stocks whose lot sizes differ by two orders of magnitude.
 */

/**
 * NSE quotes options in five-paise ticks, but nothing here is rounded to them.
 * These levels are thresholds a live premium is compared against, not orders
 * being placed — this desk has no order placement — so snapping them to a tick
 * would add error rather than remove it.
 */

export interface Sizing {
  qty: number;
  /** Rupees of premium per unit that the risk budget buys. */
  riskPerUnit: number;
  stop: number;
  target: number;
  /** True where the premium could not absorb a full R without going negative. */
  riskCapped: boolean;
}

/** A premium cannot trade below five paise, so that is the floor a stop can sit at. */
const PREMIUM_FLOOR = 0.05;

export function sizeTrade(entry: number, lotSize: number, risk: StrategyRisk): Sizing {
  const qty = lotSize * risk.lots;
  if (qty <= 0) throw new Error(`Cannot size a trade with qty ${qty}`);

  const riskPerUnit = risk.rupeesPerTrade / qty;
  const raw = entry - riskPerUnit;

  /*
   * A cheap premium can be worth less than the risk budget: 550 of risk on a
   * 1,250-unit lot is 0.44 per unit, which is fine, but 550 on a 100-unit lot is
   * 5.50, and an ATM premium of 4 cannot fall that far. The trade is still
   * taken — it simply risks the whole premium instead of the planned figure —
   * and the shortfall is recorded rather than quietly rounded away, because it
   * means that trade contributed less than a full R to the sample.
   */
  const riskCapped = raw <= PREMIUM_FLOOR;

  return {
    qty,
    riskPerUnit,
    stop: riskCapped ? PREMIUM_FLOOR : raw,
    target: entry + risk.rewardMultiple * riskPerUnit,
    riskCapped,
  };
}

/** Rupee profit at a given premium, for a long. */
export function profitAt(trade: Pick<StrategyTrade, "buy" | "qty">, premium: number): number {
  return (premium - trade.buy.price) * trade.qty;
}

/**
 * Stop and target in R-units for a given rung.
 *
 * Rung 1 is the opening position: stop one R below the fill, target at the
 * configured reward multiple. Every ratchet after that moves the stop to where
 * the target was, less one R, and pushes the target one R further out — which
 * for the 1:2 default reproduces the ladder exactly as specified: reaching
 * +2R sets the stop to +1R and the target to +3R, reaching +3R sets the stop to
 * +2R and the target to +4R, and so on.
 */
export function rungLevels(step: number, reward: number): { stopR: number; targetR: number } {
  if (step <= 1) return { stopR: -1, targetR: reward };
  // Rung n has been reached by touching the rung-(n-1) target, which sat at
  // (reward + n - 2) R.
  const reached = reward + step - 2;
  return { stopR: reached - 1, targetR: reached + 1 };
}

export interface Advance {
  stop: number;
  target: number;
  step: number;
  /** One entry per rung crossed — a gap can clear more than one at a time. */
  steps: LadderStep[];
}

/**
 * Walks the ladder forward to wherever the premium has reached.
 *
 * Loops rather than advancing a single rung, because the premium is sampled on a
 * poll: a fast move can clear two rungs between two reads, and stopping at the
 * first would leave the stop a full R behind where the rule says it should be.
 */
export function advanceLadder(
  trade: Pick<StrategyTrade, "buy" | "qty" | "step" | "stop" | "target" | "riskPerUnit">,
  premium: number,
  risk: StrategyRisk,
  at: number
): Advance | null {
  if (risk.trail === "single" && trade.step >= 2) return null;

  const entry = trade.buy.price;
  const unit = trade.riskPerUnit;
  let step = trade.step;
  let stop = trade.stop;
  let target = trade.target;
  const steps: LadderStep[] = [];

  // Bounded so a nonsensical premium — a bad tick, a zero unit — cannot spin.
  while (premium >= target && steps.length < 64) {
    step += 1;
    const { stopR, targetR } = rungLevels(step, risk.rewardMultiple);
    stop = entry + stopR * unit;
    target = entry + targetR * unit;
    steps.push({ at, step, stop, target, locked: stopR * risk.rupeesPerTrade });
    if (risk.trail === "single") break;
  }

  return steps.length > 0 ? { stop, target, step, steps } : null;
}

export type Verdict =
  | { action: "hold" }
  | { action: "trail"; advance: Advance }
  | { action: "exit"; reason: ExitReason };

/**
 * What to do with an open trade at the premium just read.
 *
 * The stop is checked before the ladder. Both cannot be true of one premium, but
 * the order states the priority plainly: a trade is never ratcheted on the same
 * read that takes it out.
 *
 * Monitoring uses the last traded price while the fill itself crosses the
 * spread. That is how it actually happens — the stop triggers on a print, and
 * what you get is the bid — and keeping the two apart is what stops the blotter
 * flattering itself by half a spread on every exit.
 */
export function evaluate(
  trade: Pick<
    StrategyTrade,
    "buy" | "qty" | "step" | "stop" | "target" | "riskPerUnit" | "status"
  >,
  last: number,
  risk: StrategyRisk,
  at: number
): Verdict {
  if (trade.status !== "open") return { action: "hold" };

  if (last <= trade.stop) {
    return { action: "exit", reason: trade.step >= 2 ? "trail-stop" : "stop" };
  }

  // In single-ratchet mode the target is a real exit once the one ratchet is
  // spent. In ladder mode it is only ever the trigger for the next rung, so the
  // trade can be closed by nothing but its trailing stop.
  if (risk.trail === "single" && trade.step >= 2 && last >= trade.target) {
    return { action: "exit", reason: "trail-stop" };
  }

  const advance = advanceLadder(trade, last, risk, at);
  return advance ? { action: "trail", advance } : { action: "hold" };
}
