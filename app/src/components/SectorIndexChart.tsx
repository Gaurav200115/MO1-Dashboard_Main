"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { grouped } from "@/lib/format";
import { BENCHMARK } from "@/lib/sector/types";

/**
 * The stored chain for one sector, against the whole-universe benchmark.
 *
 * Both lines are index levels off the same base date and the same base value,
 * so they belong on one scale — the gap between them *is* the relative
 * performance, which is the thing worth seeing. A second axis would let a
 * sector that has done nothing look like it tracked the market.
 *
 * The benchmark is drawn as a recessive dashed grey rather than a second
 * coloured series: it is the reference the sector is measured against, not a
 * peer competing for attention.
 */

const WINDOWS = [
  { key: "1M", sessions: 21 },
  { key: "3M", sessions: 63 },
  { key: "6M", sessions: 126 },
  { key: "1Y", sessions: 252 },
  { key: "Max", sessions: Number.POSITIVE_INFINITY },
] as const;

type WindowKey = (typeof WINDOWS)[number]["key"];

/** One stored session, as the series endpoint sends it. */
interface LinePoint {
  d: string;
  v: number;
}

interface Payload {
  lines?: Record<string, LinePoint[]>;
  meta?: { base: { date: string; level: number }; from: string; to: string };
  reason?: string;
}

interface Row {
  date: string;
  sector: number | null;
  bench: number | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function label(date: string): string {
  const [, month, day] = date.split("-");
  return `${parseInt(day, 10)} ${MONTHS[parseInt(month, 10) - 1]}`;
}

function ChartTooltip({
  active,
  payload,
  sector,
}: {
  active?: boolean;
  payload?: { payload: Row }[];
  sector: string;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;

  const spread =
    row.sector != null && row.bench != null ? (row.sector / row.bench - 1) * 100 : null;

  return (
    <div className="rounded-[5px] border border-linestrong bg-surface px-2.5 py-2 text-[11px] shadow-sm">
      <div className="mb-1 text-[10.5px] text-muted">{row.date}</div>
      <div className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 font-mono text-[10.5px]">
        <span className="text-accent">{sector}</span>
        <span className="tnum text-right">{row.sector == null ? "—" : grouped(row.sector, 2)}</span>
        <span className="text-muted">{BENCHMARK}</span>
        <span className="tnum text-right">{row.bench == null ? "—" : grouped(row.bench, 2)}</span>
        <span className="text-muted">Since base</span>
        <span className={`tnum text-right ${spread == null ? "" : spread >= 0 ? "text-pos" : "text-neg"}`}>
          {spread == null ? "—" : `${spread >= 0 ? "+" : "−"}${Math.abs(spread).toFixed(2)}pp`}
        </span>
      </div>
    </div>
  );
}

export default function SectorIndexChart({ sector }: { sector: string }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [window, setWindow] = useState<WindowKey>("3M");

  useEffect(() => {
    let alive = true;
    setPayload(null);
    setError(null);

    fetch(`/api/sectors?view=series&sector=${encodeURIComponent(sector)}`)
      .then((response) => {
        if (!response.ok) throw new Error(`Chain unavailable (${response.status})`);
        return response.json() as Promise<Payload>;
      })
      .then((data) => {
        if (alive) setPayload(data);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : "Chain unavailable");
      });

    return () => {
      alive = false;
    };
  }, [sector]);

  const rows = useMemo<Row[]>(() => {
    const lines = payload?.lines;
    if (!lines) return [];
    const own = lines[sector] ?? [];
    const bench = new Map((lines[BENCHMARK] ?? []).map((point) => [point.d, point.v]));

    const sessions = WINDOWS.find((entry) => entry.key === window)?.sessions ?? 63;
    const sliced = Number.isFinite(sessions) ? own.slice(-sessions) : own;

    return sliced.map((point) => ({
      date: point.d,
      sector: point.v,
      bench: bench.get(point.d) ?? null,
    }));
  }, [payload, sector, window]);

  if (error) return <p className="py-4 text-[12px] text-muted">{error}</p>;
  if (payload?.reason === "no-history") {
    return (
      <p className="py-4 text-[12px] text-muted">
        No stored chain yet — run the backfill and this sector gets a real index history.
      </p>
    );
  }
  if (!payload) return <p className="py-4 text-[12px] text-faint">Loading chain…</p>;
  if (rows.length < 2) {
    return <p className="py-4 text-[12px] text-muted">Not enough stored sessions to draw yet.</p>;
  }

  const last = rows[rows.length - 1];
  const first = rows[0];
  const move =
    first.sector != null && last.sector != null ? (last.sector / first.sector - 1) * 100 : null;
  const benchMove =
    first.bench != null && last.bench != null ? (last.bench / first.bench - 1) * 100 : null;

  return (
    <section className="rounded-md border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
        <h3 className="font-display text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
          Chained index · base 1,000 on {payload.meta?.base.date ?? "—"}
        </h3>

        {/* The one direct reading the chart is for, stated rather than measured
            off the axis: did this sector beat the market over the window. */}
        {move != null && benchMove != null ? (
          <span className="flex items-center gap-2 text-[11px]">
            <span className="text-accent">
              {window} {move >= 0 ? "+" : "−"}
              {Math.abs(move).toFixed(2)}%
            </span>
            <span className={move - benchMove >= 0 ? "text-pos" : "text-neg"}>
              {move - benchMove >= 0 ? "+" : "−"}
              {Math.abs(move - benchMove).toFixed(2)}pp vs {BENCHMARK}
            </span>
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-px">
          {WINDOWS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => setWindow(entry.key)}
              aria-current={window === entry.key}
              className={`rounded-[4px] px-2 py-1 text-[11px] ${
                window === entry.key
                  ? "bg-accentsoft font-semibold text-accent"
                  : "text-muted hover:bg-surface2"
              }`}
            >
              {entry.key}
            </button>
          ))}
        </div>
      </div>

      <div className="h-[220px] w-full px-2 py-3">
        <ResponsiveContainer>
          <LineChart data={rows} margin={{ top: 6, right: 56, bottom: 4, left: 4 }}>
            <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={label}
              tick={{ fill: "var(--faint)", fontSize: 10 }}
              stroke="var(--line)"
              minTickGap={34}
            />
            <YAxis
              domain={["auto", "auto"]}
              tick={{ fill: "var(--faint)", fontSize: 10 }}
              stroke="var(--line)"
              width={46}
              tickFormatter={(value: number) => grouped(value, 0)}
            />
            <Tooltip
              content={<ChartTooltip sector={sector} />}
              cursor={{ stroke: "var(--line-strong)", strokeDasharray: "3 3" }}
            />
            <Line
              type="monotone"
              dataKey="bench"
              name={BENCHMARK}
              stroke="var(--faint)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="sector"
              name={sector}
              stroke="var(--accent)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="flex flex-wrap items-center gap-4 border-t border-line px-4 py-2 text-[10.5px]">
        <span className="flex items-center gap-1.5 text-ink2">
          <span className="h-[2px] w-4 bg-accent" aria-hidden />
          {sector}
        </span>
        <span className="flex items-center gap-1.5 text-muted">
          <span
            className="h-0 w-4 border-t-2 border-dashed border-faint"
            aria-hidden
          />
          {BENCHMARK}
        </span>
        <span className="ml-auto text-faint">
          Both lines share one base date and one base value, so the gap between them is the
          relative performance.
        </span>
      </div>
    </section>
  );
}
