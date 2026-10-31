"use client";

import { useMemo, useState } from "react";
import type { Bar, ExplorerOverview, Timeframe } from "@/lib/marketdata/types";
import { q, useExplorer } from "@/lib/marketdata/useExplorer";
import { VIX_SYMBOL } from "./HistoryMonths";
import { dayLabel } from "./OiMonth";
import { Segmented } from "./OptionChain";
import TimeChart from "./TimeChart";

/**
 * History analysis → NIFTY vs India VIX. NIFTY's spot is downloaded for the archive's range (a
 * year now); India VIX for five years. Either can be the candles, the other the line on the left
 * scale. The finest timeframe on offer shrinks as the range grows, to keep a chart in the tens
 * of thousands of bars rather than the hundreds of thousands.
 */

type Span = "1M" | "3M" | "6M" | "1Y" | "5Y";

const SPANS: { key: Span; days: number; timeframes: Timeframe[] }[] = [
  { key: "1M", days: 31, timeframes: ["1", "5", "15", "60", "D"] },
  { key: "3M", days: 92, timeframes: ["5", "15", "60", "D"] },
  { key: "6M", days: 183, timeframes: ["15", "60", "D"] },
  { key: "1Y", days: 366, timeframes: ["60", "D"] },
  { key: "5Y", days: 1827, timeframes: ["D"] },
];

const TF_LABEL: Record<Timeframe, string> = { "1": "1m", "5": "5m", "15": "15m", "60": "1h", D: "1D" };

function minus(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n + 1);
  return d.toISOString().slice(0, 10);
}

export default function NiftyVix() {
  const overview = useExplorer<ExplorerOverview>("view=overview");
  const [span, setSpan] = useState<Span>("1Y");
  const [tf, setTf] = useState<Timeframe>("D");
  const [main, setMain] = useState<"NIFTY" | "VIX">("NIFTY");

  const spec = SPANS.find((s) => s.key === span)!;
  const timeframe = spec.timeframes.includes(tf) ? tf : spec.timeframes[0];
  const ov = overview.data;
  const to = [ov?.range?.to, ov?.vix?.to].filter(Boolean).sort().pop() ?? null;
  const from = to ? minus(to, spec.days) : null;

  const nifty = useExplorer<Bar[]>(to && from ? q({ view: "bars", symbol: "NIFTY", from, to, tf: timeframe }) : null);
  const vix = useExplorer<Bar[]>(
    to && from && ov?.vix ? q({ view: "bars", symbol: VIX_SYMBOL, from, to, tf: timeframe }) : null
  );

  const candles = main === "NIFTY" ? nifty.data : vix.data;
  const lineBars = main === "NIFTY" ? vix.data : nifty.data;
  const overlay = useMemo(
    () =>
      lineBars && lineBars.length
        ? { label: main === "NIFTY" ? "India VIX" : "NIFTY", points: lineBars.map((b) => ({ t: b.t, v: b.c })) }
        : null,
    [lineBars, main]
  );
  const error = nifty.error ?? vix.error;
  const loading = nifty.loading || vix.loading;

  return (
    <section className="overflow-hidden rounded-md border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <h2 className="font-display text-[10px] font-bold uppercase tracking-[0.13em] text-muted">NIFTY vs India VIX</h2>
        <p className="ml-auto max-w-[60ch] text-[10.5px] leading-snug text-faint">
          {ov?.range ? `NIFTY from ${dayLabel(ov.range.from)} ${ov.range.from.slice(0, 4)}` : "NIFTY not downloaded yet"}
          {" · "}
          {ov?.vix ? `India VIX from ${dayLabel(ov.vix.from)} ${ov.vix.from.slice(0, 4)}` : "India VIX not downloaded yet"}
        </p>
      </div>

      <div className="flex flex-col gap-3 px-4 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented value={span} options={SPANS.map((s) => [s.key, s.key] as [Span, string])} onChange={setSpan} />
          <Segmented
            value={timeframe}
            options={spec.timeframes.map((t) => [t, TF_LABEL[t]] as [Timeframe, string])}
            onChange={setTf}
          />
          <span className="ml-auto text-[11px] text-muted">Candles</span>
          <Segmented
            value={main}
            options={[
              ["NIFTY", "NIFTY"],
              ["VIX", "India VIX"],
            ]}
            onChange={setMain}
          />
        </div>

        {overview.error ? (
          <p className="py-6 text-[12px] text-muted">{overview.error}</p>
        ) : error ? (
          <p className="py-6 text-[12px] text-neg">{error}</p>
        ) : !ov || loading ? (
          <p className="py-6 text-[12px] text-muted">Loading bars…</p>
        ) : !candles?.length ? (
          <p className="py-6 text-[12px] text-muted">
            No {main === "NIFTY" ? "NIFTY" : "India VIX"} bars in this range — try the other one as candles.
          </p>
        ) : (
          <TimeChart
            bars={candles}
            mainLabel={main === "NIFTY" ? "NIFTY 50" : "India VIX"}
            overlay={overlay}
            daily={timeframe === "D"}
            height={460}
          />
        )}
        <p className="text-[10.5px] leading-snug text-faint">
          The line uses the left scale. India VIX is the market&apos;s expected NIFTY volatility over the next 30
          days, annualised, from NIFTY option prices — it usually rises when NIFTY falls.
        </p>
      </div>
    </section>
  );
}
