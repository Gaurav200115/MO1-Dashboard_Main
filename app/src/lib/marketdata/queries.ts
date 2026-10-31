import { rows } from "./db";
import type {
  Bar,
  BuildUp,
  ChainDay,
  ChainRow,
  ExplorerOverview,
  MonthDetail,
  OiDay,
  OptionContract,
  Timeframe,
} from "./types";

/**
 * Reads behind the History analysis pages. Server-only: everything goes through the read-only
 * pool in ./db. Table layout is in scripts/marketdata/sql/schema.sql — prices are whole paise,
 * minute bars are timestamptz, the NSE end-of-day tables are keyed by trade_date.
 */

/** More bars than this in one answer means the timeframe is too fine for the range. */
export const MAX_BARS = 50_000;

const IST = "Asia/Kolkata";

/** Midnight IST at the start of a "YYYY-MM-DD" day, as an instant Postgres compares with ts. */
function istMidnight(day: string): string {
  return `${day}T00:00:00+05:30`;
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "YYYY-MM" -> [first day, first day of the next month). */
export function monthBounds(month: string): [string, string] {
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return [`${month}-01`, `${next}-01`];
}

// ---------------------------------------------------------------- months and stocks

export async function overview(): Promise<ExplorerOverview> {
  const [range] = await rows<{ from: string | null; to: string | null }>(
    `SELECT min(d) AS from, max(d) AS to FROM done WHERE dataset = 'cm_bhavcopy'`
  );
  const [vix] = await rows<{ from: string | null; to: string | null }>(
    `SELECT min(d) AS from, max(d) AS to FROM done WHERE dataset = 'vix_1min' AND rows > 0`
  );
  const months = await rows<{ month: string; selected: number; trading_days: number }>(
    `SELECT to_char(r.month, 'YYYY-MM') AS month,
            count(*) FILTER (WHERE r.selected)::int AS selected,
            (SELECT count(*) FROM trading_calendar c
              WHERE c.trading_day AND c.d >= r.month AND c.d < r.month + interval '1 month'
                AND c.d BETWEEN $1 AND $2)::int AS trading_days
       FROM liquidity_rank r
      GROUP BY r.month
      ORDER BY r.month`,
    [range?.from ?? "1900-01-01", range?.to ?? "1900-01-01"]
  );
  return {
    months: months.map((m) => ({ month: m.month, selected: m.selected, tradingDays: m.trading_days })),
    vix: vix?.from && vix.to ? { from: vix.from, to: vix.to } : null,
    range: range?.from && range.to ? { from: range.from, to: range.to } : null,
  };
}

export async function monthDetail(month: string): Promise<MonthDetail> {
  const [from, to] = monthBounds(month);
  const days = await rows<{ d: string }>(
    `SELECT c.d FROM trading_calendar c
      WHERE c.trading_day AND c.d >= $1 AND c.d < $2
        AND c.d BETWEEN (SELECT min(d) FROM done WHERE dataset = 'cm_bhavcopy')
                    AND (SELECT max(d) FROM done WHERE dataset = 'cm_bhavcopy')
      ORDER BY c.d`,
    [from, to]
  );
  const stocks = await rows<{
    symbol: string;
    company: string | null;
    industry: string | null;
    rank: number;
    turnover: number | null;
    atm_oi_lots: number | null;
    ranked_from: string | null;
    ranked_to: string | null;
    option_days: number;
  }>(
    `SELECT r.symbol, s.company_name AS company, s.industry, r.rank, r.turnover_median AS turnover,
            r.atm_oi_lots, r.ranked_from, r.ranked_to,
            (SELECT count(DISTINCT o.d) FROM done o
              WHERE o.dataset = 'options_1min' AND o.symbol = r.symbol AND o.d >= $1 AND o.d < $2)::int AS option_days
       FROM liquidity_rank r
       LEFT JOIN stocks s ON s.symbol = r.symbol
      WHERE r.month = $1 AND r.selected
      ORDER BY r.rank`,
    [from, to]
  );
  return {
    month,
    days: days.map((d) => d.d),
    stocks: stocks.map((s) => ({
      symbol: s.symbol,
      company: s.company,
      industry: s.industry,
      rank: s.rank,
      turnover: s.turnover,
      atmOiLots: s.atm_oi_lots,
      rankedFrom: s.ranked_from,
      rankedTo: s.ranked_to,
      optionDays: s.option_days,
    })),
  };
}

// ---------------------------------------------------------------- minute bars

/**
 * One bar per bucket, local (IST) time folded into the epoch. Hourly buckets start at 09:15 so
 * they line up with the session rather than the clock.
 */
function bucketSql(tf: Timeframe): string {
  const local = `(ts AT TIME ZONE '${IST}')`;
  if (tf === "D") return `date_trunc('day', ${local})`;
  return `time_bucket('${Number(tf)} minutes'::interval, ${local}, TIMESTAMP '2000-01-03 09:15:00')`;
}

/** `extra`: one more column, its last value in each bucket (e.g. the underlying for an option). */
function barsSql(table: string, where: string, tf: Timeframe, extra?: { col: string; as: string }): string {
  if (tf === "1") {
    return `SELECT extract(epoch FROM ts AT TIME ZONE '${IST}')::bigint AS t,
                   open_paise / 100.0 AS o, high_paise / 100.0 AS h, low_paise / 100.0 AS l,
                   close_paise / 100.0 AS c, coalesce(volume, 0) AS v ${extra ? `, ${extra.col} AS ${extra.as}` : ""}
              FROM ${table} WHERE ${where} ORDER BY ts LIMIT ${MAX_BARS + 1}`;
  }
  const b = bucketSql(tf);
  const agg = extra ? `, last(${extra.col}, ts) AS ${extra.as}` : "";
  return `SELECT extract(epoch FROM ${b})::bigint AS t,
                 first(open_paise, ts) / 100.0 AS o, max(high_paise) / 100.0 AS h,
                 min(low_paise) / 100.0 AS l, last(close_paise, ts) / 100.0 AS c,
                 coalesce(sum(volume), 0) AS v ${agg}
            FROM ${table} WHERE ${where} GROUP BY 1 ORDER BY 1 LIMIT ${MAX_BARS + 1}`;
}

export class TooManyBars extends Error {}

function capped<T>(list: T[]): T[] {
  if (list.length > MAX_BARS) {
    throw new TooManyBars(`More than ${MAX_BARS.toLocaleString("en-IN")} bars — pick a larger timeframe or a shorter range.`);
  }
  return list;
}

/** Spot or index (NIFTY, INDIA VIX) bars between two days, both inclusive. */
export async function spotBars(symbol: string, from: string, to: string, tf: Timeframe): Promise<Bar[]> {
  const list = await rows<Bar>(barsSql("spot_1min", "symbol = $1 AND ts >= $2 AND ts < $3", tf), [
    symbol,
    istMidnight(from),
    istMidnight(addDays(to, 1)),
  ]);
  return capped(list);
}

export async function optionContracts(symbol: string, from: string, to: string): Promise<OptionContract[]> {
  const list = await rows<{
    expiry: string;
    strike: number;
    type: "CE" | "PE";
    bars: number;
    atm_minutes: number;
    first: string;
    last: string;
  }>(
    `SELECT expiry_date AS expiry, strike_paise / 100.0 AS strike, option_type AS type, count(*)::int AS bars,
            count(*) FILTER (WHERE strike_offset = 0)::int AS atm_minutes,
            min(ts AT TIME ZONE '${IST}')::date AS first, max(ts AT TIME ZONE '${IST}')::date AS last
       FROM option_1min
      WHERE symbol = $1 AND ts >= $2 AND ts < $3
      GROUP BY 1, 2, 3
      ORDER BY 1, 2, 3`,
    [symbol, istMidnight(from), istMidnight(addDays(to, 1))]
  );
  return list.map((r) => ({
    expiry: r.expiry,
    strike: r.strike,
    type: r.type,
    bars: r.bars,
    atmMinutes: r.atm_minutes,
    first: r.first,
    last: r.last,
  }));
}

/** One option contract's bars, each with the underlying's price at its last minute. */
export async function optionBars(
  symbol: string,
  expiry: string,
  strike: number,
  type: "CE" | "PE",
  from: string,
  to: string,
  tf: Timeframe
): Promise<(Bar & { spot: number | null })[]> {
  const where =
    "symbol = $1 AND expiry_date = $2 AND strike_paise = $3 AND option_type = $4 AND ts >= $5 AND ts < $6";
  const list = await rows<Bar & { spot: number | null }>(
    barsSql("option_1min", where, tf, { col: "spot_paise / 100.0", as: "spot" }),
    [symbol, expiry, Math.round(strike * 100), type, istMidnight(from), istMidnight(addDays(to, 1))]
  );
  return capped(list);
}

// ---------------------------------------------------------------- end of day: chain and OI

interface OptRow {
  expiry: string;
  strike: number;
  type: "CE" | "PE";
  close: number | null;
  contracts: number;
  oi: number;
  chg: number;
  turnover: number | null;
  lot_size: number | null;
}

/**
 * Max pain: the expiry price at which option buyers, all strikes together, would collect the
 * least — calls pay (price − strike) per share of open interest, puts (strike − price).
 */
export function maxPain(chain: { strike: number; ceOi: number; peOi: number }[]): number | null {
  if (!chain.length) return null;
  let best: number | null = null;
  let bestPay = Infinity;
  for (const { strike: price } of chain) {
    let pay = 0;
    for (const s of chain) {
      if (price > s.strike) pay += s.ceOi * (price - s.strike);
      if (price < s.strike) pay += s.peOi * (s.strike - price);
    }
    if (pay < bestPay) {
      bestPay = pay;
      best = price;
    }
  }
  return best;
}

function nearest(expiries: Iterable<string>, day: string): string | null {
  let out: string | null = null;
  for (const e of expiries) if (e >= day && (out === null || e < out)) out = e;
  return out;
}

export async function chainDay(symbol: string, date: string, expiry: string | null): Promise<ChainDay> {
  const opts = await rows<OptRow>(
    `SELECT expiry_date AS expiry, strike_paise / 100.0 AS strike, option_type AS type,
            close_paise / 100.0 AS close, coalesce(contracts, 0) AS contracts,
            coalesce(open_interest, 0) AS oi, coalesce(change_in_oi, 0) AS chg,
            turnover_rs AS turnover, lot_size
       FROM fo_bhavcopy
      WHERE symbol = $1 AND trade_date = $2 AND instrument = 'OPTSTK'`,
    [symbol, date]
  );
  const futs = await rows<{ expiry: string; close: number | null; oi: number; chg: number }>(
    `SELECT expiry_date AS expiry, close_paise / 100.0 AS close, coalesce(open_interest, 0) AS oi,
            coalesce(change_in_oi, 0) AS chg
       FROM fo_bhavcopy
      WHERE symbol = $1 AND trade_date = $2 AND instrument = 'FUTSTK'
      ORDER BY expiry_date`,
    [symbol, date]
  );
  const [spot] = await rows<{ close: number | null }>(
    `SELECT close_paise / 100.0 AS close FROM cm_bhavcopy WHERE symbol = $1 AND series = 'EQ' AND trade_date = $2`,
    [symbol, date]
  );
  const [stock] = await rows<{ lot_size: number | null }>(`SELECT lot_size FROM stocks WHERE symbol = $1`, [symbol]);

  const expiries = [...new Set(opts.map((o) => o.expiry))].sort();
  const chosen = expiry && expiries.includes(expiry) ? expiry : nearest(expiries, date);
  const byStrike = new Map<number, ChainRow>();
  let lotSize: number | null = null;
  for (const o of opts) {
    if (o.expiry !== chosen) continue;
    lotSize = lotSize ?? o.lot_size;
    const row = byStrike.get(o.strike) ?? { strike: o.strike, ce: null, pe: null };
    const side = { close: o.close, oi: o.oi, chgOi: o.chg, contracts: o.contracts, turnover: o.turnover };
    if (o.type === "CE") row.ce = side;
    else row.pe = side;
    byStrike.set(o.strike, row);
  }
  const chainRows = [...byStrike.values()].sort((a, b) => a.strike - b.strike);
  const futExpiry = nearest(
    futs.map((f) => f.expiry),
    date
  );
  const fut = futs.find((f) => f.expiry === futExpiry) ?? null;
  return {
    symbol,
    date,
    expiry: chosen,
    expiries,
    spot: spot?.close ?? null,
    future: fut ? { expiry: fut.expiry, close: fut.close, oi: fut.oi, chgOi: fut.chg } : null,
    lotSize: lotSize ?? stock?.lot_size ?? null,
    rows: chainRows,
    maxPain: maxPain(chainRows.map((r) => ({ strike: r.strike, ceOi: r.ce?.oi ?? 0, peOi: r.pe?.oi ?? 0 }))),
  };
}

function buildUp(priceChange: number, oiChange: number): BuildUp | null {
  if (!priceChange || !oiChange) return null;
  if (priceChange > 0) return oiChange > 0 ? "Long build-up" : "Short covering";
  return oiChange > 0 ? "Short build-up" : "Long unwinding";
}

/**
 * Day by day for one stock over a month: open interest of the nearest expiry's options (calls,
 * puts, PCR, max pain) and of its nearest future, with the build-up that future's price and OI
 * moves imply. The futures read starts two weeks early so the month's first day has a previous
 * close to compare with.
 */
export async function oiMonth(symbol: string, month: string): Promise<OiDay[]> {
  const [from, to] = monthBounds(month);
  const opts = await rows<{ d: string; expiry: string; strike: number; type: "CE" | "PE"; oi: number; chg: number }>(
    `SELECT trade_date AS d, expiry_date AS expiry, strike_paise / 100.0 AS strike, option_type AS type,
            coalesce(open_interest, 0) AS oi, coalesce(change_in_oi, 0) AS chg
       FROM fo_bhavcopy
      WHERE symbol = $1 AND instrument = 'OPTSTK' AND trade_date >= $2 AND trade_date < $3`,
    [symbol, from, to]
  );
  const futs = await rows<{ d: string; expiry: string; close: number | null; oi: number; chg: number }>(
    `SELECT trade_date AS d, expiry_date AS expiry, close_paise / 100.0 AS close,
            coalesce(open_interest, 0) AS oi, coalesce(change_in_oi, 0) AS chg
       FROM fo_bhavcopy
      WHERE symbol = $1 AND instrument = 'FUTSTK' AND trade_date >= $2 AND trade_date < $3
      ORDER BY trade_date`,
    [symbol, addDays(from, -14), to]
  );
  const spot = await rows<{ d: string; close: number | null }>(
    `SELECT trade_date AS d, close_paise / 100.0 AS close FROM cm_bhavcopy
      WHERE symbol = $1 AND series = 'EQ' AND trade_date >= $2 AND trade_date < $3`,
    [symbol, from, to]
  );
  const spotBy = new Map(spot.map((s) => [s.d, s.close]));

  const optBy = new Map<string, typeof opts>();
  for (const o of opts) optBy.set(o.d, [...(optBy.get(o.d) ?? []), o]);
  const futBy = new Map<string, typeof futs>();
  for (const f of futs) futBy.set(f.d, [...(futBy.get(f.d) ?? []), f]);
  const lastClose = new Map<string, number | null>(); // future expiry -> its previous close

  const out: OiDay[] = [];
  for (const d of [...new Set([...futBy.keys(), ...optBy.keys()])].sort()) {
    const dayFuts = futBy.get(d) ?? [];
    const fe = nearest(
      dayFuts.map((f) => f.expiry),
      d
    );
    const fut = dayFuts.find((f) => f.expiry === fe) ?? null;
    const prev = fut ? lastClose.get(fut.expiry) : undefined;
    for (const f of dayFuts) lastClose.set(f.expiry, f.close);
    if (d < from) continue;

    const dayOpts = optBy.get(d) ?? [];
    const oe = nearest(
      dayOpts.map((o) => o.expiry),
      d
    );
    const strikes = new Map<number, { strike: number; ceOi: number; peOi: number }>();
    let ceOi = 0;
    let peOi = 0;
    let ceChg = 0;
    let peChg = 0;
    for (const o of dayOpts) {
      if (o.expiry !== oe) continue;
      const s = strikes.get(o.strike) ?? { strike: o.strike, ceOi: 0, peOi: 0 };
      if (o.type === "CE") {
        s.ceOi += o.oi;
        ceOi += o.oi;
        ceChg += o.chg;
      } else {
        s.peOi += o.oi;
        peOi += o.oi;
        peChg += o.chg;
      }
      strikes.set(o.strike, s);
    }
    const priceChange = fut?.close != null && prev != null ? fut.close - prev : 0;
    out.push({
      date: d,
      expiry: oe,
      spot: spotBy.get(d) ?? null,
      ceOi,
      peOi,
      ceChg,
      peChg,
      pcr: ceOi ? peOi / ceOi : null,
      maxPain: maxPain([...strikes.values()].sort((a, b) => a.strike - b.strike)),
      futClose: fut?.close ?? null,
      futOi: fut?.oi ?? null,
      futChgOi: fut?.chg ?? null,
      buildUp: fut ? buildUp(priceChange, fut.chg) : null,
    });
  }
  return out;
}
