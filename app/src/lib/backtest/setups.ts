import { activeStrategies } from "@/lib/strategy/registry";
import type { SetupId, Side } from "@/lib/strategy/types";

/**
 * The legs a backtest run can replay, derived from the registry rather than
 * listed again here.
 *
 * A run names setups, not strategies. The long rule is two legs joined by an
 * "OR" in its own spec — break a resistance and retrace (A), or hold a support
 * and cross a level (B) — and they are different trades with different reasons
 * for working. Bundled, there is no way to find out which of the two is
 * carrying the result. The short rule (C) was already a strategy of its own.
 *
 * This is a reporting split, not a rule change. Each leg still runs under its
 * own strategy's parameters and version; nothing in registry.ts moves. The
 * Python side mirrors this in `backtest/strategies.py:SETUPS`.
 */
export interface SetupOption {
  setup: SetupId;
  strategy: string;
  strategyName: string;
  version: number;
  label: string;
  /** BOTH: one leg that buys the call or the put, whichever way the range breaks. */
  side: Side | "BOTH";
  /** A long is a bought call and a short a bought put — never a written option. */
  option: "CE" | "PE" | "CE/PE";
  description: string;
  /** Never live — exists only to be backtested. */
  backtestOnly?: boolean;
  /** Replayed in a run of its own, never mixed with the desk's legs. */
  standalone?: boolean;
}

/**
 * Rules that are backtested and never traded. They are deliberately not in
 * registry.ts — that file is what the live engine runs — so they are listed
 * here instead. The Python side defines the same rule in
 * `backtest/strategies.py:NIFTY_ORB_15M`; the id, setup and version must match.
 */
const BACKTEST_ONLY: SetupOption[] = [
  {
    setup: "ORB",
    strategy: "nifty-orb-15m",
    strategyName: "NIFTY 15-min Opening Range Breakout",
    version: 1,
    label: "NIFTY opening range break",
    side: "BOTH",
    option: "CE/PE",
    description:
      "NIFTY 09:15–09:29 high/low. First 1-min close above the high buys the ATM call, below " +
      "the low the ATM put; one trade a day. Stop 15 premium points; at +15 it moves to +5, " +
      "then +5 for every further +5. Flat at 13:00.",
    backtestOnly: true,
    standalone: true,
  },
];

export function listSetups(): SetupOption[] {
  const out: SetupOption[] = [];
  for (const strategy of activeStrategies()) {
    for (const setup of strategy.setups) {
      out.push({
        setup: setup.id,
        strategy: strategy.id,
        strategyName: strategy.name,
        version: strategy.version,
        label: setup.label,
        side: setup.side,
        option: setup.side === "LONG" ? "CE" : "PE",
        description: setup.description,
      });
    }
  }
  out.sort((a, b) => a.setup.localeCompare(b.setup));
  return [...out, ...BACKTEST_ONLY];
}

/** Why a set of setups cannot be run together, or null when it can. */
export function mixError(setupIds: string[]): string | null {
  const all = listSetups();
  const alone = all.find((s) => s.standalone && setupIds.includes(s.setup));
  if (alone && new Set(setupIds).size > 1) {
    return `${alone.setup} runs on its own — replay it in a run of its own`;
  }
  return null;
}

export function isKnownSetup(id: string): boolean {
  return listSetups().some((s) => s.setup === id);
}

/** The strategies the named setups belong to. */
export function strategiesFor(setupIds: string[]): string[] {
  const all = listSetups();
  const ids = new Set<string>();
  for (const id of setupIds) {
    const found = all.find((s) => s.setup === id);
    if (found) ids.add(found.strategy);
  }
  return [...ids].sort();
}
