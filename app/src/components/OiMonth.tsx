"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtCompact, grouped } from "@/lib/format";
import type { BuildUp, OiDay } from "@/lib/marketdata/types";
import { q, useExplorer } from "@/lib/marketdata/useExplorer";

/**
 * Open interest over one month, end of day (NSE F&O bhavcopy): the nearest expiry's call and put
 * OI with PCR, and a row per day with the future's build-up and the max-pain strike. Clicking a
 * day opens its option chain.
 */

const AXIS = "var(--muted)";
const axis = { stroke: AXIS, tick: { fill: AXIS, fontSize: 10.5 }, tickLine: false, axisLine: false } as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function dayLabel(d: string): string {
  return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
}

const BUILD_UP_TONE: Record<BuildUp, string> = {
  "Long build-up": "text-pos",
  "Short covering": "text-pos",
  "Short build-up": "text-neg",
  "Long unwinding": "text-neg",
};

function signedCompact(v: number | null): string {
  if (v == null) return "—";
  return `${v > 0 ? "+" : ""}${fmtCompact(v)}`;
}

export default function OiMonth({
  symbol,
  month,
  selected,
  onPick,
}: {
  symbol: string;
  month: string;
  selected: string | null;
  onPick: (date: string) => void;
}) {
  const { data, error, loading } = useExplorer<OiDay[]>(q({ view: "oi", symbol, month }));

  if (error) return <p className="text-[12px] text-neg">{error}</p>;
  if (loading || !data) return <p className="text-[12px] text-muted">Loading open interest…</p>;
  if (!data.length) return <p className="text-[12px] text-muted">No F&amp;O end-of-day rows for {symbol} this month.</p>;

  const points = data.map((d) => ({ ...d, label: dayLabel(d.date) }));

  return (
    <div className="flex flex-col gap-3">
      <div className="h-[230px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={points}
            margin={{ top: 8, right: 4, bottom: 0, left: 0 }}
            onClick={(e) => {
              const d = (e?.activePayload?.[0]?.payload as OiDay | undefined)?.date;
              if (d) onPick(d);
            }}
          >
            <CartesianGrid stroke="var(--line)" vertical={false} />
            <XAxis dataKey="label" {...axis} minTickGap={10} />
            <YAxis yAxisId="oi" {...axis} width={58} tickFormatter={(v: number) => fmtCompact(v)} />
            <YAxis yAxisId="pcr" orientation="right" {...axis} width={36} tickFormatter={(v: number) => v.toFixed(2)} />
            <Tooltip
              cursor={{ fill: "var(--surface-2)", fillOpacity: 0.6 }}
              content={({ active, payload }) => {
                const d = payload?.[0]?.payload as OiDay | undefined;
                if (!active || !d) return null;
                return (
                  <div className="rounded-[5px] border border-linestrong bg-surface px-2.5 py-2 text-[11px] shadow-sm">
                    <div className="mb-1 text-[10.5px] text-muted">
                      {dayLabel(d.date)} · expiry {d.expiry ? dayLabel(d.expiry) : "—"}
                    </div>
                    <div className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 font-mono text-[10.5px]">
                      <span className="text-muted">Call OI</span>
                      <span className="tnum text-right text-ink">{fmtCompact(d.ceOi)}</span>
                      <span className="text-muted">Put OI</span>
                      <span className="tnum text-right text-ink">{fmtCompact(d.peOi)}</span>
                      <span className="text-muted">PCR</span>
                      <span className="tnum text-right text-ink">{d.pcr != null ? d.pcr.toFixed(2) : "—"}</span>
                      <span className="text-muted">Max pain</span>
                      <span className="tnum text-right text-ink">{d.maxPain != null ? grouped(d.maxPain, 2) : "—"}</span>
                    </div>
                  </div>
                );
              }}
            />
            <Bar yAxisId="oi" dataKey="ceOi" name="Call OI" fill="var(--neg)" fillOpacity={0.75} maxBarSize={14} />
            <Bar yAxisId="oi" dataKey="peOi" name="Put OI" fill="var(--pos)" fillOpacity={0.75} maxBarSize={14} />
            <Line yAxisId="pcr" dataKey="pcr" name="PCR" stroke="var(--accent)" strokeWidth={1.5} dot={{ r: 2 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="-mt-1 flex flex-wrap gap-x-4 text-[10.5px] text-muted">
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-neg" />Call OI</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-pos" />Put OI</span>
        <span><span className="mr-1 inline-block h-[2px] w-3 bg-accent align-middle" />PCR (put OI ÷ call OI), right scale</span>
        <span>Nearest expiry each day. Click a day for its chain.</span>
      </p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-[11.5px]">
          <thead>
            <tr className="border-b border-line text-left text-[10px] uppercase tracking-[0.08em] text-muted">
              <th className="py-1.5 pr-2 font-semibold">Day</th>
              <th className="px-2 font-semibold">Expiry</th>
              <th className="px-2 text-right font-semibold">Spot</th>
              <th className="px-2 text-right font-semibold">Future</th>
              <th className="px-2 text-right font-semibold">Fut OI chg</th>
              <th className="px-2 font-semibold">Build-up</th>
              <th className="px-2 text-right font-semibold">Call OI</th>
              <th className="px-2 text-right font-semibold">Put OI</th>
              <th className="px-2 text-right font-semibold">PCR</th>
              <th className="pl-2 text-right font-semibold">Max pain</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {data.map((d) => (
              <tr
                key={d.date}
                onClick={() => onPick(d.date)}
                className={`cursor-pointer border-b border-line/60 ${
                  d.date === selected ? "bg-accentsoft" : "hover:bg-surface2"
                }`}
              >
                <td className="py-1 pr-2 font-sans text-ink">{dayLabel(d.date)}</td>
                <td className="px-2 font-sans text-muted">{d.expiry ? dayLabel(d.expiry) : "—"}</td>
                <td className="tnum px-2 text-right text-ink2">{d.spot != null ? grouped(d.spot, 2) : "—"}</td>
                <td className="tnum px-2 text-right text-ink2">{d.futClose != null ? grouped(d.futClose, 2) : "—"}</td>
                <td className={`tnum px-2 text-right ${(d.futChgOi ?? 0) >= 0 ? "text-pos" : "text-neg"}`}>
                  {signedCompact(d.futChgOi)}
                </td>
                <td className={`px-2 font-sans ${d.buildUp ? BUILD_UP_TONE[d.buildUp] : "text-faint"}`}>
                  {d.buildUp ?? "—"}
                </td>
                <td className="tnum px-2 text-right text-ink2">{fmtCompact(d.ceOi)}</td>
                <td className="tnum px-2 text-right text-ink2">{fmtCompact(d.peOi)}</td>
                <td className="tnum px-2 text-right text-ink">{d.pcr != null ? d.pcr.toFixed(2) : "—"}</td>
                <td className="tnum pl-2 text-right text-ink2">{d.maxPain != null ? grouped(d.maxPain, 2) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10.5px] leading-snug text-faint">
        Build-up from the nearest future: price up + OI up = long build-up, price down + OI up = short
        build-up, price up + OI down = short covering, price down + OI down = long unwinding. OI in shares.
      </p>
    </div>
  );
}
