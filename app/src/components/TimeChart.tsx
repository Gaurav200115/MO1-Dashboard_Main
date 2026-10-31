"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type UTCTimestamp,
} from "lightweight-charts";
import { fmtCompact, grouped } from "@/lib/format";
import type { Bar } from "@/lib/marketdata/types";

/**
 * Candles with volume underneath and one optional line on its own (left) scale — spot with
 * India VIX, an option with its underlying, NIFTY with VIX. TradingView's lightweight-charts,
 * because a month of 1-minute bars is ~7,500 candles and needs canvas, zoom and pan.
 *
 * Bar times come from /api/explorer with IST folded in, so the axis (which shows UTC) reads IST.
 */

export interface Overlay {
  label: string;
  points: { t: number; v: number }[];
}

interface Palette {
  surface: string;
  ink: string;
  muted: string;
  line: string;
  pos: string;
  neg: string;
  accent: string;
  alert: string;
}

function palette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    surface: v("--surface"),
    ink: v("--ink-2"),
    muted: v("--muted"),
    line: v("--line"),
    pos: v("--pos"),
    neg: v("--neg"),
    accent: v("--accent"),
    alert: v("--alert"),
  };
}

/** "#3dbe87" + alpha -> "#3dbe8766"; anything that is not a 6-digit hex passes through. */
function alpha(hex: string, a: string): string {
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex + a : hex;
}

function applyTheme(
  chart: IChartApi,
  candles: ISeriesApi<"Candlestick">,
  line: ISeriesApi<"Line">,
  p: Palette
) {
  chart.applyOptions({
    layout: {
      background: { type: ColorType.Solid, color: p.surface },
      textColor: p.muted,
      fontSize: 10.5,
    },
    grid: { vertLines: { color: alpha(p.line, "80") }, horzLines: { color: alpha(p.line, "80") } },
    rightPriceScale: { borderColor: p.line },
    leftPriceScale: { borderColor: p.line },
    timeScale: { borderColor: p.line },
  });
  candles.applyOptions({
    upColor: p.pos,
    downColor: p.neg,
    borderUpColor: p.pos,
    borderDownColor: p.neg,
    wickUpColor: p.pos,
    wickDownColor: p.neg,
  });
  line.applyOptions({ color: p.alert });
}

type Legend = { bar: Bar | null; overlay: number | null; t: number | null };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function stamp(t: number, daily: boolean): string {
  const d = new Date(t * 1000);
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return daily ? day : `${day} ${d.toISOString().slice(11, 16)}`;
}

export default function TimeChart({
  bars,
  mainLabel,
  overlay,
  daily = false,
  height = 380,
}: {
  bars: Bar[];
  mainLabel: string;
  overlay?: Overlay | null;
  daily?: boolean;
  height?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const api = useRef<{
    chart: IChartApi;
    candles: ISeriesApi<"Candlestick">;
    volume: ISeriesApi<"Histogram">;
    line: ISeriesApi<"Line">;
  } | null>(null);
  const lookup = useRef<{ bars: Map<number, Bar>; overlay: Map<number, number> }>({
    bars: new Map(),
    overlay: new Map(),
  });
  const [legend, setLegend] = useState<Legend>({ bar: null, overlay: null, t: null });

  // The chart itself: made once, re-coloured when the desk's theme changes.
  useEffect(() => {
    if (!box.current) return;
    const chart = createChart(box.current, {
      autoSize: true,
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { visible: true },
      leftPriceScale: { visible: false },
      timeScale: { rightOffset: 2, minBarSpacing: 0.2 },
      localization: { priceFormatter: (v: number) => grouped(v, 2) },
    });
    const candles = chart.addSeries(CandlestickSeries, { priceScaleId: "right" });
    const line = chart.addSeries(LineSeries, {
      priceScaleId: "left",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerRadius: 3,
    });
    // Volume along the bottom fifth of the price pane, on its own unlabelled scale.
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      priceFormat: { type: "custom", formatter: (v: number) => fmtCompact(v), minMove: 1 },
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    applyTheme(chart, candles, line, palette());
    api.current = { chart, candles, volume, line };

    const onMove = (param: MouseEventParams) => {
      const t = typeof param.time === "number" ? param.time : null;
      setLegend({
        t,
        bar: t != null ? lookup.current.bars.get(t) ?? null : null,
        overlay: t != null ? lookup.current.overlay.get(t) ?? null : null,
      });
    };
    chart.subscribeCrosshairMove(onMove);

    const recolour = () => {
      if (api.current) applyTheme(api.current.chart, api.current.candles, api.current.line, palette());
    };
    const observer = new MutationObserver(recolour);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia("(prefers-color-scheme: light)");
    media.addEventListener("change", recolour);

    return () => {
      observer.disconnect();
      media.removeEventListener("change", recolour);
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      api.current = null;
    };
  }, []);

  useEffect(() => {
    const a = api.current;
    if (!a) return;
    const p = palette();
    a.chart.applyOptions({ timeScale: { timeVisible: !daily, secondsVisible: false } });
    a.candles.setData(
      bars.map((b) => ({ time: b.t as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c }))
    );
    const hasVolume = bars.some((b) => b.v > 0);
    a.volume.setData(
      hasVolume
        ? bars.map((b) => ({
            time: b.t as UTCTimestamp,
            value: b.v,
            color: alpha(b.c >= b.o ? p.pos : p.neg, "73"),
          }))
        : []
    );
    const margins = { top: 0.08, bottom: hasVolume ? 0.24 : 0.06 };
    a.chart.priceScale("right").applyOptions({ scaleMargins: margins });
    a.chart.priceScale("left").applyOptions({ scaleMargins: margins });
    a.line.setData(overlay ? overlay.points.map((o) => ({ time: o.t as UTCTimestamp, value: o.v })) : []);
    a.chart.applyOptions({ leftPriceScale: { visible: Boolean(overlay?.points.length) } });
    a.chart.timeScale().fitContent();
    lookup.current = {
      bars: new Map(bars.map((b) => [b.t, b])),
      overlay: new Map((overlay?.points ?? []).map((o) => [o.t, o.v])),
    };
    setLegend({ bar: null, overlay: null, t: null });
  }, [bars, overlay, daily]);

  const shown = legend.bar ?? bars[bars.length - 1] ?? null;
  const shownOverlay =
    legend.t != null ? legend.overlay : overlay?.points[overlay.points.length - 1]?.v ?? null;
  const change = shown ? shown.c - shown.o : 0;

  return (
    <div>
      <div className="mb-1 flex min-h-[18px] flex-wrap items-baseline gap-x-3 gap-y-0.5 px-1 font-mono text-[10.5px]">
        <span className="font-sans text-[11px] font-semibold text-ink">{mainLabel}</span>
        {shown ? (
          <>
            <span className="text-muted">{stamp(legend.t ?? shown.t, daily)}</span>
            <span className="tnum text-ink2">
              O {grouped(shown.o, 2)} H {grouped(shown.h, 2)} L {grouped(shown.l, 2)}{" "}
              <span className={change >= 0 ? "text-pos" : "text-neg"}>C {grouped(shown.c, 2)}</span>
            </span>
            {shown.v > 0 ? <span className="tnum text-muted">Vol {fmtCompact(shown.v)}</span> : null}
          </>
        ) : null}
        {overlay ? (
          <span className="tnum text-alert">
            {overlay.label} {shownOverlay != null ? grouped(shownOverlay, 2) : "—"}
          </span>
        ) : null}
      </div>
      <div ref={box} style={{ height }} className="w-full" />
    </div>
  );
}
