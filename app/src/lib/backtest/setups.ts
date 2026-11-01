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
  side: Side;
  /** A long is a bought call and a short a bought put — never a written option. */
  option: "CE" | "PE";
  description: string;
}

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
  return out.sort((a, b) => a.setup.localeCompare(b.setup));
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
