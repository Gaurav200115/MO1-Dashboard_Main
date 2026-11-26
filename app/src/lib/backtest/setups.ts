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
   * ("desk"), the ADR variant of them ("adr"), the pullback-stop variant
   * ("pullback-stop"), the daily-loss-limit variant ("adr-daily-loss"), the
   * per-pivot skew variant ("adr-pivot-skew"), the 3-a-day / ₹35k variant
   * ("cap-35k"), B alone on ₹35k ("b-35k"), the ATR-stop variants ("atr-stop",
   * "atr-stop-600"), or NIFTY's opening range ("nifty"). Mirrors `book_of` in backtest/strategies.py.
   */
  book: string;
  /** A short label shown beside the leg, e.g. what a variant changes. */
  tag?: string;
  /**
   * What the leg trades: the NIFTY 200 stock options (the default) or NIFTY's
   * own weekly options. The backtest page picks the instrument first and lists
   * only that instrument's legs.
   */
  instrument?: Instrument;
}

export type Instrument = "STOCKS" | "NIFTY";

export function instrumentOf(s: SetupOption): Instrument {
  return s.instrument ?? "STOCKS";
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
    instrument: "NIFTY",
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
   *
   * Went live unchanged on 2026-11-15 as long v9 / short v5, so A, B and C now
   * replay this same rule. These stay as the record of what was backtested.
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
      "one step behind. Same rule as live setup A since long v9.",
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
      "behind. Same rule as live setup B since long v9.",
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
      "+1R, then one step behind. Same rule as live setup C since short v5.",
    backtestOnly: true,
    book: "adr",
    tag: "ADR · SL 1:2→1",
  },

  /*
   * The pullback stop (2026-11-15). The live ADR entry unchanged; setups A and C
   * stop where the setup is proven wrong instead of a fixed ₹550 of premium —
   * the stock back at the pullback's low (A) or the rally's high (C). R is what
   * that costs at 1 lot (distance × 0.5 delta × lot), raised to ₹550 when
   * smaller; over ₹800 the trade is skipped. The 1:2 ladder steps in that R, and
   * a 1.5R premium backstop stands in for the exchange SL. B has no pullback, so
   * B-PB is B on the fixed ₹550.
   *
   * Python: `BREAKOUT_RETRACE_21EMA_PB` / `BREAKDOWN_RETRACE_21EMA_PB` in
   * backtest/strategies.py; tests/test_pullback.py checks these three entries match.
   */
  {
    setup: "A-PB",
    strategy: "breakout-retrace-21ema-pbsl",
    strategyName: "Level Break → 21 EMA Retrace [ADR, SL pullback ₹550–800]",
    version: 1,
    label: "Break & retrace",
    side: "LONG",
    option: "CE",
    description:
      "Live setup A's ADR entry. Stop: the stock back at the pullback low, sized at 1 lot " +
      "(distance × 0.5 × lot), raised to ₹550, skipped over ₹800. SL trails from 1:2 to +1R " +
      "in that R; 1.5R premium backstop.",
    backtestOnly: true,
    book: "pullback-stop",
    tag: "SL pullback ₹550–800",
  },
  {
    setup: "B-PB",
    strategy: "breakout-retrace-21ema-pbsl",
    strategyName: "Level Break → 21 EMA Retrace [ADR, SL pullback ₹550–800]",
    version: 1,
    label: "Support hold & level cross",
    side: "LONG",
    option: "CE",
    description:
      "Setup B unchanged on the fixed ₹550 stop — it fires on a level cross and has no " +
      "pullback low. In the run so the three legs share the three-position cap as they do live.",
    backtestOnly: true,
    book: "pullback-stop",
    tag: "SL pullback ₹550–800",
  },
  {
    setup: "C-PB",
    strategy: "breakdown-retrace-21ema-pbsl",
    strategyName: "Support Break → 21 EMA Retrace (Short) [ADR, SL pullback ₹550–800]",
    version: 1,
    label: "Breakdown & retrace",
    side: "SHORT",
    option: "PE",
    description:
      "Live setup C's ADR entry. Stop: the stock back at the rally high, sized at 1 lot " +
      "(distance × 0.5 × lot), raised to ₹550, skipped over ₹800. SL trails from 1:2 to +1R " +
      "in that R; 1.5R premium backstop.",
    backtestOnly: true,
    book: "pullback-stop",
    tag: "SL pullback ₹550–800",
  },

  /*
   * ADR with a daily loss limit (2026-11-15). The live ADR rule (long v9 /
   * short v5) exactly — ₹550 stop, 1:2 → +1R ladder — plus one addition: once
   * the day's net P&L on closed trades is down ₹1,700, no new trade that day.
   * Wins offset losses; trades already open run on under their own stops.
   *
   * Python: `BREAKOUT_RETRACE_21EMA_DL` / `BREAKDOWN_RETRACE_21EMA_DL` in
   * backtest/strategies.py; tests/test_daily_loss.py checks these three entries match.
   */
  {
    setup: "A-DL",
    strategy: "breakout-retrace-21ema-adr-dll",
    strategyName: "Level Break → 21 EMA Retrace [ADR, SL 550, day stop 1700]",
    version: 1,
    label: "Break & retrace",
    side: "LONG",
    option: "CE",
    description:
      "Live setup A (ADR retrace, ₹550 SL, 1:2 → +1R ladder). No new trades once the day's net " +
      "P&L on closed trades is down ₹1,700; open trades run on.",
    backtestOnly: true,
    book: "adr-daily-loss",
    tag: "ADR · day stop ₹1,700",
  },
  {
    setup: "B-DL",
    strategy: "breakout-retrace-21ema-adr-dll",
    strategyName: "Level Break → 21 EMA Retrace [ADR, SL 550, day stop 1700]",
    version: 1,
    label: "Support hold & level cross",
    side: "LONG",
    option: "CE",
    description:
      "Live setup B (₹550 SL, 1:2 → +1R ladder), under the same ₹1,700 daily loss limit as A " +
      "and C — the limit is on the whole day, all three legs together.",
    backtestOnly: true,
    book: "adr-daily-loss",
    tag: "ADR · day stop ₹1,700",
  },
  {
    setup: "C-DL",
    strategy: "breakdown-retrace-21ema-adr-dll",
    strategyName: "Support Break → 21 EMA Retrace (Short) [ADR, SL 550, day stop 1700]",
    version: 1,
    label: "Breakdown & retrace",
    side: "SHORT",
    option: "PE",
    description:
      "Live setup C (ADR retrace, ₹550 SL, 1:2 → +1R ladder). No new trades once the day's net " +
      "P&L on closed trades is down ₹1,700; open trades run on.",
    backtestOnly: true,
    book: "adr-daily-loss",
    tag: "ADR · day stop ₹1,700",
  },

  /*
   * ADR with a skew threshold per pivot (2026-11-15). The ADR rule, except how
   * each stock's major level is picked: R1, R3, S1 and S3 need a skew of 5x or
   * more, R2, S2 and P qualify at any skew, and the closest-gap qualifying level
   * wins (v9 / v5: 4x for any resistance, 5x for any support). Setup B's crossed
   * levels are unchanged.
   *
   * Went live unchanged on 2026-11-15 as long v10 / short v6; v11 / v7 then added
   * only the step-cost gate. v2 (2026-11-23, backtest only): the stop moves to the
   * entry price once the trade is up 1.5R - cost to cost. -CAP / -35K v2 too.
   *
   * Python: `BREAKOUT_RETRACE_21EMA_SK` / `BREAKDOWN_RETRACE_21EMA_SK` in
   * backtest/strategies.py; tests/test_pivot_skew.py checks these three entries match.
   */
  {
    setup: "A-SK",
    strategy: "breakout-retrace-21ema-adr-pskew",
    strategyName: "Level Break → 21 EMA Retrace [ADR, skew 5x R1/R3/S1/S3]",
    version: 2,
    label: "Break & retrace",
    side: "LONG",
    option: "CE",
    description:
      "Live setup A, but the major resistance needs 5x skew if it is R1 or R3, and any skew if " +
      "it is R2 or P; closest gap wins. ADR retrace, ₹550 SL, 1:2 → +1R ladder. v2: SL to cost once up 1.5R.",
    backtestOnly: true,
    book: "adr-pivot-skew",
    tag: "ADR · skew 5x R1/R3/S1/S3 · BE 1.5R",
  },
  {
    setup: "B-SK",
    strategy: "breakout-retrace-21ema-adr-pskew",
    strategyName: "Level Break → 21 EMA Retrace [ADR, skew 5x R1/R3/S1/S3]",
    version: 2,
    label: "Support hold & level cross",
    side: "LONG",
    option: "CE",
    description:
      "Live setup B: still crosses any confirmed level at any skew. The support it holds above " +
      "is the major support under the per-pivot rule (5x for S1/S3, any skew for S2/P). v2: SL to cost once up 1.5R.",
    backtestOnly: true,
    book: "adr-pivot-skew",
    tag: "ADR · skew 5x R1/R3/S1/S3 · BE 1.5R",
  },
  {
    setup: "C-SK",
    strategy: "breakdown-retrace-21ema-adr-pskew",
    strategyName: "Support Break → 21 EMA Retrace (Short) [ADR, skew 5x R1/R3/S1/S3]",
    version: 2,
    label: "Breakdown & retrace",
    side: "SHORT",
    option: "PE",
    description:
      "Live setup C, but the major support needs 5x skew if it is S1 or S3, and any skew if " +
      "it is S2 or P; closest gap wins. ADR retrace, ₹550 SL, 1:2 → +1R ladder. v2: SL to cost once up 1.5R.",
    backtestOnly: true,
    book: "adr-pivot-skew",
    tag: "ADR · skew 5x R1/R3/S1/S3 · BE 1.5R",
  },

  /*
   * The live A, B and C on NIFTY (2026-11-21). Long v11 / short v7 run on NIFTY's
   * weekly options instead of the stocks: pivots from NIFTY's previous session,
   * confirmed by the NIFTY weekly chain's OI; ADR from NIFTY's own range; 21 EMA
   * on 5-minute bars. R is ₹650 (1:2 target ₹1,300, ladder in ₹650 steps). v2
   * (2026-11-23): A, B and C each trade at most once a day, only when the setup
   * forms; max 3 open. (v1 re-armed after every signal.) Expiry day trades the
   * expiring weekly.
   *
   * Python: `NIFTY_BREAKOUT_RETRACE_21EMA` / `NIFTY_BREAKDOWN_RETRACE_21EMA` in
   * backtest/strategies.py; tests/test_nifty_abc.py checks these three entries match.
   */
  {
    setup: "A-NIFTY",
    strategy: "nifty-breakout-retrace-21ema",
    strategyName: "NIFTY Level Break → 21 EMA Retrace [NIFTY weekly, R 650, 1 per setup/day]",
    version: 2,
    label: "Break & retrace",
    side: "LONG",
    option: "CE",
    description:
      "Live setup A on NIFTY: breaks NIFTY's major resistance (pivots + weekly-chain OI), " +
      "retraces to the 5-min 21 EMA, enters on the ADR turn. ATM weekly call, ₹650 SL, " +
      "1:2 → +1R ladder. At most one A trade a day, only when the setup forms.",
    backtestOnly: true,
    book: "nifty-abc",
    tag: "NIFTY · R ₹650 · 1 per setup/day",
    instrument: "NIFTY",
  },
  {
    setup: "B-NIFTY",
    strategy: "nifty-breakout-retrace-21ema",
    strategyName: "NIFTY Level Break → 21 EMA Retrace [NIFTY weekly, R 650, 1 per setup/day]",
    version: 2,
    label: "Support hold & level cross",
    side: "LONG",
    option: "CE",
    description:
      "Live setup B on NIFTY: holding above the major support, crosses another confirmed level " +
      "above the 21 EMA. ATM weekly call, ₹650 SL. At most one B trade a day.",
    backtestOnly: true,
    book: "nifty-abc",
    tag: "NIFTY · R ₹650 · 1 per setup/day",
    instrument: "NIFTY",
  },
  {
    setup: "C-NIFTY",
    strategy: "nifty-breakdown-retrace-21ema",
    strategyName: "NIFTY Support Break → 21 EMA Retrace (Short) [NIFTY weekly, R 650, 1 per setup/day]",
    version: 2,
    label: "Breakdown & retrace",
    side: "SHORT",
    option: "PE",
    description:
      "Live setup C on NIFTY: breaks the major support, rallies to the 5-min 21 EMA, enters on " +
      "the ADR roll-over. ATM weekly put, ₹650 SL, 1:2 → +1R ladder. At most one C trade a day.",
    backtestOnly: true,
    book: "nifty-abc",
    tag: "NIFTY · R ₹650 · 1 per setup/day",
    instrument: "NIFTY",
  },

  /*
   * Fewer trades, less drawdown (2026-11-23). Both on the live long v11 / short v7
   * rule unchanged, both under a ₹35,000 budget: a signal whose premium plus the
   * premium already in open trades would go over ₹35k is skipped (open trades are
   * never closed to make room) and does not count toward the day. Max 3 open.
   *   -CAP  A, B, C: at most 3 entries a day across all three, none from 10:30.
   *   -35K  B only, the normal day (till 13:00, the usual 15 a day).
   *
   * Python: `BREAKOUT_RETRACE_21EMA_CAP` / `BREAKDOWN_RETRACE_21EMA_CAP` /
   * `BREAKOUT_RETRACE_21EMA_B35K` in backtest/strategies.py;
   * tests/test_budget_cap.py checks these four entries match.
   */
  {
    setup: "A-CAP",
    strategy: "breakout-retrace-21ema-cap",
    strategyName: "Level Break → 21 EMA Retrace [3 a day till 10:30, ₹35k]",
    version: 2,
    label: "Break & retrace",
    side: "LONG",
    option: "CE",
    description:
      "Live setup A. At most 3 entries a day across A, B and C (first come), none from 10:30. " +
      "₹35k budget: a trade that would put more than ₹35k of premium in open trades is skipped. v2: SL to cost once up 1.5R.",
    backtestOnly: true,
    book: "cap-35k",
    tag: "3 a day till 10:30 · ₹35k · BE 1.5R",
  },
  {
    setup: "B-CAP",
    strategy: "breakout-retrace-21ema-cap",
    strategyName: "Level Break → 21 EMA Retrace [3 a day till 10:30, ₹35k]",
    version: 2,
    label: "Support hold & level cross",
    side: "LONG",
    option: "CE",
    description:
      "Live setup B. At most 3 entries a day across A, B and C (first come), none from 10:30. " +
      "₹35k budget: a trade that would put more than ₹35k of premium in open trades is skipped. v2: SL to cost once up 1.5R.",
    backtestOnly: true,
    book: "cap-35k",
    tag: "3 a day till 10:30 · ₹35k · BE 1.5R",
  },
  {
    setup: "C-CAP",
    strategy: "breakdown-retrace-21ema-cap",
    strategyName: "Support Break → 21 EMA Retrace (Short) [3 a day till 10:30, ₹35k]",
    version: 2,
    label: "Breakdown & retrace",
    side: "SHORT",
    option: "PE",
    description:
      "Live setup C. At most 3 entries a day across A, B and C (first come), none from 10:30. " +
      "₹35k budget: a trade that would put more than ₹35k of premium in open trades is skipped. v2: SL to cost once up 1.5R.",
    backtestOnly: true,
    book: "cap-35k",
    tag: "3 a day till 10:30 · ₹35k · BE 1.5R",
  },
  {
    setup: "B-35K",
    strategy: "breakout-retrace-21ema-b35k",
    strategyName: "Support Hold → Level Cross [B only, ₹35k]",
    version: 2,
    label: "Support hold & level cross",
    side: "LONG",
    option: "CE",
    description:
      "Live setup B alone, the normal day (entries till 13:00). ₹35k budget: a trade that would " +
      "put more than ₹35k of premium in open trades is skipped. Max 3 open. v2: SL to cost once up 1.5R.",
    backtestOnly: true,
    book: "b-35k",
    tag: "B only · ₹35k · BE 1.5R",
  },

  /*
   * The -SK legs with an ATR stop (2026-11-25). Entries are A/B/C-SK v2 exactly;
   * the SL is the stock's ATR(14) on 5-minute bars / 3, applied straight to the
   * option premium in points, so R = ATR/3 × lot - no ₹550, no floor, no ceiling.
   *   -ATR     ladder in the trade's own R: cost at +1.5R, +1R at +2R, then one behind
   *   -ATR600  the same ladder in fixed ₹600 steps: cost at +900, +600 at +1,200 ...
   *
   * Python: `BREAKOUT_RETRACE_21EMA_ATR` / `_ATR600` and the BREAKDOWN pair in
   * backtest/strategies.py; tests/test_atr_stop.py checks these six entries match.
   */
  {
    setup: "A-ATR",
    strategy: "breakout-retrace-21ema-atr",
    strategyName: "Level Break → 21 EMA Retrace [ATR/3 SL, ladder in own R]",
    version: 1,
    label: "Break & retrace",
    side: "LONG",
    option: "CE",
    description:
      "Setup A-SK (per-pivot skew, ADR retrace). " +
      "SL = the stock's 5-min ATR(14) / 3, in option premium points (ATR 14.40 → SL 4.80 under the fill); R = that × lot. No ₹550. " +
      "Ladder in the trade's own R: SL to cost at +1.5R, +1R locked at +2R, then one rung behind.",
    backtestOnly: true,
    book: "atr-stop",
    tag: "ATR/3 SL · ladder in own R · BE 1.5R",
  },
  {
    setup: "B-ATR",
    strategy: "breakout-retrace-21ema-atr",
    strategyName: "Level Break → 21 EMA Retrace [ATR/3 SL, ladder in own R]",
    version: 1,
    label: "Support hold & level cross",
    side: "LONG",
    option: "CE",
    description:
      "Setup B-SK. " +
      "SL = the stock's 5-min ATR(14) / 3, in option premium points (ATR 14.40 → SL 4.80 under the fill); R = that × lot. No ₹550. " +
      "Ladder in the trade's own R: SL to cost at +1.5R, +1R locked at +2R, then one rung behind.",
    backtestOnly: true,
    book: "atr-stop",
    tag: "ATR/3 SL · ladder in own R · BE 1.5R",
  },
  {
    setup: "C-ATR",
    strategy: "breakdown-retrace-21ema-atr",
    strategyName: "Support Break → 21 EMA Retrace (Short) [ATR/3 SL, ladder in own R]",
    version: 1,
    label: "Breakdown & retrace",
    side: "SHORT",
    option: "PE",
    description:
      "Setup C-SK (per-pivot skew, ADR retrace). " +
      "SL = the stock's 5-min ATR(14) / 3, in option premium points (ATR 14.40 → SL 4.80 under the fill); R = that × lot. No ₹550. " +
      "Ladder in the trade's own R: SL to cost at +1.5R, +1R locked at +2R, then one rung behind.",
    backtestOnly: true,
    book: "atr-stop",
    tag: "ATR/3 SL · ladder in own R · BE 1.5R",
  },
  {
    setup: "A-ATR600",
    strategy: "breakout-retrace-21ema-atr600",
    strategyName: "Level Break → 21 EMA Retrace [ATR/3 SL, ladder Rs 600]",
    version: 1,
    label: "Break & retrace",
    side: "LONG",
    option: "CE",
    description:
      "Setup A-SK (per-pivot skew, ADR retrace). " +
      "SL = the stock's 5-min ATR(14) / 3, in option premium points (ATR 14.40 → SL 4.80 under the fill); R = that × lot. No ₹550. " +
      "Ladder in fixed ₹600 steps: SL to cost at +₹900, +₹600 locked at +₹1,200, then every +₹600.",
    backtestOnly: true,
    book: "atr-stop-600",
    tag: "ATR/3 SL · ladder ₹600 · BE ₹900",
  },
  {
    setup: "B-ATR600",
    strategy: "breakout-retrace-21ema-atr600",
    strategyName: "Level Break → 21 EMA Retrace [ATR/3 SL, ladder Rs 600]",
    version: 1,
    label: "Support hold & level cross",
    side: "LONG",
    option: "CE",
    description:
      "Setup B-SK. " +
      "SL = the stock's 5-min ATR(14) / 3, in option premium points (ATR 14.40 → SL 4.80 under the fill); R = that × lot. No ₹550. " +
      "Ladder in fixed ₹600 steps: SL to cost at +₹900, +₹600 locked at +₹1,200, then every +₹600.",
    backtestOnly: true,
    book: "atr-stop-600",
    tag: "ATR/3 SL · ladder ₹600 · BE ₹900",
  },
  {
    setup: "C-ATR600",
    strategy: "breakdown-retrace-21ema-atr600",
    strategyName: "Support Break → 21 EMA Retrace (Short) [ATR/3 SL, ladder Rs 600]",
    version: 1,
    label: "Breakdown & retrace",
    side: "SHORT",
    option: "PE",
    description:
      "Setup C-SK (per-pivot skew, ADR retrace). " +
      "SL = the stock's 5-min ATR(14) / 3, in option premium points (ATR 14.40 → SL 4.80 under the fill); R = that × lot. No ₹550. " +
      "Ladder in fixed ₹600 steps: SL to cost at +₹900, +₹600 locked at +₹1,200, then every +₹600.",
    backtestOnly: true,
    book: "atr-stop-600",
    tag: "ATR/3 SL · ladder ₹600 · BE ₹900",
  },

  /*
   * Two changes to setup A on the -ATR600 rule (2026-11-26). B and C are
   * -ATR600's unchanged, in the run so the legs share the three slots.
   *   -2X    A may trade a stock twice a day: after the first A trade closes, A
   *          needs a fresh break + retrace. B and C keep one a stock.
   *   -OEMA  A enters only if the ATM option is above its own 1-min 21 EMA at
   *          the moment A fires; otherwise the setup is lost for the day.
   *
   * Python: `BREAKOUT_RETRACE_21EMA_A2X` / `_AOEMA` and the BREAKDOWN pair in
   * backtest/strategies.py; tests/test_a_variants.py checks these six entries match.
   */
  {
    setup: "A-2X",
    strategy: "breakout-retrace-21ema-atr600-a2x",
    strategyName: "Level Break → 21 EMA Retrace [ATR600, A twice a stock]",
    version: 1,
    label: "Break & retrace",
    side: "LONG",
    option: "CE",
    description:
      "Setup A on ATR600, up to 2 trades a stock a day: once the first A trade closes, A re-arms and needs a " +
      "fresh break + retrace. ATR/3 SL, ₹600 ladder, cost at +₹900.",
    backtestOnly: true,
    book: "atr600-a2x",
    tag: "ATR600 · A ×2 a stock",
  },
  {
    setup: "B-2X",
    strategy: "breakout-retrace-21ema-atr600-a2x",
    strategyName: "Level Break → 21 EMA Retrace [ATR600, A twice a stock]",
    version: 1,
    label: "Support hold & level cross",
    side: "LONG",
    option: "CE",
    description:
      "Setup B-ATR600 unchanged (one a stock), run beside A-2X so the legs share the three slots.",
    backtestOnly: true,
    book: "atr600-a2x",
    tag: "ATR600 · A ×2 a stock",
  },
  {
    setup: "C-2X",
    strategy: "breakdown-retrace-21ema-atr600-a2x",
    strategyName: "Support Break → 21 EMA Retrace (Short) [ATR600, A twice a stock]",
    version: 1,
    label: "Breakdown & retrace",
    side: "SHORT",
    option: "PE",
    description:
      "Setup C-ATR600 unchanged (one a stock), run beside A-2X so the legs share the three slots.",
    backtestOnly: true,
    book: "atr600-a2x",
    tag: "ATR600 · A ×2 a stock",
  },
  {
    setup: "A-OEMA",
    strategy: "breakout-retrace-21ema-atr600-aoema",
    strategyName: "Level Break → 21 EMA Retrace [ATR600, A needs option > 1-min 21 EMA]",
    version: 1,
    label: "Break & retrace",
    side: "LONG",
    option: "CE",
    description:
      "Setup A on ATR600, but at the moment A would enter the ATM option must be above its own 1-min 21 EMA; " +
      "if not, the setup is lost for the day. ATR/3 SL, ₹600 ladder, cost at +₹900.",
    backtestOnly: true,
    book: "atr600-aoema",
    tag: "ATR600 · A option > 1m EMA",
  },
  {
    setup: "B-OEMA",
    strategy: "breakout-retrace-21ema-atr600-aoema",
    strategyName: "Level Break → 21 EMA Retrace [ATR600, A needs option > 1-min 21 EMA]",
    version: 1,
    label: "Support hold & level cross",
    side: "LONG",
    option: "CE",
    description:
      "Setup B-ATR600 unchanged (no option EMA check), run beside A-OEMA so the legs share the three slots.",
    backtestOnly: true,
    book: "atr600-aoema",
    tag: "ATR600 · A option > 1m EMA",
  },
  {
    setup: "C-OEMA",
    strategy: "breakdown-retrace-21ema-atr600-aoema",
    strategyName: "Support Break → 21 EMA Retrace (Short) [ATR600, A needs option > 1-min 21 EMA]",
    version: 1,
    label: "Breakdown & retrace",
    side: "SHORT",
    option: "PE",
    description:
      "Setup C-ATR600 unchanged (no option EMA check), run beside A-OEMA so the legs share the three slots.",
    backtestOnly: true,
    book: "atr600-aoema",
    tag: "ATR600 · A option > 1m EMA",
  },

  /*
   * Setup A with a wider ATR stop (2026-11-26). For A only: SL = the stock's
   * 5-min ATR / 2 (-ATR2) or / 1 (-ATR1) in premium points, no move to cost,
   * no new entry from 12:00. B and C are -ATR600's exactly.
   *
   * Python: `BREAKOUT_RETRACE_21EMA_ATR2` / `_ATR1` and the BREAKDOWN pair in
   * backtest/strategies.py; tests/test_a_wide.py checks these six entries match.
   */
  {
    setup: "A-ATR2",
    strategy: "breakout-retrace-21ema-atr600-a2",
    strategyName: "Level Break → 21 EMA Retrace [ATR600, A: SL ATR/2, no cost move, none after 12:00]",
    version: 1,
    label: "Break & retrace",
    side: "LONG",
    option: "CE",
    description:
      "Setup A on ATR600 with a wider SL: the stock's 5-min ATR / 2 in option premium points. No move to " +
      "cost (₹600 ladder from +₹1,200 kept), and no new A entry from 12:00.",
    backtestOnly: true,
    book: "atr600-a-atr2",
    tag: "ATR600 · A SL ATR/2 · no cost · A till 12:00",
  },
  {
    setup: "B-ATR2",
    strategy: "breakout-retrace-21ema-atr600-a2",
    strategyName: "Level Break → 21 EMA Retrace [ATR600, A: SL ATR/2, no cost move, none after 12:00]",
    version: 1,
    label: "Support hold & level cross",
    side: "LONG",
    option: "CE",
    description:
      "Setup B-ATR600 unchanged (ATR/3 SL, cost at +₹900, till 13:00), run beside A-ATR2 so the legs share the three slots.",
    backtestOnly: true,
    book: "atr600-a-atr2",
    tag: "ATR600 · A SL ATR/2 · no cost · A till 12:00",
  },
  {
    setup: "C-ATR2",
    strategy: "breakdown-retrace-21ema-atr600-a2",
    strategyName: "Support Break → 21 EMA Retrace (Short) [ATR600, A: SL ATR/2, no cost move, none after 12:00]",
    version: 1,
    label: "Breakdown & retrace",
    side: "SHORT",
    option: "PE",
    description:
      "Setup C-ATR600 unchanged (ATR/3 SL, cost at +₹900, till 13:00), run beside A-ATR2 so the legs share the three slots.",
    backtestOnly: true,
    book: "atr600-a-atr2",
    tag: "ATR600 · A SL ATR/2 · no cost · A till 12:00",
  },
  {
    setup: "A-ATR1",
    strategy: "breakout-retrace-21ema-atr600-a1",
    strategyName: "Level Break → 21 EMA Retrace [ATR600, A: SL ATR/1, no cost move, none after 12:00]",
    version: 1,
    label: "Break & retrace",
    side: "LONG",
    option: "CE",
    description:
      "Setup A on ATR600 with a wider SL: the stock's 5-min ATR / 1 in option premium points. No move to " +
      "cost (₹600 ladder from +₹1,200 kept), and no new A entry from 12:00.",
    backtestOnly: true,
    book: "atr600-a-atr1",
    tag: "ATR600 · A SL ATR/1 · no cost · A till 12:00",
  },
  {
    setup: "B-ATR1",
    strategy: "breakout-retrace-21ema-atr600-a1",
    strategyName: "Level Break → 21 EMA Retrace [ATR600, A: SL ATR/1, no cost move, none after 12:00]",
    version: 1,
    label: "Support hold & level cross",
    side: "LONG",
    option: "CE",
    description:
      "Setup B-ATR600 unchanged (ATR/3 SL, cost at +₹900, till 13:00), run beside A-ATR1 so the legs share the three slots.",
    backtestOnly: true,
    book: "atr600-a-atr1",
    tag: "ATR600 · A SL ATR/1 · no cost · A till 12:00",
  },
  {
    setup: "C-ATR1",
    strategy: "breakdown-retrace-21ema-atr600-a1",
    strategyName: "Support Break → 21 EMA Retrace (Short) [ATR600, A: SL ATR/1, no cost move, none after 12:00]",
    version: 1,
    label: "Breakdown & retrace",
    side: "SHORT",
    option: "PE",
    description:
      "Setup C-ATR600 unchanged (ATR/3 SL, cost at +₹900, till 13:00), run beside A-ATR1 so the legs share the three slots.",
    backtestOnly: true,
    book: "atr600-a-atr1",
    tag: "ATR600 · A SL ATR/1 · no cost · A till 12:00",
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
    return "A/B/C, its variants (-ADR, -PB, -DL, -SK, -CAP, -35K, -ATR, -ATR600, -2X, -OEMA, -ATR2, -ATR1) and the -NIFTY legs are alternatives, not additions — replay each set in a run of its own";
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
