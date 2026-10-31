"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtCompact, grouped } from "@/lib/format";
import type { ChainDay, ChainRow } from "@/lib/marketdata/types";
import { q, useExplorer } from "@/lib/marketdata/useExplorer";
import { dayLabel } from "./OiMonth";

/**
 * The full option chain of one stock on one day, end of day from the NSE F&O bhavcopy: every
 * strike, not only the ATM±3 band the minute data covers. A bar chart of OI by strike (calls
 * against puts) and the chain table underneath.
 */

const AXIS = "var(--muted)";
const axis = { stroke: AXIS, tick: { fill: AXIS, fontSize: 10.5 }, tickLine: false, axisLine: false } as const;

type Measure = "oi" | "chgOi";
const WINDOWS = [10, 20, 0] as const; // strikes each side of ATM; 0 = all

function atmStrike(rows: ChainRow[], price: number | null): number | null {
  if (!rows.length || price == null) return null;
  return rows.reduce((best, r) => (Math.abs(r.strike - price) < Math.abs(best - price) ? r.strike : best), rows[0].strike);
}

function signed(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${v > 0 ? "+" : ""}${fmtCompact(v)}`;
}

export default function OptionChain({
  symbol,
  days,
  date,
  onDate,
}: {
  symbol: string;
  days: string[];
  date: string;
  onDate: (d: string) => void;
}) {
  const [expiry, setExpiry] = useState<string | null>(null);
  const [measure, setMeasure] = useState<Measure>("oi");
  const [width, setWidth] = useState<(typeof WINDOWS)[number]>(10);

  // A new stock has its own expiries; start again from its nearest.
  useEffect(() => setExpiry(null), [symbol]);

  const { data, error, loading } = useExplorer<ChainDay>(q({ view: "chain", symbol, date, expiry }));

  const price = data ? data.spot ?? data.future?.close ?? null : null;
  const atm = data ? atmStrike(data.rows, price) : null;

  const totals = useMemo(() => {
    if (!data) return null;
    let ce = 0;
    let pe = 0;
    let maxCe: ChainRow | null = null;
    let maxPe: ChainRow | null = null;
    for (const r of data.rows) {
      ce += r.ce?.oi ?? 0;
      pe += r.pe?.oi ?? 0;
      if (r.ce && (!maxCe || r.ce.oi > (maxCe.ce?.oi ?? 0))) maxCe = r;
      if (r.pe && (!maxPe || r.pe.oi > (maxPe.pe?.oi ?? 0))) maxPe = r;
    }
    return { ce, pe, pcr: ce ? pe / ce : null, maxCe: maxCe?.strike ?? null, maxPe: maxPe?.strike ?? null };
  }, [data]);

  const chartRows = useMemo(() => {
    if (!data) return [];
    const i = atm != null ? data.rows.findIndex((r) => r.strike === atm) : -1;
    const rows = width && i >= 0 ? data.rows.slice(Math.max(0, i - width), i + width + 1) : data.rows;
    return rows.map((r) => ({
      strike: r.strike,
      ce: measure === "oi" ? r.ce?.oi ?? 0 : r.ce?.chgOi ?? 0,
      pe: measure === "oi" ? r.pe?.oi ?? 0 : r.pe?.chgOi ?? 0,
    }));
  }, [data, atm, width, measure]);

  const index = days.indexOf(date);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={index <= 0}
            onClick={() => onDate(days[index - 1])}
            className="rounded-[4px] border border-line px-2 py-0.5 text-ink2 hover:bg-surface2 disabled:opacity-40"
            aria-label="Previous trading day"
          >
            ‹
          </button>
          <select
            value={date}
            onChange={(e) => onDate(e.target.value)}
            className="rounded-[4px] border border-line bg-surface px-1.5 py-0.5 text-ink"
            aria-label="Day"
          >
            {days.map((d) => (
              <option key={d} value={d}>
                {dayLabel(d)}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={index < 0 || index >= days.length - 1}
            onClick={() => onDate(days[index + 1])}
            className="rounded-[4px] border border-line px-2 py-0.5 text-ink2 hover:bg-surface2 disabled:opacity-40"
            aria-label="Next trading day"
          >
            ›
          </button>
        </div>
        {data?.expiries.length ? (
          <label className="flex items-center gap-1 text-muted">
            Expiry
            <select
              value={data.expiry ?? ""}
              onChange={(e) => setExpiry(e.target.value)}
              className="rounded-[4px] border border-line bg-surface px-1.5 py-0.5 text-ink"
            >
              {data.expiries.map((e) => (
                <option key={e} value={e}>
                  {dayLabel(e)} {e.slice(0, 4)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <Segmented
          value={measure}
          options={[
            ["oi", "OI"],
            ["chgOi", "Change in OI"],
          ]}
          onChange={setMeasure}
        />
        <Segmented
          value={String(width)}
          options={WINDOWS.map((w) => [String(w), w ? `ATM ±${w}` : "All strikes"] as [string, string])}
          onChange={(v) => setWidth(Number(v) as (typeof WINDOWS)[number])}
        />
      </div>

      {error ? (
        <p className="text-[12px] text-neg">{error}</p>
      ) : loading || !data ? (
        <p className="text-[12px] text-muted">Loading the chain…</p>
      ) : !data.rows.length ? (
        <p className="text-[12px] text-muted">No option rows for {symbol} on {dayLabel(date)}.</p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11.5px] sm:grid-cols-4 lg:grid-cols-7">
            <Fact label="Spot close" value={data.spot != null ? grouped(data.spot, 2) : "—"} />
            <Fact
              label="Future"
              value={data.future?.close != null ? grouped(data.future.close, 2) : "—"}
              sub={data.future ? `OI ${signed(data.future.chgOi)}` : undefined}
            />
            <Fact label="PCR (this expiry)" value={totals?.pcr != null ? totals.pcr.toFixed(2) : "—"} />
            <Fact label="Max pain" value={data.maxPain != null ? grouped(data.maxPain, 2) : "—"} />
            <Fact label="Most call OI" value={totals?.maxCe != null ? grouped(totals.maxCe, 2) : "—"} tone="text-neg" />
            <Fact label="Most put OI" value={totals?.maxPe != null ? grouped(totals.maxPe, 2) : "—"} tone="text-pos" />
            <Fact label="Lot size" value={data.lotSize != null ? grouped(data.lotSize) : "—"} />
          </dl>

          <div className="h-[260px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartRows} margin={{ top: 14, right: 4, bottom: 0, left: 0 }} barGap={1}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis dataKey="strike" {...axis} minTickGap={8} tickFormatter={(v: number) => grouped(v, v % 1 ? 1 : 0)} />
                <YAxis {...axis} width={58} tickFormatter={(v: number) => fmtCompact(v)} />
                <Tooltip
                  cursor={{ fill: "var(--surface-2)", fillOpacity: 0.6 }}
                  content={({ active, payload }) => {
                    const r = payload?.[0]?.payload as { strike: number; ce: number; pe: number } | undefined;
                    if (!active || !r) return null;
                    const fmt = measure === "oi" ? fmtCompact : signed;
                    return (
                      <div className="rounded-[5px] border border-linestrong bg-surface px-2.5 py-2 text-[11px] shadow-sm">
                        <div className="mb-1 text-[10.5px] text-muted">Strike {grouped(r.strike, 2)}</div>
                        <div className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 font-mono text-[10.5px]">
                          <span className="text-neg">Calls</span>
                          <span className="tnum text-right text-ink">{fmt(r.ce)}</span>
                          <span className="text-pos">Puts</span>
                          <span className="tnum text-right text-ink">{fmt(r.pe)}</span>
                        </div>
                      </div>
                    );
                  }}
                />
                {measure === "chgOi" ? <ReferenceLine y={0} stroke={AXIS} /> : null}
                {atm != null ? (
                  <ReferenceLine
                    x={atm}
                    stroke="var(--accent)"
                    strokeDasharray="3 3"
                    label={{ value: "ATM", position: "top", fill: "var(--accent)", fontSize: 10 }}
                  />
                ) : null}
                {data.maxPain != null && data.maxPain !== atm ? (
                  <ReferenceLine
                    x={data.maxPain}
                    stroke="var(--alert)"
                    strokeDasharray="3 3"
                    label={{ value: "Max pain", position: "top", fill: "var(--alert)", fontSize: 10 }}
                  />
                ) : null}
                <Bar dataKey="ce" name="Calls" fill="var(--neg)" fillOpacity={0.8} maxBarSize={12} />
                <Bar dataKey="pe" name="Puts" fill="var(--pos)" fillOpacity={0.8} maxBarSize={12} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="-mt-1 flex flex-wrap gap-x-4 text-[10.5px] text-muted">
            <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-neg" />Calls</span>
            <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-pos" />Puts</span>
            <span>
              {measure === "oi" ? "Open interest" : "Change in open interest from the day before"} by strike, in
              shares, end of day {dayLabel(date)}.
            </span>
          </p>

          <ChainTable rows={data.rows} atm={atm} price={price} maxCe={totals?.maxCe ?? null} maxPe={totals?.maxPe ?? null} />
        </>
      )}
    </div>
  );
}

function ChainTable({
  rows,
  atm,
  price,
  maxCe,
  maxPe,
}: {
  rows: ChainRow[];
  atm: number | null;
  price: number | null;
  maxCe: number | null;
  maxPe: number | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const atmRow = useRef<HTMLTableRowElement>(null);

  // Open on the money, not on the deepest in-the-money strike at the top of the list.
  useEffect(() => {
    const b = box.current;
    const r = atmRow.current;
    if (b && r) b.scrollTop = r.offsetTop - b.clientHeight / 2 + r.clientHeight / 2;
  }, [rows, atm]);

  const cell = "tnum px-2 py-[3px] text-right";
  return (
    <div ref={box} className="relative max-h-[440px] overflow-auto rounded-[5px] border border-line">
      <table className="w-full min-w-[720px] border-collapse font-mono text-[11.5px]">
        <thead className="sticky top-0 z-10 font-sans text-[10px] uppercase tracking-[0.08em] text-muted [&_th]:bg-surface2 [&_th]:shadow-[inset_0_-1px_0_var(--line)]">
          <tr>
            <th colSpan={4} className="py-1 text-center font-semibold text-neg">Calls</th>
            <th />
            <th colSpan={4} className="py-1 text-center font-semibold text-pos">Puts</th>
          </tr>
          <tr>
            <th className="px-2 py-1 text-right font-semibold">OI</th>
            <th className="px-2 text-right font-semibold">Chg OI</th>
            <th className="px-2 text-right font-semibold">Contracts</th>
            <th className="px-2 text-right font-semibold">Close</th>
            <th className="px-2 text-center font-semibold text-ink">Strike</th>
            <th className="px-2 text-right font-semibold">Close</th>
            <th className="px-2 text-right font-semibold">Contracts</th>
            <th className="px-2 text-right font-semibold">Chg OI</th>
            <th className="px-2 text-right font-semibold">OI</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isAtm = r.strike === atm;
            // In the money: calls below the price, puts above it.
            const ceItm = price != null && r.strike < price;
            const peItm = price != null && r.strike > price;
            return (
              <tr
                key={r.strike}
                ref={isAtm ? atmRow : undefined}
                className={`border-b border-line/50 ${isAtm ? "bg-accentsoft" : ""}`}
              >
                <td className={`${cell} ${ceItm && !isAtm ? "bg-surface2" : ""} ${r.strike === maxCe ? "font-semibold text-neg" : "text-ink2"}`}>
                  {r.ce ? fmtCompact(r.ce.oi) : "—"}
                </td>
                <td className={`${cell} ${ceItm && !isAtm ? "bg-surface2" : ""} ${(r.ce?.chgOi ?? 0) >= 0 ? "text-pos" : "text-neg"}`}>
                  {r.ce ? signed(r.ce.chgOi) : "—"}
                </td>
                <td className={`${cell} ${ceItm && !isAtm ? "bg-surface2" : ""} text-muted`}>{r.ce ? grouped(r.ce.contracts) : "—"}</td>
                <td className={`${cell} ${ceItm && !isAtm ? "bg-surface2" : ""} text-ink`}>
                  {r.ce?.close != null ? grouped(r.ce.close, 2) : "—"}
                </td>
                <td className={`px-2 text-center font-semibold ${isAtm ? "text-accent" : "text-ink"}`}>{grouped(r.strike, r.strike % 1 ? 1 : 0)}</td>
                <td className={`${cell} ${peItm && !isAtm ? "bg-surface2" : ""} text-ink`}>
                  {r.pe?.close != null ? grouped(r.pe.close, 2) : "—"}
                </td>
                <td className={`${cell} ${peItm && !isAtm ? "bg-surface2" : ""} text-muted`}>{r.pe ? grouped(r.pe.contracts) : "—"}</td>
                <td className={`${cell} ${peItm && !isAtm ? "bg-surface2" : ""} ${(r.pe?.chgOi ?? 0) >= 0 ? "text-pos" : "text-neg"}`}>
                  {r.pe ? signed(r.pe.chgOi) : "—"}
                </td>
                <td className={`${cell} ${peItm && !isAtm ? "bg-surface2" : ""} ${r.strike === maxPe ? "font-semibold text-pos" : "text-ink2"}`}>
                  {r.pe ? fmtCompact(r.pe.oi) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Fact({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.08em] text-muted">{label}</dt>
      <dd className={`tnum font-mono text-[12.5px] ${tone ?? "text-ink"}`}>
        {value}
        {sub ? <span className="ml-1.5 text-[10.5px] text-muted">{sub}</span> : null}
      </dd>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-[4px] border border-line">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          aria-pressed={v === value}
          className={`px-2 py-0.5 text-[11px] ${
            v === value ? "bg-accentsoft font-semibold text-accent" : "text-ink2 hover:bg-surface2"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
