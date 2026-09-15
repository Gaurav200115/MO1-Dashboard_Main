"use client";

import { fmtSignedPct } from "@/lib/format";
import type { SectorIndex } from "@/lib/sectorIndex";

export const ALL = "__all__";
/** Stage one — everything the overnight confluence confirmed. */
export const SPECIAL = "__special__";
/** Stage two — the subset live price has arrived at. */
export const CURRENT = "__current__";
/** The stored history, for checking the rule rather than trading it. */
export const ARCHIVE = "__archive__";
/** Paper trades taken by the strategy engine, by day. */
export const TRADES = "__trades__";

export default function SectorRail({
  sectors,
  indices,
  total,
  active,
  onSelect,
  special,
  trades,
}: {
  sectors: Map<string, number>;
  indices: Map<string, SectorIndex>;
  total: number;
  active: string;
  onSelect: (sector: string) => void;
  /** Null until the EOD scan has produced a report. */
  special: { today: number; current: number } | null;
  /** Today's paper trades — null while the strategy engine is not running. */
  trades: { taken: number; open: number } | null;
}) {
  // Indexed sectors first, sorted by today's move so the rail reads as a
  // heatmap; the sectors too thin to index sit below, ordered by size.
  const names = [...sectors.keys()].sort((a, b) => {
    const ia = indices.get(a);
    const ib = indices.get(b);
    if (ia && ib) return ib.changePct - ia.changePct;
    if (ia) return -1;
    if (ib) return 1;
    return (sectors.get(b) ?? 0) - (sectors.get(a) ?? 0);
  });

  return (
    <nav aria-label="Watchlist and sectors" className="flex flex-col gap-2">
      {special ? (
        <div className="mb-1 flex flex-col gap-2 border-b border-line pb-3">
          <h2 className="font-display text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
            Watchlist
          </h2>

          <WatchItem
            label="Current Special"
            count={special.current}
            value={CURRENT}
            active={active}
            onSelect={onSelect}
            title={`${special.current} of the ${special.today} confirmed stocks have price within the band of a level right now`}
            live={special.current > 0}
            liveLabel="Price is inside the band of a confirmed level right now"
          />

          <WatchItem
            label="Today's Special"
            count={special.today}
            value={SPECIAL}
            active={active}
            onSelect={onSelect}
            title={`${special.today} stocks where a pivot and the option chain agree`}
            live={false}
            liveLabel=""
          />

          <button
            type="button"
            onClick={() => onSelect(ARCHIVE)}
            aria-current={active === ARCHIVE}
            title="Stored levels by session, for checking how the rule performed"
            className={`flex w-full items-center rounded-[5px] px-2 py-1.5 text-left text-[12.5px] ${
              active === ARCHIVE
                ? "bg-accentsoft font-semibold text-accent"
                : "text-ink2 hover:bg-surface2"
            }`}
          >
            Archive
          </button>
        </div>
      ) : null}

      {/*
        Outside the `special` block on purpose: trades are worth reaching even on
        a day the scan produced nothing, because that is exactly when you want to
        check whether the engine took anything it should not have.
      */}
      <div className="mb-1 flex flex-col gap-2 border-b border-line pb-3">
        <h2 className="font-display text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
          Strategies
        </h2>
        <WatchItem
          label="Trades"
          count={trades?.taken ?? 0}
          value={TRADES}
          active={active}
          onSelect={onSelect}
          title={
            trades
              ? `${trades.taken} paper trades today, ${trades.open} still open`
              : "Paper trades taken by the strategy engine"
          }
          live={(trades?.open ?? 0) > 0}
          liveLabel="A paper position is open right now"
        />
      </div>

      <h2 className="font-display text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
        Sectors
      </h2>
      <div className="flex flex-row flex-wrap gap-px lg:flex-col">
        <Item
          label="All companies"
          count={total}
          value={ALL}
          active={active}
          onSelect={onSelect}
        />
        {names.map((name) => (
          <Item
            key={name}
            label={name}
            count={sectors.get(name) ?? 0}
            index={indices.get(name)}
            value={name}
            active={active}
            onSelect={onSelect}
          />
        ))}
      </div>
      <p className="mt-1 max-w-[22ch] text-[10px] leading-snug text-faint">
        Indices cover sectors with more than 7 constituents.
      </p>
    </nav>
  );
}

function WatchItem({
  label,
  count,
  value,
  active,
  onSelect,
  title,
  live,
  liveLabel,
}: {
  label: string;
  count: number;
  value: string;
  active: string;
  onSelect: (s: string) => void;
  title: string;
  /** Something is happening right now — the only thing that pulses. */
  live: boolean;
  liveLabel: string;
}) {
  const isActive = active === value;

  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      aria-current={isActive}
      title={title}
      className={`flex w-full items-center justify-between gap-2 rounded-[5px] px-2 py-1.5 text-left text-[12.5px] ${
        isActive ? "bg-accentsoft font-semibold text-accent" : "text-ink2 hover:bg-surface2"
      }`}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {live ? (
          <span
            className="h-[7px] w-[7px] shrink-0 rounded-full bg-alert animate-report-pulse"
            aria-label={liveLabel}
          />
        ) : null}
        <span className="truncate">{label}</span>
      </span>
      <span
        className={`tnum shrink-0 font-mono text-[11px] font-semibold ${
          live ? "text-alert" : isActive ? "text-accent" : "text-faint"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function Item({
  label,
  count,
  index,
  value,
  active,
  onSelect,
}: {
  label: string;
  count: number;
  index?: SectorIndex;
  value: string;
  active: string;
  onSelect: (s: string) => void;
}) {
  const isActive = active === value;
  const rising = index ? index.changePct >= 0 : false;

  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      aria-current={isActive}
      title={index ? `${count} companies · index ${index.level.toFixed(2)}` : `${count} companies`}
      className={`flex w-auto items-center justify-between gap-2 rounded-[5px] px-2 py-1.5 text-left text-[12.5px] lg:w-full ${
        isActive ? "bg-accentsoft font-semibold text-accent" : "text-ink2 hover:bg-surface2"
      }`}
    >
      <span className="truncate">{label}</span>
      {index ? (
        <span
          className={`tnum shrink-0 font-mono text-[11px] font-semibold ${
            rising ? "text-pos" : "text-neg"
          }`}
        >
          {fmtSignedPct(index.changePct)}
        </span>
      ) : (
        <span
          className={`tnum shrink-0 font-mono text-[11px] ${
            isActive ? "text-accent" : "text-faint"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}
