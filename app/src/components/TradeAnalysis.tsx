"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { DASH, fmtPrice, grouped } from "@/lib/format";
import { istClock, istDate } from "@/lib/strategy/ist";
import {
  activeFilterCount,
  analyse,
  applyFilters,
  breakdown,
  clock,
  days as dayResults,
  DOW_LABELS,
  EMPTY_FILTERS,
  EXIT_LABELS,
  fmtDay,
  fmtHold,
  HOLD_LABELS,
  insights as buildInsights,
  matchPreset,
  medianHold,
  MIN_SAMPLE,
  NTH_LABELS,
  nthKey,
  presetRange,
  RANGE_PRESETS,
  rDistribution,
  slotKey,
  slotLabel,
  SLOT_MIN,
  stats as statsOf,
  TIME_PRESETS,
  type AnalysedTrade,
  type Bucket,
  type Day,
  type Filters,
  type HoldKey,
  type Stats,
} from "@/lib/strategy/analysis";
import type { StrategyTrade } from "@/lib/strategy/types";

/*
 * Recharts only downloads when this panel is opened — the same arrangement as
 * StockChart in CompanySheet.
 */
const chartLoading = () => (
  <div className="flex h-[220px] items-center justify-center text-[12px] text-muted">
    Loading chart…
  </div>
);
const EquityChart = dynamic(() => import("./TradeAnalysisCharts").then((m) => m.EquityChart), {
  ssr: false,
  loading: chartLoading,
});
const PnlBars = dynamic(() => import("./TradeAnalysisCharts").then((m) => m.PnlBars), {
  ssr: false,
  loading: chartLoading,
});
const RChart = dynamic(() => import("./TradeAnalysisCharts").then((m) => m.RChart), {
  ssr: false,
  loading: chartLoading,
});

const TABLE_LIMIT = 200;
const CALENDAR_MONTHS = 6;

/**
 * Trade analysis: the whole paper-trade record, filtered and sliced.
 *
 * The blotter answers "what happened today"; this answers "where does the edge
 * live" — longs against shorts, entries before 10 against after, trades that
 * died in ten seconds against ones that reached the trail, one strategy version
 * against the next. Every filter combines with AND, and every breakdown row is
 * itself a filter: click it to narrow to that slice.
 */
export default function TradeAnalysis() {
  const [raw, setRaw] = useState<StrategyTrade[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [f, setF] = useState<Filters>(EMPTY_FILTERS);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/trades?range=1")
      .then(async (response) => {
        const payload = (await response.json()) as { trades?: StrategyTrade[]; error?: string };
        if (!response.ok || payload.error) throw new Error(payload.error ?? `HTTP ${response.status}`);
        setRaw(payload.trades ?? []);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load trades"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const set = useCallback((patch: Partial<Filters>) => setF((cur) => ({ ...cur, ...patch })), []);

  const all = useMemo(() => analyse(raw ?? []), [raw]);
  const rows = useMemo(() => applyFilters(all, f), [all, f]);
  const openCount = useMemo(() => (raw ?? []).filter((t) => t.status === "open").length, [raw]);

  // Options come from the data, so a filter never offers a value with no trades behind it.
  const options = useMemo(() => {
    const strategies = new Map<string, { name: string; versions: Set<number> }>();
    const setups = new Map<string, string>();
    const pivots = new Set<string>();
    for (const { trade: t, setupKey } of all) {
      const s = strategies.get(t.strategyId) ?? { name: t.strategyName, versions: new Set() };
      s.versions.add(t.strategyVersion);
      strategies.set(t.strategyId, s);
      setups.set(setupKey, `${t.setupLabel} (${t.setup})`);
      if (t.trigger?.level?.pivot) pivots.add(t.trigger.level.pivot);
    }
    return { strategies, setups, pivots: [...pivots].sort() };
  }, [all]);

  if (raw === null) {
    return (
      <Panel title="Trade analysis">
        <p className="px-4 py-4 text-[12px] text-muted">{error ? error : "Loading the trade record…"}</p>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <FilterBar
        f={f}
        set={set}
        reset={() => setF((cur) => ({ ...EMPTY_FILTERS, from: cur.from, to: cur.to }))}
        options={options}
        shown={rows.length}
        total={all.length}
        openCount={openCount}
        loading={loading}
        onRefresh={load}
      />

      {error ? <p className="text-[12px] text-neg">{error}</p> : null}

      {rows.length === 0 ? (
        <Panel title="No trades">
          <p className="px-4 py-4 text-[12px] text-muted">
            {all.length === 0
              ? "No closed paper trades on record yet. The engine logs one every time a setup fires."
              : "Nothing matches these filters. They combine with AND — loosen one or two."}
          </p>
        </Panel>
      ) : (
        <Results rows={rows} set={set} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function Results({ rows, set }: { rows: AnalysedTrade[]; set: (p: Partial<Filters>) => void }) {
  const s = useMemo(() => statsOf(rows), [rows]);
  const dayList = useMemo(() => dayResults(rows), [rows]);
  const notes = useMemo(() => buildInsights(rows, s), [rows, s]);

  const green = dayList.filter((d) => d.net > 0).length;
  const red = dayList.filter((d) => d.net < 0).length;
  const bestDay = dayList.reduce((b, d) => (d.net > b.net ? d : b), dayList[0]);
  const worstDay = dayList.reduce((w, d) => (d.net < w.net ? d : w), dayList[0]);
  const payoff = s.avgWin !== null && s.avgLoss ? s.avgWin / s.avgLoss : null;

  const b = useMemo(() => {
    const slotKeys = [...new Set(rows.map((a) => slotKey(a.entryMin)))].sort((x, y) => Number(x) - Number(y));
    const strategyName = (k: string) => {
      const t = rows.find((a) => a.strategyKey === k)!.trade;
      return `${t.strategyName} v${t.strategyVersion}`;
    };
    const setupName = (k: string) => {
      const t = rows.find((a) => a.setupKey === k)!.trade;
      return `${t.setupLabel} (${t.setup})`;
    };
    return {
      side: breakdown(rows, (a) => a.trade.side, (k) => k, ["LONG", "SHORT"]),
      slot: breakdown(rows, (a) => slotKey(a.entryMin), slotLabel, slotKeys),
      tenAm: breakdown(rows, (a) => (a.entryMin < 600 ? "pre" : "post"), (k) => (k === "pre" ? "Before 10 AM" : "10 AM onwards"), ["pre", "post"]),
      dow: breakdown(rows, (a) => String(a.dow), (k) => DOW_LABELS[Number(k)], ["1", "2", "3", "4", "5"]),
      hold: breakdown(rows, (a) => a.hold, (k) => HOLD_LABELS[k as HoldKey], Object.keys(HOLD_LABELS)),
      nth: breakdown(rows, (a) => nthKey(a.nth), (k) => NTH_LABELS[k as keyof typeof NTH_LABELS], Object.keys(NTH_LABELS)),
      strategy: breakdown(rows, (a) => a.strategyKey, strategyName),
      setup: breakdown(rows, (a) => a.setupKey, setupName),
      exit: breakdown(rows, (a) => a.trade.sell?.reason ?? null, (k) => EXIT_LABELS[k] ?? k),
      option: breakdown(rows, (a) => a.trade.instrument.type, (k) => (k === "CE" ? "Calls (CE)" : "Puts (PE)"), ["CE", "PE"]),
      level: breakdown(rows, (a) => a.trade.trigger?.level?.kind ?? null, (k) => (k === "support" ? "Off a support" : "Off a resistance"), ["support", "resistance"]),
      pivot: breakdown(rows, (a) => a.trade.trigger?.level?.pivot ?? null, (k) => k),
      trailed: breakdown(rows, (a) => (a.trade.step > 1 ? "yes" : "no"), (k) => (k === "yes" ? "Reached the trail" : "Never trailed"), ["yes", "no"]),
      symbol: breakdown(rows, (a) => a.trade.symbol, (k) => k),
    };
  }, [rows]);

  const equity = useMemo(() => {
    let cum = 0;
    return rows.map((a, i) => {
      cum += a.profit;
      return { n: i + 1, cum, profit: a.profit, label: `${a.trade.symbol} · ${fmtDay(a.date)} ${istClock(a.trade.buy.at).slice(0, 5)}` };
    });
  }, [rows]);

  const dailyBars = dayList.map((d) => ({
    key: d.date,
    label: d.date.slice(5),
    title: fmtDay(d.date),
    net: d.net,
    trades: d.trades,
    winRate: d.wins + d.losses ? d.wins / (d.wins + d.losses) : null,
  }));
  const slotBars = b.slot.map((x) => ({
    key: x.key,
    label: clock(Number(x.key)),
    title: x.label,
    net: x.stats.net,
    trades: x.stats.trades,
    winRate: x.stats.winRate,
  }));

  const recent = [...rows].reverse().slice(0, TABLE_LIMIT);

  return (
    <>
      {/* ---------------- headline ---------------- */}
      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <Tile label="Net P&L" value={<Money v={s.net} />} hint={`${grouped(Math.round(s.deployed))} premium deployed`} />
        <Tile
          label="Win rate"
          value={pct(s.winRate)}
          hint={`${s.wins}W · ${s.losses}L${s.scratches ? ` · ${s.scratches} flat` : ""}`}
        />
        <Tile
          label="Profit factor"
          value={s.profitFactor === null ? (s.wins ? "∞" : DASH) : s.profitFactor.toFixed(2)}
          tone={s.profitFactor === null ? (s.wins ? "pos" : undefined) : s.profitFactor >= 1 ? "pos" : "neg"}
          hint="gross wins ÷ gross losses"
        />
        <Tile
          label="Expectancy"
          value={<Money v={s.expectancy} />}
          hint={`per trade · avg ${s.avgR === null ? DASH : `${s.avgR.toFixed(2)}R`}`}
        />
        <Tile
          label="Avg win / avg loss"
          value={payoff === null ? DASH : `${payoff.toFixed(2)}×`}
          hint={`${s.avgWin === null ? DASH : `₹${grouped(Math.round(s.avgWin))}`} vs ${s.avgLoss === null ? DASH : `₹${grouped(Math.round(s.avgLoss))}`}`}
        />
        <Tile
          label="Max drawdown"
          value={<Money v={s.maxDrawdown} />}
          hint={`streaks ${s.maxWinStreak}W / ${s.maxLossStreak}L`}
        />
        <Tile
          label="Green days"
          value={`${green} / ${dayList.length}`}
          hint={`${red} red · avg ${signed(s.net / dayList.length)}/day`}
        />
        <Tile
          label="Median hold"
          value={fmtHold(medianHold(rows))}
          hint={`${(rows.length / dayList.length).toFixed(1)} trades per day`}
        />
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <MiniTile label="Best trade" value={<Money v={s.best} />} />
        <MiniTile label="Worst trade" value={<Money v={s.worst} />} />
        <MiniTile
          label="Best day"
          value={<Money v={bestDay.net} />}
          sub={fmtDay(bestDay.date)}
          onClick={() => set({ from: bestDay.date, to: bestDay.date })}
        />
        <MiniTile
          label="Worst day"
          value={<Money v={worstDay.net} />}
          sub={fmtDay(worstDay.date)}
          onClick={() => set({ from: worstDay.date, to: worstDay.date })}
        />
      </div>

      {/* ---------------- insights ---------------- */}
      {notes.length > 0 ? (
        <Panel
          title="What the numbers say"
          aside={`Buckets under ${MIN_SAMPLE} trades are ignored`}
        >
          <ul className="grid gap-2 p-4 md:grid-cols-2">
            {notes.map((n, i) => (
              <li
                key={i}
                className={`rounded-[5px] border-l-2 bg-sunken px-3 py-2 text-[12px] leading-snug text-ink2 ${
                  n.tone === "pos" ? "border-pos" : n.tone === "neg" ? "border-neg" : "border-linestrong"
                }`}
              >
                {n.text}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {/* ---------------- curves ---------------- */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Equity curve" aside="Cumulative P&L, trade by trade">
          <div className="p-3">
            <EquityChart data={equity} />
          </div>
        </Panel>
        <Panel title="Daily P&L" aside="One bar per session">
          <div className="p-3">
            <PnlBars data={dailyBars} />
          </div>
        </Panel>
      </div>

      <Panel title="P&L calendar" aside="Click a day to analyse just that session">
        <Calendar days={dayList} onPick={(d) => set({ from: d, to: d })} />
      </Panel>

      {/* ---------------- side ---------------- */}
      <Panel title="Longs vs shorts" aside="Click a side to filter">
        <SideBySide buckets={b.side} onPick={(k) => set({ side: k as Filters["side"] })} />
      </Panel>

      {/* ---------------- time of day ---------------- */}
      <div className="grid items-start gap-4 xl:grid-cols-[1.15fr_1fr]">
        <Panel title="Entry time of day" aside={`Net P&L by ${SLOT_MIN}-minute entry slot, IST`}>
          <div className="p-3">
            <PnlBars data={slotBars} />
          </div>
        </Panel>
        <Breakdown
          title="By entry slot"
          buckets={b.slot}
          onPick={(k) => set({ tfrom: clock(Number(k)), tto: clock(Number(k) + SLOT_MIN) })}
          footer={
            <BreakdownTable
              buckets={b.tenAm}
              onPick={(k) => (k === "pre" ? set({ tfrom: "", tto: "10:00" }) : set({ tfrom: "10:00", tto: "" }))}
            />
          }
        />
      </div>

      {/* ---------------- risk ---------------- */}
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Panel title="R-multiple distribution" aside="Profit in units of the planned risk">
          <div className="p-3">
            <RChart data={rDistribution(rows)} />
          </div>
        </Panel>
        <div className="flex flex-col gap-4">
          <Breakdown title="Holding time" buckets={b.hold} onPick={(k) => set({ hold: k as HoldKey })} />
          <Breakdown title="Trail" buckets={b.trailed} onPick={(k) => set({ trailed: k as Filters["trailed"] })} />
        </div>
      </div>

      {/* ---------------- dimensions ---------------- */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Breakdown title="Strategy & version" buckets={b.strategy} onPick={(k) => set({ strategy: k })} />
        <Breakdown title="Setup" buckets={b.setup} onPick={(k) => set({ setup: k })} />
        <Breakdown title="Exit reason" buckets={b.exit} onPick={(k) => set({ exit: k })} />
        <Breakdown title="Trade number of the day" buckets={b.nth} onPick={(k) => set({ nth: k as Filters["nth"] })} />
        <Breakdown title="Weekday" buckets={b.dow} onPick={(k) => set({ dow: [Number(k)] })} />
        <Breakdown title="Option type" buckets={b.option} onPick={(k) => set({ option: k as Filters["option"] })} />
        <Breakdown title="Trigger level" buckets={b.level} onPick={(k) => set({ level: k as Filters["level"] })} />
        <Breakdown title="Pivot" buckets={b.pivot} onPick={(k) => set({ pivot: k })} />
      </div>

      <Breakdown
        title="Symbols"
        aside={b.symbol.length > 20 ? "Top 10 and bottom 10 by net P&L" : "Best to worst by net P&L"}
        buckets={b.symbol.length > 20 ? [...b.symbol.slice(0, 10), ...b.symbol.slice(-10)] : b.symbol}
        onPick={(k) => set({ symbol: k })}
      />

      {/* ---------------- trade list ---------------- */}
      <Panel
        title={`Trades · ${rows.length}`}
        aside={rows.length > TABLE_LIMIT ? `Latest ${TABLE_LIMIT} shown` : "Newest first"}
      >
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-line text-[10px] uppercase tracking-[0.08em] text-muted">
                <Th className="text-left">Day</Th>
                <Th className="text-left">In</Th>
                <Th className="text-left">Stock</Th>
                <Th className="text-left">Strategy</Th>
                <Th className="text-left">Contract</Th>
                <Th>Buy</Th>
                <Th>Sell</Th>
                <Th>Held</Th>
                <Th className="text-left">Exit</Th>
                <Th>R</Th>
                <Th>P&amp;L</Th>
              </tr>
            </thead>
            <tbody>
              {recent.map((a) => (
                <tr key={a.id} className="border-t border-line hover:bg-surface2">
                  <Td className="text-left font-sans text-ink2">{fmtDay(a.date)}</Td>
                  <Td className="text-left">{istClock(a.trade.buy.at)}</Td>
                  <td className="px-3 py-1.5 align-top">
                    <span className="font-mono font-semibold">{a.trade.symbol}</span>
                    <SideTag side={a.trade.side} />
                  </td>
                  <td className="px-3 py-1.5 align-top text-[11.5px]">
                    {a.trade.strategyName}
                    <span className="block text-[10px] text-faint">
                      v{a.trade.strategyVersion} · {a.trade.setupLabel}
                    </span>
                  </td>
                  <Td className="text-left text-[11px]">{a.trade.instrument.tradingsymbol}</Td>
                  <Td>{fmtPrice(a.trade.buy.price)}</Td>
                  <Td>{fmtPrice(a.trade.sell?.price)}</Td>
                  <Td className="text-muted">{fmtHold(a.holdSec)}</Td>
                  <Td className="text-left font-sans text-[11px] text-ink2">
                    {EXIT_LABELS[a.trade.sell?.reason ?? ""] ?? a.trade.sell?.reason}
                    {a.trade.step > 1 ? <span className="ml-1 text-accent">×{a.trade.step - 1}</span> : null}
                  </Td>
                  <Td className="text-muted">{a.r === null ? DASH : `${a.r.toFixed(2)}R`}</Td>
                  <Td>
                    <Money v={a.profit} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

function FilterBar({
  f,
  set,
  reset,
  options,
  shown,
  total,
  openCount,
  loading,
  onRefresh,
}: {
  f: Filters;
  set: (p: Partial<Filters>) => void;
  reset: () => void;
  options: {
    strategies: Map<string, { name: string; versions: Set<number> }>;
    setups: Map<string, string>;
    pivots: string[];
  };
  shown: number;
  total: number;
  openCount: number;
  loading: boolean;
  onRefresh: () => void;
}) {
  const preset = matchPreset(f.from, f.to, istDate());
  const active = activeFilterCount(f);

  return (
    <section className="overflow-hidden rounded-md border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <h2 className="font-display text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
          Trade analysis
        </h2>
        <span className="rounded-[3px] border border-linestrong px-1.5 py-px text-[10px] uppercase tracking-[0.1em] text-muted">
          {shown} of {total} closed trades
        </span>
        {openCount > 0 ? (
          <span className="text-[10.5px] text-faint">
            {openCount} open position{openCount === 1 ? "" : "s"} excluded until closed
          </span>
        ) : null}
        <button
          type="button"
          onClick={onRefresh}
          className="ml-auto flex items-center gap-1.5 text-[11px] text-accent"
          title="Reload the trade record"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} aria-hidden />
          Refresh
        </button>
      </div>

      <div className="flex flex-col gap-3 px-4 py-3">
        <Row label="Date">
          <Chips
            options={RANGE_PRESETS.map((p) => ({ value: p.key, label: p.label }))}
            active={preset ?? ""}
            onSelect={(key) => set(presetRange(key, istDate()))}
          />
          <span className="flex items-center gap-1.5">
            <input
              type="date"
              aria-label="From date"
              value={f.from}
              onChange={(e) => set({ from: e.target.value })}
              className={inputCls}
            />
            <span className="text-[11px] text-faint">to</span>
            <input
              type="date"
              aria-label="To date"
              value={f.to}
              onChange={(e) => set({ to: e.target.value })}
              className={inputCls}
            />
          </span>
        </Row>

        <div className="grid gap-3 lg:grid-cols-2">
          <Row label="Side">
            <Chips
              options={[
                { value: "", label: "All" },
                { value: "LONG", label: "Longs" },
                { value: "SHORT", label: "Shorts" },
              ]}
              active={f.side}
              onSelect={(v) => set({ side: v as Filters["side"] })}
            />
          </Row>
          <Row label="Result">
            <Chips
              options={[
                { value: "", label: "All" },
                { value: "WIN", label: "Wins" },
                { value: "LOSS", label: "Losses" },
                { value: "BE", label: "Flat" },
              ]}
              active={f.outcome}
              onSelect={(v) => set({ outcome: v as Filters["outcome"] })}
            />
          </Row>
        </div>

        <Row label="Entry (IST)">
          <Chips
            options={[
              { value: "|", label: "Any time" },
              ...TIME_PRESETS.map((p) => ({ value: `${p.from}|${p.to}`, label: p.label })),
            ]}
            active={`${f.tfrom}|${f.tto}`}
            onSelect={(v) => {
              const [tfrom, tto] = v.split("|");
              set({ tfrom, tto });
            }}
          />
          <span className="flex items-center gap-1.5">
            <input
              type="time"
              aria-label="Entered at or after"
              value={f.tfrom}
              onChange={(e) => set({ tfrom: e.target.value })}
              className={inputCls}
            />
            <span className="text-[11px] text-faint">to</span>
            <input
              type="time"
              aria-label="Entered before"
              value={f.tto}
              onChange={(e) => set({ tto: e.target.value })}
              className={inputCls}
            />
          </span>
        </Row>

        <Row label="Weekday">
          <div className="flex flex-wrap gap-1">
            {[1, 2, 3, 4, 5].map((d) => {
              const on = f.dow.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    set({ dow: on ? f.dow.filter((x) => x !== d) : [...f.dow, d].sort() })
                  }
                  className={chipCls(on)}
                >
                  {DOW_LABELS[d].slice(0, 3)}
                </button>
              );
            })}
          </div>
        </Row>

        <div className="grid gap-2.5 border-t border-line pt-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-6">
          <Select label="Strategy" value={f.strategy} onChange={(v) => set({ strategy: v })}>
            <option value="">All strategies</option>
            {[...options.strategies.entries()].map(([id, s]) => (
              <optgroup key={id} label={s.name}>
                <option value={id}>All versions</option>
                {[...s.versions]
                  .sort((a, b) => a - b)
                  .map((v) => (
                    <option key={v} value={`${id}@${v}`}>
                      v{v} only
                    </option>
                  ))}
              </optgroup>
            ))}
          </Select>
          <Select label="Setup" value={f.setup} onChange={(v) => set({ setup: v })}>
            <option value="">All setups</option>
            {[...options.setups.entries()].map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
          <Select label="Exit reason" value={f.exit} onChange={(v) => set({ exit: v })}>
            <option value="">Any exit</option>
            {Object.entries(EXIT_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
          <Select label="Holding time" value={f.hold} onChange={(v) => set({ hold: v as HoldKey | "" })}>
            <option value="">Any duration</option>
            {Object.entries(HOLD_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
          <Select label="Trail" value={f.trailed} onChange={(v) => set({ trailed: v as Filters["trailed"] })}>
            <option value="">Any</option>
            <option value="yes">Reached the trail</option>
            <option value="no">Never trailed</option>
          </Select>
          <Select label="Trade # of day" value={f.nth} onChange={(v) => set({ nth: v as Filters["nth"] })}>
            <option value="">Any</option>
            {Object.entries(NTH_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
          <Select label="Option" value={f.option} onChange={(v) => set({ option: v as Filters["option"] })}>
            <option value="">CE and PE</option>
            <option value="CE">Calls (CE)</option>
            <option value="PE">Puts (PE)</option>
          </Select>
          <Select label="Trigger level" value={f.level} onChange={(v) => set({ level: v as Filters["level"] })}>
            <option value="">Any</option>
            <option value="support">Support</option>
            <option value="resistance">Resistance</option>
          </Select>
          <Select label="Pivot" value={f.pivot} onChange={(v) => set({ pivot: v })}>
            <option value="">Any pivot</option>
            {options.pivots.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
          <label className="flex flex-col gap-1">
            <span className="text-[10.5px] text-muted">Symbol</span>
            <input
              type="search"
              value={f.symbol}
              onChange={(e) => set({ symbol: e.target.value })}
              placeholder="e.g. RELIANCE"
              className={`${inputCls} w-full`}
            />
          </label>
        </div>
      </div>

      <div className="flex min-h-10 items-center justify-between border-t border-line px-4 py-2">
        <span className="text-[10.5px] text-faint">
          {active === 0
            ? "No filters beyond the date range."
            : `${active} filter${active === 1 ? "" : "s"} active · they combine with AND`}
        </span>
        {active > 0 ? (
          <button type="button" onClick={reset} className="flex items-center gap-1 text-[11px] text-accent">
            <X size={12} aria-hidden /> Clear filters
          </button>
        ) : null}
      </div>
    </section>
  );
}


const inputCls =
  "rounded-md border border-line bg-sunken px-2 py-1 font-mono text-[11.5px] text-ink";

function chipCls(on: boolean) {
  return `rounded-[4px] border px-2 py-0.5 text-[11.5px] ${
    on
      ? "border-accent bg-accentsoft font-semibold text-accent"
      : "border-line text-ink2 hover:bg-surface2"
  }`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-4">
      <span className="w-20 shrink-0 font-display text-[9.5px] font-bold uppercase tracking-[0.12em] text-faint">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

function Chips({
  options,
  active,
  onSelect,
}: {
  options: { value: string; label: string }[];
  active: string;
  onSelect: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={active === o.value}
          onClick={() => onSelect(o.value)}
          className={chipCls(active === o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10.5px] text-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-line bg-sunken px-2 py-1 text-[11.5px] text-ink"
      >
        {children}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Panel({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-md border border-line bg-surface">
      <div className="flex flex-wrap items-baseline gap-3 border-b border-line px-4 py-2.5">
        <h2 className="font-display text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
          {title}
        </h2>
        {aside ? <span className="ml-auto text-[10.5px] text-faint">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: "pos" | "neg";
}) {
  return (
    <div className="rounded-md border border-line bg-surface px-4 py-3">
      <div className="font-display text-[9.5px] font-bold uppercase tracking-[0.12em] text-faint">
        {label}
      </div>
      <div
        className={`tnum mt-1 font-mono text-[18px] font-semibold ${
          tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : "text-ink"
        }`}
      >
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-[10.5px] text-muted">{hint}</div> : null}
    </div>
  );
}

function MiniTile({
  label,
  value,
  sub,
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="font-display text-[9.5px] font-bold uppercase tracking-[0.12em] text-faint">
        {label}
      </span>
      <span className="flex items-baseline justify-between gap-2">
        <span className="tnum font-mono text-[13px]">{value}</span>
        {sub ? <span className="text-[10.5px] text-muted">{sub}</span> : null}
      </span>
    </>
  );
  const cls = "flex flex-col gap-1 rounded-md border border-line bg-surface px-4 py-2.5 text-left";
  return onClick ? (
    <button type="button" onClick={onClick} className={`${cls} hover:border-linestrong`} title="Analyse that day">
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function Breakdown({
  title,
  aside,
  buckets,
  onPick,
  footer,
}: {
  title: string;
  aside?: string;
  buckets: Bucket[];
  onPick: (key: string) => void;
  footer?: React.ReactNode;
}) {
  return (
    <Panel title={title} aside={aside ?? "Click a row to filter"}>
      {buckets.length === 0 ? (
        <p className="px-4 py-3 text-[12px] text-muted">Nothing to break down.</p>
      ) : (
        <BreakdownTable buckets={buckets} onPick={onPick} />
      )}
      {footer ? <div className="border-t-2 border-linestrong">{footer}</div> : null}
    </Panel>
  );
}

/** Label · trades · win % · net with a bar centred on zero · avg · PF. */
function BreakdownTable({ buckets, onPick }: { buckets: Bucket[]; onPick: (key: string) => void }) {
  const maxAbs = Math.max(1, ...buckets.map((x) => Math.abs(x.stats.net)));
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-[0.08em] text-muted">
            <Th className="text-left">&nbsp;</Th>
            <Th>Trades</Th>
            <Th>Win %</Th>
            <Th className="w-[36%]">Net P&amp;L</Th>
            <Th>Avg</Th>
            <Th>PF</Th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((x) => {
            const width = (Math.abs(x.stats.net) / maxAbs) * 50;
            const thin = x.stats.trades < MIN_SAMPLE;
            return (
              <tr key={x.key} className="border-t border-line hover:bg-surface2">
                <td className="px-3 py-1.5 align-top">
                  <button
                    type="button"
                    onClick={() => onPick(x.key)}
                    className="text-left text-[12px] text-ink hover:text-accent"
                  >
                    {x.label === "LONG" || x.label === "SHORT" ? <SideTag side={x.label} /> : x.label}
                  </button>
                </td>
                <Td className={thin ? "text-faint" : "text-ink2"}>{x.stats.trades}</Td>
                <Td className="text-ink2">{pct(x.stats.winRate)}</Td>
                <td className="px-3 py-1.5 align-top">
                  <div className="flex items-center gap-2">
                    {/* Losses grow left of centre, profits right — sign by position, not hue alone. */}
                    <div className="relative hidden h-[7px] flex-1 sm:block" aria-hidden>
                      <div className="absolute inset-y-[-2px] left-1/2 w-px bg-linestrong" />
                      <div
                        className={`absolute inset-y-0 rounded-[2px] ${x.stats.net >= 0 ? "bg-pos" : "bg-neg"}`}
                        style={{ width: `${width}%`, left: x.stats.net >= 0 ? "50%" : `${50 - width}%` }}
                      />
                    </div>
                    <span className="tnum w-[84px] shrink-0 text-right font-mono">
                      <Money v={x.stats.net} />
                    </span>
                  </div>
                </td>
                <Td className="text-ink2">{signed(x.stats.expectancy)}</Td>
                <Td className="text-ink2">
                  {x.stats.profitFactor === null ? (x.stats.wins ? "∞" : DASH) : x.stats.profitFactor.toFixed(2)}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SideBySide({ buckets, onPick }: { buckets: Bucket[]; onPick: (key: string) => void }) {
  const cols = (["LONG", "SHORT"] as const).map((k) => ({ k, s: buckets.find((x) => x.key === k)?.stats }));
  const lines: [string, (s: Stats) => React.ReactNode][] = [
    ["Trades", (s) => s.trades],
    ["Win rate", (s) => pct(s.winRate)],
    ["Net P&L", (s) => <Money v={s.net} />],
    ["Expectancy", (s) => <Money v={s.expectancy} />],
    ["Avg win", (s) => (s.avgWin === null ? DASH : `₹${grouped(Math.round(s.avgWin))}`)],
    ["Avg loss", (s) => (s.avgLoss === null ? DASH : `₹${grouped(Math.round(s.avgLoss))}`)],
    ["Profit factor", (s) => (s.profitFactor === null ? (s.wins ? "∞" : DASH) : s.profitFactor.toFixed(2))],
    ["Avg R", (s) => (s.avgR === null ? DASH : `${s.avgR.toFixed(2)}R`)],
    ["Best / worst", (s) => `${signed(s.best)} / ${signed(s.worst)}`],
    ["Max drawdown", (s) => <Money v={s.maxDrawdown} />],
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr>
            <Th className="text-left">&nbsp;</Th>
            {cols.map(({ k }) => (
              <Th key={k}>
                <button type="button" onClick={() => onPick(k)} title={`Filter to ${k.toLowerCase()}s`}>
                  <SideTag side={k} />
                </button>
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map(([label, render]) => (
            <tr key={label} className="border-t border-line">
              <td className="px-3 py-1.5 text-[11.5px] text-muted">{label}</td>
              {cols.map(({ k, s }) => (
                <Td key={k}>{s ? render(s) : DASH}</Td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Month grids, Monday first. Every cell prints its signed figure, so hue is never the only cue. */
function Calendar({ days, onPick }: { days: Day[]; onPick: (date: string) => void }) {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const months = [...new Set(days.map((d) => d.date.slice(0, 7)))].sort();
  const shown = months.slice(-CALENDAR_MONTHS).reverse();
  const maxAbs = Math.max(1, ...days.map((d) => Math.abs(d.net)));

  return (
    <div className="p-4">
      <div className="grid gap-5 md:grid-cols-2 2xl:grid-cols-3">
        {shown.map((month) => {
          const first = new Date(`${month}-01T00:00:00Z`);
          const lead = (first.getUTCDay() + 6) % 7;
          const count = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
          const net = days.filter((d) => d.date.startsWith(month)).reduce((s, d) => s + d.net, 0);
          return (
            <div key={month}>
              <div className="mb-1.5 flex items-baseline justify-between">
                <span className="text-[12px] font-semibold">
                  {first.toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" })}
                </span>
                <span className="tnum font-mono text-[11.5px]">
                  <Money v={net} />
                </span>
              </div>
              <div className="grid grid-cols-7 gap-1">
                {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
                  <span key={i} className="text-center text-[9.5px] text-faint">
                    {d}
                  </span>
                ))}
                {Array.from({ length: lead }, (_, i) => (
                  <span key={`l${i}`} />
                ))}
                {Array.from({ length: count }, (_, i) => {
                  const date = `${month}-${String(i + 1).padStart(2, "0")}`;
                  const d = byDate.get(date);
                  if (!d) {
                    return (
                      <span
                        key={date}
                        className="flex aspect-square justify-end rounded-[4px] border border-line p-1 text-[9px] text-faint opacity-60"
                      >
                        {i + 1}
                      </span>
                    );
                  }
                  // sqrt so one outsized day does not wash every other day out.
                  const depth = 12 + Math.round(Math.sqrt(Math.abs(d.net) / maxAbs) * 30);
                  const hue = d.net >= 0 ? "var(--pos)" : "var(--neg)";
                  return (
                    <button
                      key={date}
                      type="button"
                      onClick={() => onPick(date)}
                      title={`${fmtDay(date)} · ${signed(d.net)} · ${d.trades} trades (${d.wins}W ${d.losses}L)`}
                      className="flex aspect-square flex-col justify-between rounded-[4px] border p-1 hover:ring-2 hover:ring-accent"
                      style={{
                        background: `color-mix(in oklab, ${hue} ${depth}%, var(--surface))`,
                        borderColor: `color-mix(in oklab, ${hue} 45%, transparent)`,
                      }}
                    >
                      <span className="self-end text-[9px] text-ink2">{i + 1}</span>
                      <span className="tnum w-full truncate text-center font-mono text-[9px] font-semibold text-ink">
                        {compact(d.net)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {months.length > CALENDAR_MONTHS ? (
        <p className="mt-3 text-[10.5px] text-faint">
          Showing the latest {CALENDAR_MONTHS} of {months.length} months — narrow the date range for
          earlier ones.
        </p>
      ) : null}
    </div>
  );
}

function SideTag({ side }: { side: string }) {
  return (
    <span
      className={`ml-1 rounded-[3px] border px-1 py-px text-[9.5px] font-bold uppercase tracking-[0.08em] ${
        side === "SHORT" ? "border-neg/40 text-neg" : "border-pos/40 text-pos"
      }`}
    >
      {side}
    </span>
  );
}

function Money({ v }: { v: number }) {
  const r = Math.round(v);
  return (
    <span className={`font-semibold ${r > 0 ? "text-pos" : r < 0 ? "text-neg" : "text-ink"}`}>
      {signed(v)}
    </span>
  );
}

function signed(v: number): string {
  const r = Math.round(v);
  return `${r >= 0 ? "+" : "−"}₹${grouped(Math.abs(r))}`;
}

function compact(v: number): string {
  const a = Math.abs(v);
  const s = v < 0 ? "−" : "+";
  return a >= 1000 ? `${s}${(a / 1000).toFixed(1)}k` : `${s}${Math.round(a)}`;
}

function pct(v: number | null): string {
  return v === null ? DASH : `${Math.round(v * 100)}%`;
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={`whitespace-nowrap px-3 py-2 text-right font-medium ${className}`}>{children}</th>;
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`tnum whitespace-nowrap px-3 py-1.5 text-right align-top font-mono ${className}`}>{children}</td>;
}
