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
  /**
   * Which book the leg trades on. A run holds exactly one: the desk's own legs
   * ("desk"), the ADR variant of them ("adr"), or NIFTY's opening range
   * ("nifty"). Mirrors `book_of` in backtest/strategies.py.
   */
  book: string;
  /** A short label shown beside the leg, e.g. what a variant changes. */
  tag?: string;
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
    book: "nifty",
  },

  /*
   * The ADR variant of the desk's three legs (2026-11-13). The live rules
   * measure the retrace in a fixed percent of price — within 0.4% of the 21 EMA
   * to arm, a 0.2% turn to enter. These measure both in the stock's own
   * 14-session average daily range: zone 0.15 ADR, turn 0.075 ADR, calibrated
   * so the median stock (ADR 2.72%) behaves as the live rule does. Everything
   * else is the live long v8 / short v4, including the SL trail — at 1:2 the SL
   * moves to +1R, then one step behind.
   *
   * Python: `BREAKOUT_RETRACE_21EMA_ADR` / `BREAKDOWN_RETRACE_21EMA_ADR` in
   * backtest/strategies.py; tests/test_adr.py checks these three entries match.
   */
  {
    setup: "A-ADR",
    strategy: "breakout-retrace-21ema-adr",
    strategyName: "Level Break → 21 EMA Retrace [ADR, SL 1:2→1]",
    version: 1,
    label: "Break & retrace",
    side: "LONG",
    option: "CE",
    description:
      "Setup A with the retrace measured in the stock's 14-session ADR: arms within 0.15 ADR " +
      "of the 21 EMA, enters on a 0.075 ADR turn off the low. SL trails from 1:2 to +1R, then " +
      "one step behind.",
    backtestOnly: true,
    book: "adr",
    tag: "ADR · SL 1:2→1",
  },
  {
    setup: "B-ADR",
    strategy: "breakout-retrace-21ema-adr",
    strategyName: "Level Break → 21 EMA Retrace [ADR, SL 1:2→1]",
    version: 1,
    label: "Support hold & level cross",
    side: "LONG",
    option: "CE",
    description:
      "Setup B unchanged — it has no retracement % to scale. In the ADR run so the three legs " +
      "share the three-position cap as they do live. SL trails from 1:2 to +1R, then one step " +
      "behind.",
    backtestOnly: true,
    book: "adr",
    tag: "ADR · SL 1:2→1",
  },
  {
    setup: "C-ADR",
    strategy: "breakdown-retrace-21ema-adr",
    strategyName: "Support Break → 21 EMA Retrace (Short) [ADR, SL 1:2→1]",
    version: 1,
    label: "Breakdown & retrace",
    side: "SHORT",
    option: "PE",
    description:
      "Setup C with the retrace measured in the stock's 14-session ADR: arms within 0.15 ADR " +
      "of the 21 EMA, enters on a 0.075 ADR turn off the rally high. SL trails from 1:2 to " +
      "+1R, then one step behind.",
    backtestOnly: true,
    book: "adr",
    tag: "ADR · SL 1:2→1",
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
        book: "desk",
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
  const books = new Set(
    setupIds.map((id) => all.find((s) => s.setup === id)?.book).filter(Boolean)
  );
  if (books.size > 1) {
    return "the ADR legs are an alternative to A, B and C, not an addition — replay them in a run of their own";
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
