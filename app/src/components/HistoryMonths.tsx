"use client";

import { useMemo, useState, type ReactNode } from "react";
import { fmtPeriod, grouped } from "@/lib/format";
import type { Bar, ExplorerOverview, MonthDetail, OptionContract, RankedStock, Timeframe } from "@/lib/marketdata/types";
import { q, useExplorer } from "@/lib/marketdata/useExplorer";
import OiMonth, { dayLabel } from "./OiMonth";
import OptionChain, { Segmented } from "./OptionChain";
import TimeChart, { type Overlay } from "./TimeChart";

/**
 * History analysis → Stocks by month. The archive split by calendar month, because the option
 * stocks are re-chosen each month (the 100 most liquid, ranked on the 20 trading days before it).
 * Pick a month, then one of its stocks: spot with India VIX, its ATM±3 options at 1 minute, and
 * end-of-day open interest and option chain.
 */

const TIMEFRAMES: [Timeframe, string][] = [
  ["1", "1m"],
  ["5", "5m"],
  ["15", "15m"],
  ["60", "1h"],
  ["D", "1D"],
];

export const VIX_SYMBOL = "INDIA VIX";

export function vixOverlay(bars: Bar[] | null): Overlay | null {
  return bars && bars.length ? { label: "India VIX", points: bars.map((b) => ({ t: b.t, v: b.c })) } : null;
}

export default function HistoryMonths() {
  const overview = useExplorer<ExplorerOverview>("view=overview");
  const [month, setMonth] = useState<string | null>(null);
  const [symbol, setSymbol] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const months = overview.data?.months ?? [];
  const activeMonth = month ?? months[months.length - 1]?.month ?? null;
  const detail = useExplorer<MonthDetail>(activeMonth ? q({ view: "month", month: activeMonth }) : null);

  const stocks = detail.data?.stocks ?? [];
  const activeStock = stocks.find((s) => s.symbol === symbol) ?? stocks[0] ?? null;
  const shown = useMemo(() => {
    const needle = search.trim().toUpperCase();
    return needle
      ? stocks.filter((s) => s.symbol.includes(needle) || (s.company ?? "").toUpperCase().includes(needle))
      : stocks;
  }, [stocks, search]);

  return (
    <section className="overflow-hidden rounded-md border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <h2 className="font-display text-[10px] font-bold uppercase tracking-[0.13em] text-muted">Stocks by month</h2>
        <p className="ml-auto max-w-[60ch] text-[10.5px] leading-snug text-faint">
          Each month&apos;s 100 most liquid F&amp;O stocks (ranked on the 20 trading days before it). Minute
          bars from Dhan; open interest and the option chain from NSE&apos;s end-of-day files.
        </p>
      </div>

      {overview.error ? (
        <p className="px-4 py-4 text-[12px] text-muted">{overview.error}</p>
      ) : !overview.data ? (
        <p className="px-4 py-4 text-[12px] text-muted">Loading the archive…</p>
      ) : !months.length ? (
        <p className="px-4 py-4 text-[12px] text-muted">No months ranked yet — the download has not reached options.</p>
      ) : (
        <>
          <div className="flex gap-1 overflow-x-auto border-b border-line px-3 py-2" role="tablist" aria-label="Month">
            {months.map((m) => (
              <button
                key={m.month}
                type="button"
                role="tab"
                aria-selected={m.month === activeMonth}
                onClick={() => {
                  setMonth(m.month);
                  setSymbol(null);
                }}
                className={`shrink-0 rounded-[5px] px-2.5 py-1 text-left text-[12px] ${
                  m.month === activeMonth ? "bg-accentsoft font-semibold text-accent" : "text-ink2 hover:bg-surface2"
                }`}
                title={`${m.selected} stocks · ${m.tradingDays} trading days downloaded`}
              >
                {fmtPeriod(m.month)}
                <span className="tnum ml-1.5 font-mono text-[10px] text-faint">{m.tradingDays}d</span>
              </button>
            ))}
          </div>

          <div className="grid gap-0 lg:grid-cols-[250px_minmax(0,1fr)]">
            <div className="border-b border-line lg:border-b-0 lg:border-r">
              <div className="px-3 pt-3">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={`Search ${stocks.length} stocks`}
                  className="w-full rounded-[5px] border border-line bg-sunken px-2 py-1 text-[12px] text-ink placeholder:text-faint"
                />
              </div>
              {detail.error ? (
                <p className="px-3 py-3 text-[12px] text-neg">{detail.error}</p>
              ) : !detail.data ? (
                <p className="px-3 py-3 text-[12px] text-muted">Loading…</p>
              ) : (
                <ol className="max-h-[260px] overflow-y-auto px-1.5 py-2 lg:max-h-[1400px]">
                  {shown.map((s) => (
                    <StockItem
                      key={s.symbol}
                      stock={s}
                      days={detail.data!.days.length}
                      active={s.symbol === activeStock?.symbol}
                      onSelect={() => setSymbol(s.symbol)}
                    />
                  ))}
                </ol>
              )}
            </div>

            <div className="min-w-0 px-4 py-4">
              {activeStock && detail.data && detail.data.days.length ? (
                <StockMonth
                  key={`${activeStock.symbol}|${detail.data.month}`}
                  stock={activeStock}
                  month={detail.data.month}
                  days={detail.data.days}
                  vixReady={Boolean(overview.data.vix)}
                />
              ) : detail.data ? (
                <p className="text-[12px] text-muted">No trading days of {fmtPeriod(detail.data.month)} downloaded yet.</p>
              ) : null}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function StockItem({
  stock,
  days,
  active,
  onSelect,
}: {
  stock: RankedStock;
  days: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active}
        title={stock.company ?? stock.symbol}
        className={`flex w-full items-center gap-2 rounded-[5px] px-1.5 py-1 text-left text-[12px] ${
          active ? "bg-accentsoft font-semibold text-accent" : "text-ink2 hover:bg-surface2"
        }`}
      >
        <span className="tnum w-6 shrink-0 text-right font-mono text-[10.5px] text-faint">{stock.rank}</span>
        <span className="min-w-0 flex-1 truncate">{stock.symbol}</span>
        <span
          className={`tnum shrink-0 font-mono text-[10px] ${stock.optionDays < days ? "text-alert" : "text-faint"}`}
          title={`Option minute data on ${stock.optionDays} of ${days} trading days`}
        >
          {stock.optionDays}/{days}
        </span>
      </button>
    </li>
  );
}

function Card({ title, hint, children, right }: { title: string; hint?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="rounded-md border border-line">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <h3 className="text-[12px] font-semibold text-ink">{title}</h3>
        {hint ? <span className="text-[10.5px] text-faint">{hint}</span> : null}
        {right ? <div className="ml-auto">{right}</div> : null}
      </div>
      <div className="px-3 py-3">{children}</div>
    </div>
  );
}

function StockMonth({
  stock,
  month,
  days,
  vixReady,
}: {
  stock: RankedStock;
  month: string;
  days: string[];
  vixReady: boolean;
}) {
  const [tf, setTf] = useState<Timeframe>("5");
  const [chainDate, setChainDate] = useState(days[days.length - 1]);
  const from = days[0];
  const to = days[days.length - 1];

  const spot = useExplorer<Bar[]>(q({ view: "bars", symbol: stock.symbol, from, to, tf }));
  const vix = useExplorer<Bar[]>(vixReady ? q({ view: "bars", symbol: VIX_SYMBOL, from, to, tf }) : null);
  const overlay = useMemo(() => vixOverlay(vix.data), [vix.data]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-[16px] font-semibold text-ink">{stock.symbol}</h2>
        <span className="text-[12px] text-muted">{stock.company}</span>
        <span className="text-[11.5px] text-ink2">
          Rank <span className="tnum font-mono font-semibold">#{stock.rank}</span> in {fmtPeriod(month)}
        </span>
        {stock.turnover != null ? (
          <span className="text-[11.5px] text-muted">
            ATM turnover <span className="tnum font-mono text-ink2">₹{grouped(stock.turnover / 1e7)} Cr</span>/day
          </span>
        ) : null}
        {stock.atmOiLots != null ? (
          <span className="text-[11.5px] text-muted">
            ATM OI <span className="tnum font-mono text-ink2">{grouped(stock.atmOiLots)}</span> lots
          </span>
        ) : null}
        {stock.rankedFrom && stock.rankedTo ? (
          <span className="text-[10.5px] text-faint">
            ranked on {dayLabel(stock.rankedFrom)} – {dayLabel(stock.rankedTo)}
          </span>
        ) : null}
        <div className="ml-auto">
          <Segmented value={tf} options={TIMEFRAMES} onChange={setTf} />
        </div>
      </div>

      <Card
        title="Spot & India VIX"
        hint={vixReady ? "candles: stock · line: India VIX (left scale)" : "India VIX not downloaded yet"}
      >
        <ChartState state={spot} empty={`No spot bars for ${stock.symbol} in ${fmtPeriod(month)}.`}>
          {(bars) => <TimeChart bars={bars} mainLabel={stock.symbol} overlay={overlay} daily={tf === "D"} />}
        </ChartState>
      </Card>

      <OptionCard symbol={stock.symbol} from={from} to={to} tf={tf} />

      <Card title="Open interest" hint="end of day, nearest expiry">
        <OiMonth symbol={stock.symbol} month={month} selected={chainDate} onPick={setChainDate} />
      </Card>

      <Card title="Option chain" hint="end of day, every strike">
        <OptionChain symbol={stock.symbol} days={days} date={chainDate} onDate={setChainDate} />
      </Card>
    </div>
  );
}

function ChartState({
  state,
  empty,
  children,
}: {
  state: { data: Bar[] | null; error: string | null; loading: boolean };
  empty: string;
  children: (bars: Bar[]) => ReactNode;
}) {
  if (state.error) return <p className="py-6 text-[12px] text-neg">{state.error}</p>;
  if (state.loading || !state.data) return <p className="py-6 text-[12px] text-muted">Loading bars…</p>;
  if (!state.data.length) return <p className="py-6 text-[12px] text-muted">{empty}</p>;
  return <>{children(state.data)}</>;
}

/** The ATM±3 options at 1 minute: pick expiry, call or put, and strike. */
function OptionCard({ symbol, from, to, tf }: { symbol: string; from: string; to: string; tf: Timeframe }) {
  const contracts = useExplorer<OptionContract[]>(q({ view: "contracts", symbol, from, to }));
  const [pick, setPick] = useState<{ expiry: string | null; type: "CE" | "PE"; strike: number | null }>({
    expiry: null,
    type: "CE",
    strike: null,
  });

  const list = contracts.data ?? [];
  const expiries = [...new Set(list.map((c) => c.expiry))].sort();
  // Default expiry: the one with the most minutes this month (the month's own monthly contract).
  const busiest = expiries
    .map((e) => [e, list.filter((c) => c.expiry === e).reduce((n, c) => n + c.bars, 0)] as const)
    .sort((a, b) => b[1] - a[1])[0]?.[0];
  const expiry = pick.expiry && expiries.includes(pick.expiry) ? pick.expiry : busiest ?? null;
  const strikes = list.filter((c) => c.expiry === expiry && c.type === pick.type).sort((a, b) => a.strike - b.strike);
  // Default strike: the one that was at the money for longest.
  const mostAtm = [...strikes].sort((a, b) => b.atmMinutes - a.atmMinutes || b.bars - a.bars)[0];
  const strike = strikes.find((c) => c.strike === pick.strike) ?? mostAtm ?? null;

  const bars = useExplorer<(Bar & { spot: number | null })[]>(
    expiry && strike
      ? q({ view: "option", symbol, expiry, strike: strike.strike, type: pick.type, from, to, tf })
      : null
  );
  const spotLine = useMemo<Overlay | null>(
    () =>
      bars.data
        ? {
            label: "Spot",
            points: bars.data.filter((b) => b.spot != null).map((b) => ({ t: b.t, v: b.spot as number })),
          }
        : null,
    [bars.data]
  );

  const controls = (
    <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
      {expiries.length > 1 ? (
        <label className="flex items-center gap-1 text-muted">
          Expiry
          <select
            value={expiry ?? ""}
            onChange={(e) => setPick({ ...pick, expiry: e.target.value, strike: null })}
            className="rounded-[4px] border border-line bg-surface px-1.5 py-0.5 text-ink"
          >
            {expiries.map((e) => (
              <option key={e} value={e}>
                {dayLabel(e)} {e.slice(0, 4)}
              </option>
            ))}
          </select>
        </label>
      ) : expiry ? (
        <span className="text-muted">Expiry {dayLabel(expiry)}</span>
      ) : null}
      <Segmented
        value={pick.type}
        options={[
          ["CE", "Call"],
          ["PE", "Put"],
        ]}
        onChange={(type) => setPick({ ...pick, type })}
      />
      <label className="flex items-center gap-1 text-muted">
        Strike
        <select
          value={strike?.strike ?? ""}
          onChange={(e) => setPick({ ...pick, expiry, strike: Number(e.target.value) })}
          className="rounded-[4px] border border-line bg-surface px-1.5 py-0.5 text-ink"
        >
          {strikes.map((c) => (
            <option key={c.strike} value={c.strike}>
              {grouped(c.strike, c.strike % 1 ? 1 : 0)}
              {c.atmMinutes ? ` · ATM ${grouped(c.atmMinutes)} min` : ""}
            </option>
          ))}
        </select>
      </label>
    </div>
  );

  return (
    <Card title="Options" hint="ATM±3 band, 1-minute · line: underlying (left scale)" right={list.length ? controls : null}>
      {contracts.error ? (
        <p className="py-6 text-[12px] text-neg">{contracts.error}</p>
      ) : contracts.loading ? (
        <p className="py-6 text-[12px] text-muted">Loading contracts…</p>
      ) : !list.length ? (
        <p className="py-6 text-[12px] text-muted">No option minute data for {symbol} in this month.</p>
      ) : (
        <>
          <ChartState state={bars} empty="No bars for this contract.">
            {(b) => (
              <TimeChart
                bars={b}
                mainLabel={`${symbol} ${strike ? grouped(strike.strike, strike.strike % 1 ? 1 : 0) : ""} ${pick.type}`}
                overlay={spotLine}
                daily={tf === "D"}
              />
            )}
          </ChartState>
          {strike ? (
            <p className="mt-2 text-[10.5px] text-faint">
              This strike has minute bars on {dayLabel(strike.first)} – {dayLabel(strike.last)} only: the download keeps
              the 7 strikes nearest the price each minute, so a strike drops out when the price moves away from it.
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}
