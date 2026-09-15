"use client";

import { useEffect, useState } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtPrice, fmtSignedPct, grouped } from "@/lib/format";
import type { Candle, HistoryResult, Range } from "@/lib/kite/history";

const RANGE_OPTIONS: { key: Range; label: string; hint: string }[] = [
  { key: "1D", label: "1D", hint: "5-minute candles, latest session" },
  { key: "1W", label: "1W", hint: "Daily closes, one week" },
  { key: "1M", label: "1M", hint: "Daily closes, one month" },
  { key: "1Y", label: "1Y", hint: "Daily closes, one year" },
];

type ChartType = "line" | "candle";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function istClock(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 16);
}

function istDay(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

type Point = Candle & {
  label: string;
  /** Low-to-high pair, which is what the candlestick shape is drawn from. */
  span: [number, number];
};

/**
 * Recharts has no candlestick, so this is a custom shape over a range bar.
 * The bar is given [low, high], so `y` is the pixel of the high and `y + height`
 * the pixel of the low — which is enough to place open and close by
 * interpolation, without needing access to the chart's scale.
 */
function CandleShape(props: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: Point;
}) {
  const { x = 0, y = 0, width = 0, height = 0, payload } = props;
  if (!payload) return null;

  const { o, c, h, l } = payload;
  const rising = c >= o;
  const colour = rising ? "var(--pos)" : "var(--neg)";
  const centre = x + width / 2;

  const wick = (
    <line x1={centre} x2={centre} y1={y} y2={y + height} stroke={colour} strokeWidth={1} />
  );

  // A candle that never moved has no vertical span to interpolate within.
  if (!(h > l)) {
    return (
      <g>
        <line x1={centre - 3} x2={centre + 3} y1={y} y2={y} stroke={colour} strokeWidth={1.5} />
      </g>
    );
  }

  const priceToY = (price: number) => y + ((h - price) / (h - l)) * height;
  const top = priceToY(Math.max(o, c));
  const bottom = priceToY(Math.min(o, c));

  // Capped so a five-candle week does not render as five slabs.
  const bodyWidth = Math.max(1, Math.min(width * 0.68, 13));

  return (
    <g>
      {wick}
      <rect
        x={centre - bodyWidth / 2}
        y={top}
        width={bodyWidth}
        height={Math.max(1, bottom - top)}
        fill={colour}
        stroke={colour}
        strokeWidth={0.75}
      />
    </g>
  );
}

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: Point }[];
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;

  return (
    <div className="rounded-[5px] border border-linestrong bg-surface px-2.5 py-2 font-mono text-[11px] shadow-sm">
      <div className="mb-1 text-[10.5px] text-muted">{point.label}</div>
      <div className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5">
        <Cell k="O" v={fmtPrice(point.o)} />
        <Cell k="H" v={fmtPrice(point.h)} />
        <Cell k="L" v={fmtPrice(point.l)} />
        <Cell k="C" v={fmtPrice(point.c)} />
      </div>
      <div className="mt-1 border-t border-line pt-1 text-[10.5px] text-muted">
        Vol {grouped(point.v)}
      </div>
    </div>
  );
}

function Cell({ k, v }: { k: string; v: string }) {
  return (
    <>
      <span className="text-faint">{k}</span>
      <span className="tnum text-right font-semibold">{v}</span>
    </>
  );
}

export default function StockChart({ symbol }: { symbol: string }) {
  const [range, setRange] = useState<Range>("1D");
  const [type, setType] = useState<ChartType>("line");
  const [data, setData] = useState<Partial<Record<Range, HistoryResult>>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; needsLogin?: boolean } | null>(null);

  useEffect(() => {
    if (data[range]) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/history?symbol=${encodeURIComponent(symbol)}&range=${range}`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) {
          throw Object.assign(new Error(body.error), { needsLogin: body.needsLogin });
        }
        return body as HistoryResult;
      })
      .then((result) => {
        if (!cancelled) setData((current) => ({ ...current, [range]: result }));
      })
      .catch((err: Error & { needsLogin?: boolean }) => {
        if (!cancelled) setError({ message: err.message, needsLogin: err.needsLogin });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [symbol, range, data]);

  // A new symbol invalidates everything cached for the old one.
  useEffect(() => {
    setData({});
    setError(null);
  }, [symbol]);

  const result = data[range];
  const candles = result?.candles ?? [];

  const points: Point[] = candles.map((candle) => ({
    ...candle,
    label: result?.interval === "5minute" ? istClock(candle.t) : istDay(candle.t),
    span: [candle.l, candle.h],
  }));

  const first = candles[0]?.o ?? null;
  const last = candles[candles.length - 1]?.c ?? null;
  const rising = first != null && last != null && last >= first;
  const changePct =
    first != null && last != null && first > 0 ? ((last - first) / first) * 100 : null;
  const tone = rising ? "var(--pos)" : "var(--neg)";

  const low = candles.length ? Math.min(...candles.map((c) => c.l)) : 0;
  const high = candles.length ? Math.max(...candles.map((c) => c.h)) : 0;
  const pad = (high - low) * 0.06 || 1;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Toggle>
          {RANGE_OPTIONS.map((option) => (
            <ToggleButton
              key={option.key}
              active={range === option.key}
              title={option.hint}
              onClick={() => setRange(option.key)}
            >
              {option.label}
            </ToggleButton>
          ))}
        </Toggle>

        <Toggle>
          <ToggleButton
            active={type === "line"}
            title="Closing price as an area line"
            onClick={() => setType("line")}
          >
            Line
          </ToggleButton>
          <ToggleButton
            active={type === "candle"}
            title="Open, high, low and close per candle"
            onClick={() => setType("candle")}
          >
            Candles
          </ToggleButton>
        </Toggle>

        {changePct != null ? (
          <div className="flex items-baseline gap-2">
            <span className="tnum font-mono text-[17px] font-semibold">{fmtPrice(last)}</span>
            <span
              className={`tnum font-mono text-[12.5px] font-semibold ${
                rising ? "text-pos" : "text-neg"
              }`}
            >
              {fmtSignedPct(changePct)}
            </span>
          </div>
        ) : null}

        {result ? (
          <span className="ml-auto font-mono text-[10.5px] text-faint">
            {result.interval}
            {result.session ? ` · ${result.session}` : ""} · {candles.length} candles
          </span>
        ) : null}
      </div>

      <div className="h-[260px] w-full rounded-[6px] border border-line bg-surface p-2">
        {loading && !result ? (
          <Centered>Loading candles…</Centered>
        ) : error ? (
          <Centered>
            <span className="text-neg">{error.message}</span>
            {error.needsLogin ? (
              <a href="/api/kite/login" className="mt-1 block text-accent underline">
                Sign in to Kite
              </a>
            ) : null}
          </Centered>
        ) : candles.length === 0 ? (
          <Centered>No candles for this range yet.</Centered>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={points} margin={{ top: 6, right: 8, bottom: 0, left: 8 }}>
              <defs>
                <linearGradient id={`fill-${symbol}-${range}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={tone} stopOpacity={0.22} />
                  <stop offset="100%" stopColor={tone} stopOpacity={0.01} />
                </linearGradient>
              </defs>

              <CartesianGrid stroke="var(--line)" strokeDasharray="2 3" vertical={false} />

              <XAxis
                dataKey="label"
                tick={{ fill: "var(--faint)", fontSize: 10, fontFamily: "var(--font-mono)" }}
                stroke="var(--line)"
                interval="preserveStartEnd"
                minTickGap={44}
              />
              <YAxis
                domain={[low - pad, high + pad]}
                tick={{ fill: "var(--faint)", fontSize: 10, fontFamily: "var(--font-mono)" }}
                stroke="var(--line)"
                width={58}
                tickFormatter={(v: number) => grouped(v, v < 100 ? 2 : 0)}
              />

              {/* Opening level, so direction over the range reads at a glance. */}
              {first != null ? (
                <ReferenceLine y={first} stroke="var(--line-strong)" strokeDasharray="3 3" />
              ) : null}

              <Tooltip content={<ChartTooltip />} />

              {type === "line" ? (
                <Area
                  type="monotone"
                  dataKey="c"
                  stroke={tone}
                  strokeWidth={1.6}
                  fill={`url(#fill-${symbol}-${range})`}
                  dot={false}
                  activeDot={{ r: 3, fill: tone, stroke: "var(--surface)", strokeWidth: 1.5 }}
                  isAnimationActive={false}
                />
              ) : (
                <Bar
                  dataKey="span"
                  shape={<CandleShape />}
                  isAnimationActive={false}
                  legendType="none"
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {candles.length > 0 ? (
        <dl className="flex flex-wrap gap-x-7 gap-y-2">
          {(
            [
              ["Open", fmtPrice(first)],
              ["High", fmtPrice(high)],
              ["Low", fmtPrice(low)],
              [
                result?.interval === "5minute" ? "Session volume" : "Last day volume",
                grouped(candles[candles.length - 1]?.v ?? 0),
              ],
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <dt className="text-[10px] uppercase tracking-[0.09em] text-muted">{label}</dt>
              <dd className="tnum font-mono text-[13px] font-semibold">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function Toggle({ children }: { children: React.ReactNode }) {
  return <div className="flex gap-0.5 rounded-[5px] border border-line p-0.5">{children}</div>;
}

function ToggleButton({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`rounded-[3px] px-2.5 py-1 font-mono text-[11px] font-semibold ${
        active ? "bg-accentsoft text-accent" : "text-muted hover:bg-surface2 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-center text-[12px] text-muted">
      <div>{children}</div>
    </div>
  );
}
