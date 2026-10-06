/**
 * Trade analysis over the paper-trade record: filter by any combination of
 * side, result, entry time, hold time, strategy, setup, exit, level… and then
 * slice the survivors every way that answers "where does the edge live?".
 *
 * Pure and client-safe (imports only ist.ts and types), because the panel
 * filters in the browser. A season of this desk's trades is hundreds of rows,
 * not millions; re-deriving on every filter change is cheaper than a round
 * trip, and keeps one definition of "win rate" for every view.
 *
 * Only CLOSED trades are analysed. An open position has no result yet, and
 * folding its mark into win rate would make the numbers move with the tape.
 */

import { istDate, istMinutes } from "./ist";
import type { StrategyTrade } from "./types";

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type Outcome = "WIN" | "LOSS" | "BE";
export type HoldKey = "le10s" | "10s1m" | "1to5m" | "5to15m" | "15to60m" | "gt60m";
export type NthKey = "1" | "2" | "3" | "4+";

export interface AnalysedTrade {
  trade: StrategyTrade;
  id: string;
  date: string;
  /** 0 = Sunday … 6 = Saturday, of the trading date. */
  dow: number;
  /** IST minutes since midnight at entry. */
  entryMin: number;
  holdSec: number;
  hold: HoldKey;
  profit: number;
  outcome: Outcome;
  /** Profit in units of the planned risk; null when the risk was zero. */
  r: number | null;
  /** Premium paid — the whole capital a bought option needs. */
  cost: number;
  /** 1-based position among the day's trades (all strategies), by entry. */
  nth: number;
  strategyKey: string;
  setupKey: string;
}

export function holdKey(sec: number): HoldKey {
  if (sec <= 10) return "le10s";
  if (sec < 60) return "10s1m";
  if (sec < 300) return "1to5m";
  if (sec < 900) return "5to15m";
  if (sec < 3600) return "15to60m";
  return "gt60m";
}

export function analyse(trades: StrategyTrade[]): AnalysedTrade[] {
  // Position within the day is counted over every trade taken that day,
  // open or closed — the 4th entry is the 4th entry whatever became of it.
  const byDay = new Map<string, StrategyTrade[]>();
  for (const t of trades) {
    const list = byDay.get(t.tradingDate);
    if (list) list.push(t);
    else byDay.set(t.tradingDate, [t]);
  }
  const nthOf = new Map<string, number>();
  for (const list of byDay.values()) {
    list.sort((a, b) => a.buy.at - b.buy.at);
    list.forEach((t, i) => nthOf.set(t._id, i + 1));
  }

  const out: AnalysedTrade[] = [];
  for (const t of trades) {
    if (t.status !== "closed" || !t.sell || t.profit == null) continue;
    const holdSec = Math.max(0, Math.round((t.sell.at - t.buy.at) / 1000));
    const risk = t.riskPerUnit * t.qty;
    out.push({
      trade: t,
      id: t._id,
      date: t.tradingDate,
      dow: new Date(`${t.tradingDate}T00:00:00Z`).getUTCDay(),
      entryMin: istMinutes(t.buy.at),
      holdSec,
      hold: holdKey(holdSec),
      profit: t.profit,
      // Paper fills price to fractions of a paisa; under 50 paise is a scratch.
      outcome: t.profit >= 0.5 ? "WIN" : t.profit <= -0.5 ? "LOSS" : "BE",
      r: risk > 0 ? t.profit / risk : null,
      cost: t.qty * t.buy.price,
      nth: nthOf.get(t._id) ?? 1,
      strategyKey: `${t.strategyId}@${t.strategyVersion}`,
      setupKey: `${t.strategyId}:${t.setup}`,
    });
  }
  return out.sort((a, b) => a.trade.buy.at - b.trade.buy.at);
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface Filters {
  from: string;
  to: string;
  side: "" | "LONG" | "SHORT";
  outcome: "" | Outcome;
  /** "HH:MM", inclusive. */
  tfrom: string;
  /** "HH:MM", exclusive. */
  tto: string;
  dow: number[];
  /** strategyId, or strategyId@version. */
  strategy: string;
  setup: string;
  exit: string;
  hold: "" | HoldKey;
  option: "" | "CE" | "PE";
  level: "" | "support" | "resistance";
  pivot: string;
  trailed: "" | "yes" | "no";
  nth: "" | NthKey;
  symbol: string;
}

export const EMPTY_FILTERS: Filters = {
  from: "",
  to: "",
  side: "",
  outcome: "",
  tfrom: "",
  tto: "",
  dow: [],
  strategy: "",
  setup: "",
  exit: "",
  hold: "",
  option: "",
  level: "",
  pivot: "",
  trailed: "",
  nth: "",
  symbol: "",
};

/** Filter keys other than the date range — what "Clear filters" resets. */
export const NON_DATE_KEYS = (Object.keys(EMPTY_FILTERS) as (keyof Filters)[]).filter(
  (k) => k !== "from" && k !== "to"
);

export function activeFilterCount(f: Filters): number {
  return NON_DATE_KEYS.filter((k) => {
    const v = f[k];
    return Array.isArray(v) ? v.length > 0 : v !== "";
  }).length;
}

function hhmm(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function nthKey(n: number): NthKey {
  return n >= 4 ? "4+" : (String(n) as NthKey);
}

export function applyFilters(rows: AnalysedTrade[], f: Filters): AnalysedTrade[] {
  const tfrom = hhmm(f.tfrom);
  const tto = hhmm(f.tto);
  const symbol = f.symbol.trim().toUpperCase();

  return rows.filter((a) => {
    const t = a.trade;
    if (f.from && a.date < f.from) return false;
    if (f.to && a.date > f.to) return false;
    if (f.side && t.side !== f.side) return false;
    if (f.outcome && a.outcome !== f.outcome) return false;
    if (tfrom !== null && a.entryMin < tfrom) return false;
    if (tto !== null && a.entryMin >= tto) return false;
    if (f.dow.length && !f.dow.includes(a.dow)) return false;
    if (f.strategy && (f.strategy.includes("@") ? a.strategyKey : t.strategyId) !== f.strategy)
      return false;
    if (f.setup && a.setupKey !== f.setup) return false;
    if (f.exit && t.sell?.reason !== f.exit) return false;
    if (f.hold && a.hold !== f.hold) return false;
    if (f.option && t.instrument.type !== f.option) return false;
    if (f.level && t.trigger?.level?.kind !== f.level) return false;
    if (f.pivot && t.trigger?.level?.pivot !== f.pivot) return false;
    if (f.trailed === "yes" && t.step <= 1) return false;
    if (f.trailed === "no" && t.step > 1) return false;
    if (f.nth && nthKey(a.nth) !== f.nth) return false;
    if (symbol && !t.symbol.includes(symbol)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Date presets
// ---------------------------------------------------------------------------

export const RANGE_PRESETS = [
  { key: "today", label: "Today" },
  { key: "7", label: "7D" },
  { key: "30", label: "30D" },
  { key: "90", label: "90D" },
  { key: "mtd", label: "MTD" },
  { key: "all", label: "All" },
] as const;

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function presetRange(key: string, today = istDate()): { from: string; to: string } {
  switch (key) {
    case "today":
      return { from: today, to: today };
    case "mtd":
      return { from: `${today.slice(0, 7)}-01`, to: "" };
    case "all":
      return { from: "", to: "" };
    default:
      return { from: shiftDate(today, -(Number(key) - 1)), to: "" };
  }
}

export function matchPreset(from: string, to: string, today = istDate()): string | null {
  for (const p of RANGE_PRESETS) {
    const r = presetRange(p.key, today);
    if (r.from === from && r.to === to) return p.key;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface Stats {
  trades: number;
  wins: number;
  losses: number;
  scratches: number;
  /** 0..1 over decided trades; null when none were decided. */
  winRate: number | null;
  net: number;
  grossWin: number;
  grossLoss: number;
  /** Null when there are no losses. */
  profitFactor: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  expectancy: number;
  avgR: number | null;
  best: number;
  worst: number;
  maxWinStreak: number;
  maxLossStreak: number;
  /** Deepest fall from a running peak of cumulative P&L, trade by trade (<= 0). */
  maxDrawdown: number;
  deployed: number;
}

/** Rows must be in entry order for streaks and drawdown — analyse() sorts them. */
export function stats(rows: AnalysedTrade[]): Stats {
  let wins = 0;
  let losses = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let net = 0;
  let rSum = 0;
  let rCount = 0;
  let best = -Infinity;
  let worst = Infinity;
  let curW = 0;
  let curL = 0;
  let maxW = 0;
  let maxL = 0;
  let peak = 0;
  let dd = 0;
  let deployed = 0;

  for (const a of rows) {
    net += a.profit;
    deployed += a.cost;
    if (a.outcome === "WIN") {
      wins += 1;
      grossWin += a.profit;
      curW += 1;
      curL = 0;
    } else if (a.outcome === "LOSS") {
      losses += 1;
      grossLoss += -a.profit;
      curL += 1;
      curW = 0;
    } else {
      curW = 0;
      curL = 0;
    }
    maxW = Math.max(maxW, curW);
    maxL = Math.max(maxL, curL);
    if (a.r !== null) {
      rSum += a.r;
      rCount += 1;
    }
    best = Math.max(best, a.profit);
    worst = Math.min(worst, a.profit);
    peak = Math.max(peak, net);
    dd = Math.min(dd, net - peak);
  }

  const n = rows.length;
  const decided = wins + losses;
  return {
    trades: n,
    wins,
    losses,
    scratches: n - decided,
    winRate: decided ? wins / decided : null,
    net,
    grossWin,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    avgWin: wins ? grossWin / wins : null,
    avgLoss: losses ? grossLoss / losses : null,
    expectancy: n ? net / n : 0,
    avgR: rCount ? rSum / rCount : null,
    best: n ? best : 0,
    worst: n ? worst : 0,
    maxWinStreak: maxW,
    maxLossStreak: maxL,
    maxDrawdown: dd,
    deployed,
  };
}

// ---------------------------------------------------------------------------
// Breakdowns
// ---------------------------------------------------------------------------

export interface Bucket {
  key: string;
  label: string;
  stats: Stats;
}

/**
 * Group, then stats per group. With `order`, rows follow it (and keys outside
 * it are dropped); without, they sort best net P&L first.
 */
export function breakdown(
  rows: AnalysedTrade[],
  keyOf: (a: AnalysedTrade) => string | null,
  labelOf: (key: string) => string,
  order?: string[]
): Bucket[] {
  const groups = new Map<string, AnalysedTrade[]>();
  for (const a of rows) {
    const k = keyOf(a);
    if (k === null) continue;
    const list = groups.get(k);
    if (list) list.push(a);
    else groups.set(k, [a]);
  }
  const out = [...groups.entries()].map(([key, g]) => ({ key, label: labelOf(key), stats: stats(g) }));
  if (order) {
    const pos = new Map(order.map((k, i) => [k, i]));
    return out.filter((b) => pos.has(b.key)).sort((a, b) => pos.get(a.key)! - pos.get(b.key)!);
  }
  return out.sort((a, b) => b.stats.net - a.stats.net);
}

/** 15-minute entry slots — the rule trades a short morning, so 30 is too coarse. */
export const SLOT_MIN = 15;

export function slotKey(entryMin: number): string {
  return String(Math.floor(entryMin / SLOT_MIN) * SLOT_MIN);
}

export function clock(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

export function slotLabel(key: string): string {
  const start = Number(key);
  return `${clock(start)}–${clock(start + SLOT_MIN)}`;
}

export const HOLD_LABELS: Record<HoldKey, string> = {
  le10s: "10 s or less",
  "10s1m": "10 s – 1 min",
  "1to5m": "1 – 5 min",
  "5to15m": "5 – 15 min",
  "15to60m": "15 – 60 min",
  gt60m: "Over 1 hour",
};

export const NTH_LABELS: Record<NthKey, string> = {
  "1": "1st trade of the day",
  "2": "2nd trade",
  "3": "3rd trade",
  "4+": "4th onwards",
};

export const EXIT_LABELS: Record<string, string> = {
  stop: "Stop-loss",
  "trail-stop": "Trailing stop",
  "eod-flatten": "End-of-day flatten",
  manual: "Manual",
  "no-quote": "No quote",
};

export const DOW_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const TIME_PRESETS = [
  { label: "First 15 min", from: "09:15", to: "09:30" },
  { label: "Before 10 AM", from: "", to: "10:00" },
  { label: "10 – 11", from: "10:00", to: "11:00" },
  { label: "11 – 12", from: "11:00", to: "12:00" },
  { label: "12 – 1:30", from: "12:00", to: "13:30" },
  { label: "After 1:30 PM", from: "13:30", to: "" },
] as const;

export const R_BANDS = [
  { key: "lt-1", label: "< −1R", test: (r: number) => r < -1 },
  { key: "-1to-.5", label: "−1 to −½R", test: (r: number) => r >= -1 && r < -0.5 },
  { key: "-.5to0", label: "−½ to 0R", test: (r: number) => r >= -0.5 && r < 0 },
  { key: "0to1", label: "0 to 1R", test: (r: number) => r >= 0 && r < 1 },
  { key: "1to2", label: "1 to 2R", test: (r: number) => r >= 1 && r < 2 },
  { key: "2to3", label: "2 to 3R", test: (r: number) => r >= 2 && r < 3 },
  { key: "ge3", label: "≥ 3R", test: (r: number) => r >= 3 },
];

export function rDistribution(rows: AnalysedTrade[]) {
  return R_BANDS.map((b) => {
    const hits = rows.filter((a) => a.r !== null && b.test(a.r));
    return {
      key: b.key,
      label: b.label,
      count: hits.length,
      net: hits.reduce((s, a) => s + a.profit, 0),
      negative: b.key.startsWith("lt") || b.key.startsWith("-"),
    };
  });
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

export interface Day {
  date: string;
  net: number;
  trades: number;
  wins: number;
  losses: number;
}

export function days(rows: AnalysedTrade[]): Day[] {
  const map = new Map<string, Day>();
  for (const a of rows) {
    const d = map.get(a.date) ?? { date: a.date, net: 0, trades: 0, wins: 0, losses: 0 };
    d.net += a.profit;
    d.trades += 1;
    if (a.outcome === "WIN") d.wins += 1;
    if (a.outcome === "LOSS") d.losses += 1;
    map.set(a.date, d);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function medianHold(rows: AnalysedTrade[]): number | null {
  if (!rows.length) return null;
  const s = rows.map((a) => a.holdSec).sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export function fmtHold(sec: number | null): string {
  if (sec === null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`;
  return `${Math.floor(sec / 3600)}h ${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}m`;
}

/** "Mon 15 Sep" for a trading date. */
export function fmtDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}


// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

/** Buckets thinner than this are too small to call a pattern. */
export const MIN_SAMPLE = 3;

export interface Insight {
  tone: "pos" | "neg" | "neutral";
  text: string;
}

function rupees(v: number): string {
  const r = Math.round(v);
  return `${r >= 0 ? "+" : "−"}₹${Math.abs(r).toLocaleString("en-IN")}`;
}

function pct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

function describe(b: Bucket): string {
  return `${rupees(b.stats.net)} over ${b.stats.trades} trades, ${pct(b.stats.winRate)} win rate`;
}

function enough(b?: Bucket): b is Bucket {
  return !!b && b.stats.trades >= MIN_SAMPLE;
}

function extremes(rows: Bucket[]) {
  const usable = rows.filter(enough).sort((a, b) => b.stats.net - a.stats.net);
  return usable.length >= 2 ? { best: usable[0], worst: usable[usable.length - 1] } : null;
}

export function insights(rows: AnalysedTrade[], s: Stats): Insight[] {
  const out: Insight[] = [];

  const side = breakdown(rows, (a) => a.trade.side, (k) => (k === "LONG" ? "Longs" : "Shorts"));
  const long = side.find((b) => b.key === "LONG");
  const short = side.find((b) => b.key === "SHORT");
  if (enough(long) && enough(short)) {
    const [better, worse] = long.stats.net >= short.stats.net ? [long, short] : [short, long];
    out.push({ tone: "neutral", text: `${better.label} carry the book: ${describe(better)}. ${worse.label}: ${describe(worse)}.` });
  }

  const tenAm = breakdown(rows, (a) => (a.entryMin < 600 ? "pre" : "post"), (k) => k);
  const pre = tenAm.find((b) => b.key === "pre");
  const post = tenAm.find((b) => b.key === "post");
  if (enough(pre) && enough(post)) {
    out.push({
      tone: pre.stats.net < 0 && post.stats.net > pre.stats.net ? "neg" : "neutral",
      text: `Entries before 10 AM: ${describe(pre)}. From 10 AM on: ${describe(post)}.`,
    });
  }

  const slot = extremes(breakdown(rows, (a) => slotKey(a.entryMin), slotLabel));
  if (slot) {
    out.push({ tone: "pos", text: `Best entry window is ${slot.best.label}: ${describe(slot.best)}.` });
    if (slot.worst.stats.net < 0)
      out.push({ tone: "neg", text: `Worst entry window is ${slot.worst.label}: ${describe(slot.worst)}.` });
  }

  const hold = breakdown(rows, (a) => a.hold, (k) => HOLD_LABELS[k as HoldKey]);
  const quick = hold.find((b) => b.key === "le10s");
  if (quick && quick.stats.trades >= 2 && quick.stats.net < 0) {
    out.push({
      tone: "neg",
      text: `Trades that died within 10 seconds of entry: ${describe(quick)}. A stop that fast is usually the fill, not the market.`,
    });
  }
  const holdEx = extremes(hold);
  if (holdEx && holdEx.best.key !== holdEx.worst.key && holdEx.worst.stats.net < 0) {
    out.push({
      tone: "neutral",
      text: `Holds of ${holdEx.best.label.toLowerCase()} work best (${rupees(holdEx.best.stats.net)}); ${holdEx.worst.label.toLowerCase()} is the weakest (${rupees(holdEx.worst.stats.net)}).`,
    });
  }

  const nth = breakdown(rows, (a) => (a.nth === 1 ? "first" : "later"), (k) => k);
  const first = nth.find((b) => b.key === "first");
  const later = nth.find((b) => b.key === "later");
  if (enough(first) && enough(later)) {
    out.push({
      tone: later.stats.expectancy < first.stats.expectancy && later.stats.expectancy < 0 ? "neg" : "neutral",
      text: `The day's first trade averages ${rupees(first.stats.expectancy)}; every trade after it averages ${rupees(later.stats.expectancy)}.`,
    });
  }

  const trail = breakdown(rows, (a) => (a.trade.step > 1 ? "yes" : "no"), (k) => k);
  const trailed = trail.find((b) => b.key === "yes");
  if (trailed && trailed.stats.trades >= 1 && s.trades >= MIN_SAMPLE) {
    out.push({
      tone: "pos",
      text: `${trailed.stats.trades} of ${s.trades} trades reached the trail and made ${rupees(trailed.stats.net)} between them.`,
    });
  }

  const strat = breakdown(rows, (a) => a.strategyKey, (k) => k);
  const stratEx = extremes(strat);
  if (stratEx) {
    const name = (k: string) => {
      const t = rows.find((a) => a.strategyKey === k)!.trade;
      return `${t.strategyName} v${t.strategyVersion}`;
    };
    out.push({
      tone: "neutral",
      text: `${name(stratEx.best.key)} leads (${describe(stratEx.best)}); ${name(stratEx.worst.key)} trails (${describe(stratEx.worst)}).`,
    });
  }

  const dow = extremes(breakdown(rows, (a) => String(a.dow), (k) => DOW_LABELS[Number(k)]));
  if (dow && dow.worst.stats.net < 0) {
    out.push({ tone: "neg", text: `${dow.worst.label} is the weakest day (${describe(dow.worst)}); ${dow.best.label} the strongest.` });
  }

  if (s.avgWin !== null && s.avgLoss !== null && s.winRate !== null) {
    const payoff = s.avgWin / s.avgLoss;
    const needed = 1 / (1 + payoff);
    out.push({
      tone: s.winRate >= needed ? "pos" : "neg",
      text: `Average win is ${payoff.toFixed(2)}× the average loss, so break-even needs a ${pct(needed)} win rate. Actual: ${pct(s.winRate)}.`,
    });
  }

  return out;
}
