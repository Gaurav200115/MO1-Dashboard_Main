"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { grouped } from "@/lib/format";

/**
 * The analysis panel's charts, in their own module so recharts downloads only
 * when the panel is opened (the same arrangement as StockChart).
 *
 * The desk's red and green fail colour-blind separation (see RotationGraph), so
 * no chart here relies on them alone: P&L bars carry their sign by which side
 * of the zero line they stand, the R histogram by its band label, and the
 * equity curve is a single accent series.
 */

const AXIS = "var(--muted)";
const GRID = "var(--line)";

/** Zero always on the axis: a P&L bar must stand on the baseline, never hang from the frame. */
const withZero: [(min: number) => number, (max: number) => number] = [
  (min) => Math.min(0, min),
  (max) => Math.max(0, max),
];

const axis = {
  stroke: AXIS,
  tick: { fill: AXIS, fontSize: 10.5 },
  tickLine: false,
  axisLine: false,
} as const;

function short(v: number): string {
  const a = Math.abs(v);
  const s = v < 0 ? "−" : "";
  if (a >= 100000) return `${s}₹${(a / 100000).toFixed(1)}L`;
  if (a >= 1000) return `${s}₹${(a / 1000).toFixed(1)}k`;
  return `${s}₹${Math.round(a)}`;
}

function signed(v: number): string {
  const r = Math.round(v);
  return `${r >= 0 ? "+" : "−"}₹${grouped(Math.abs(r))}`;
}

function Tip({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="rounded-[5px] border border-linestrong bg-surface px-2.5 py-2 text-[11px] shadow-sm">
      <div className="mb-1 text-[10.5px] text-muted">{title}</div>
      <div className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 font-mono text-[10.5px]">
        {rows.map(([k, v]) => (
          <span key={k} className="contents">
            <span className="text-muted">{k}</span>
            <span className="tnum text-right text-ink">{v}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export interface EquityPoint {
  n: number;
  cum: number;
  profit: number;
  label: string;
}

/** Cumulative P&L trade by trade — one series, so no legend; the title names it. */
export function EquityChart({ data }: { data: EquityPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={230}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="taEquity" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.25} />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="n" {...axis} minTickGap={24} />
        <YAxis {...axis} width={58} tickFormatter={short} domain={withZero} />
        <ReferenceLine y={0} stroke={AXIS} strokeDasharray="3 3" />
        <Tooltip
          cursor={{ stroke: AXIS, strokeWidth: 1 }}
          content={({ active, payload }) => {
            const d = payload?.[0]?.payload as EquityPoint | undefined;
            if (!active || !d) return null;
            return (
              <Tip
                title={`Trade ${d.n} · ${d.label}`}
                rows={[
                  ["Trade", signed(d.profit)],
                  ["Cumulative", signed(d.cum)],
                ]}
              />
            );
          }}
        />
        <Area
          type="linear"
          dataKey="cum"
          stroke="var(--accent)"
          strokeWidth={2}
          fill="url(#taEquity)"
          dot={false}
          activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------

export interface PnlBar {
  key: string;
  label: string;
  title: string;
  net: number;
  trades: number;
  winRate: number | null;
}

/** Net P&L per bucket, diverging about a zero baseline. */
export function PnlBars({ data, height = 220 }: { data: PnlBar[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="16%">
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="label" {...axis} minTickGap={12} />
        <YAxis {...axis} width={58} tickFormatter={short} domain={withZero} />
        <ReferenceLine y={0} stroke={AXIS} />
        <Tooltip
          cursor={{ fill: "var(--surface-2)", fillOpacity: 0.6 }}
          content={({ active, payload }) => {
            const d = payload?.[0]?.payload as PnlBar | undefined;
            if (!active || !d) return null;
            return (
              <Tip
                title={d.title}
                rows={[
                  ["Net P&L", signed(d.net)],
                  ["Trades", String(d.trades)],
                  ["Win rate", d.winRate === null ? "—" : `${Math.round(d.winRate * 100)}%`],
                ]}
              />
            );
          }}
        />
        <Bar dataKey="net" radius={[3, 3, 0, 0]} isAnimationActive={false}>
          {data.map((d) => (
            <Cell key={d.key} fill={d.net >= 0 ? "var(--pos)" : "var(--neg)"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------

export interface RBand {
  key: string;
  label: string;
  count: number;
  net: number;
  negative: boolean;
}

/** How many trades closed in each band of planned risk. */
export function RChart({ data }: { data: RBand[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="14%">
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="label" {...axis} interval={0} />
        <YAxis {...axis} width={30} allowDecimals={false} />
        <Tooltip
          cursor={{ fill: "var(--surface-2)", fillOpacity: 0.6 }}
          content={({ active, payload }) => {
            const d = payload?.[0]?.payload as RBand | undefined;
            if (!active || !d) return null;
            return (
              <Tip
                title={d.label}
                rows={[
                  ["Trades", String(d.count)],
                  ["Net P&L", signed(d.net)],
                ]}
              />
            );
          }}
        />
        <Bar
          dataKey="count"
          radius={[3, 3, 0, 0]}
          isAnimationActive={false}
          stroke="var(--surface)"
          strokeWidth={2}
        >
          {data.map((d) => (
            <Cell key={d.key} fill={d.negative ? "var(--neg)" : "var(--pos)"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
