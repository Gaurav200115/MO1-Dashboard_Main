"use client";

import { fmtPrice, fmtRatio } from "@/lib/format";
import { LEADER_METRICS } from "@/lib/metrics";
import type { CompanySummary, MetricKey } from "@/lib/types";
import { ALL } from "./SectorRail";

export default function LeaderStrip({
  companies,
  sector,
  metric,
  onMetricChange,
  onOpen,
}: {
  companies: CompanySummary[];
  sector: string;
  metric: MetricKey;
  onMetricChange: (m: MetricKey) => void;
  onOpen: (symbol: string) => void;
}) {
  const def = LEADER_METRICS.find((m) => m.key === metric) ?? LEADER_METRICS[0];
  const top = companies
    .filter((c) => c[def.key] != null)
    .sort((a, b) => (b[def.key] as number) - (a[def.key] as number))
    .slice(0, 6);

  return (
    <section aria-labelledby="leaders-heading" className="mb-7">
      <div className="mb-3 flex flex-wrap items-center gap-3.5">
        <h2
          id="leaders-heading"
          className="font-display text-[10px] font-bold uppercase tracking-[0.13em] text-muted"
        >
          Highest {def.label.toLowerCase()}
          {sector !== ALL ? ` · ${sector}` : ""}
        </h2>
        <div
          className="ml-auto flex gap-0.5 rounded-md bg-sunken p-0.5"
          role="group"
          aria-label="Leader metric"
        >
          {LEADER_METRICS.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => onMetricChange(m.key)}
              aria-pressed={metric === m.key}
              className={`whitespace-nowrap rounded-[5px] px-2.5 py-1 text-[11.5px] ${
                metric === m.key
                  ? "bg-surface font-semibold text-ink shadow-sm"
                  : "text-muted hover:text-ink"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {top.length === 0 ? (
        <p className="rounded-md border border-line bg-surface p-8 text-center text-[13px] text-muted">
          No company in this sector reports {def.label.toLowerCase()}.
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(168px,1fr))] gap-2.5">
          {top.map((c, i) => (
            <button
              key={c.symbol}
              type="button"
              onClick={() => onOpen(c.symbol)}
              className="rounded-md border border-line bg-surface p-3 text-left transition hover:-translate-y-px hover:border-accent motion-reduce:transition-none motion-reduce:hover:translate-y-0"
            >
              <div className="tnum font-mono text-[10px] tracking-wider text-faint">
                {String(i + 1).padStart(2, "0")}
              </div>
              <div className="mt-0.5 font-display text-[15px] font-bold">{c.symbol}</div>
              <div className="truncate text-[11px] text-muted">{c.name}</div>
              <div className="tnum mt-2 font-mono text-[19px] font-semibold tracking-tight">
                {def.fmt(c[def.key])}
              </div>
              <div className="tnum font-mono text-[11px] text-faint">
                {fmtPrice(c.price)} · P/E {fmtRatio(c.pe)}
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
