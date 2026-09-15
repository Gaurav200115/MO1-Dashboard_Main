"use client";

import { fmtCrore, fmtSignedPct, grouped } from "@/lib/format";
import type { SectorIndex } from "@/lib/sectorIndex";

/**
 * The header for a selected sector. Reads as an index quote: level, day change,
 * then the things that qualify it — how many members are actually priced, the
 * traded value behind the move, and the heaviest constituent.
 */
export default function SectorIndexStrip({ index }: { index: SectorIndex }) {
  const rising = index.changePct >= 0;
  const stale = index.priced < index.members;

  return (
    <section
      aria-label={`${index.sector} index`}
      className="flex flex-wrap items-end gap-x-8 gap-y-3 border-b border-line pb-3.5"
    >
      <div>
        <h2 className="font-display text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
          {index.sector}
        </h2>
        <div className="mt-1 flex items-baseline gap-2.5">
          <span className="tnum font-mono text-[27px] font-semibold leading-none">
            {grouped(index.level, 2)}
          </span>
          <span
            className={`tnum font-mono text-[14px] font-semibold ${
              rising ? "text-pos" : "text-neg"
            }`}
          >
            {fmtSignedPct(index.changePct)}
          </span>
        </div>
      </div>

      <Stat label="Constituents">
        {index.priced}
        <span className="text-faint">/{index.members}</span>
        {stale ? (
          <span
            className="ml-1 text-alert"
            title={`${index.members - index.priced} not yet priced — excluded from the index rather than held flat`}
          >
            ·
          </span>
        ) : null}
      </Stat>

      <Stat label="Turnover">
        {index.turnover == null ? "—" : fmtCrore(index.turnover)}
      </Stat>

      {index.top ? (
        <Stat label="Heaviest">
          {index.top.symbol}{" "}
          <span className="text-muted">{index.top.weightPct.toFixed(1)}%</span>
        </Stat>
      ) : null}

      <p className="ml-auto max-w-[26ch] text-[10.5px] leading-snug text-faint">
        Free-float market-cap weighted, rebased to 1,000 at the previous close.
      </p>
    </section>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.09em] text-muted">{label}</div>
      <div className="tnum mt-0.5 font-mono text-[13px] font-semibold">{children}</div>
    </div>
  );
}
