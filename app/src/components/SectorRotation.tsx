"use client";

import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { fmtSignedPct, grouped } from "@/lib/format";
import type { Horizon, Quadrant, RotationRow, RotationView } from "@/lib/sector/rotation";
import { MIN_DEPTH, QUADRANT_LABEL } from "@/lib/sector/rotation";
import RotationGraph from "./RotationGraph";

/**
 * The rotation desk: where money has been, where it is going, and how much of
 * the sector is actually in the move.
 *
 * Ordered by one-month excess return rather than by raw return, because
 * rotation is a relative question — in a month the market fell 6%, a sector
 * down 2% is the leadership, and the raw column would have you sell it.
 */

/** How each ranking horizon reads in a heading. */
const HORIZON_LABEL: Record<Horizon, string> = {
  d1: "1-session",
  w1: "1-week",
  m1: "1-month",
  m3: "3-month",
  m6: "6-month",
};

const QUADRANT_CLASS: Record<Quadrant, string> = {
  leading: "text-pos",
  weakening: "text-alert",
  lagging: "text-neg",
  improving: "text-accent",
};

/** The same shapes the graph uses, so the table and the plot read as one thing. */
const QUADRANT_GLYPH: Record<Quadrant, string> = {
  leading: "●",
  improving: "▲",
  weakening: "▼",
  lagging: "■",
};

function pp(value: number | null): string {
  if (value == null) return "—";
  return `${value >= 0 ? "+" : "−"}${grouped(Math.abs(value), 2)}`;
}

/** The dash has to stand alone — "—%" reads as a value that failed to format. */
function ppPct(value: number | null): string {
  return value == null ? "—" : `${pp(value)}%`;
}

function Signed({ value, suffix }: { value: number | null; suffix?: string }) {
  const tone = value == null ? "text-faint" : value > 0 ? "text-pos" : value < 0 ? "text-neg" : "text-muted";
  return (
    <td className={`tnum whitespace-nowrap border-b border-line px-2.5 py-2 text-right font-mono ${tone}`}>
      {value == null ? "—" : `${pp(value)}${suffix ?? ""}`}
    </td>
  );
}

function RankCell({ row }: { row: RotationRow }) {
  const change = row.rankChange;
  return (
    <td className="whitespace-nowrap border-b border-line px-2.5 py-2 text-right">
      <span className="tnum font-mono text-[12px] font-semibold">{row.rank}</span>
      {change != null && change !== 0 ? (
        <span
          className={`ml-1.5 inline-flex items-center gap-px font-mono text-[10px] ${
            change > 0 ? "text-pos" : "text-neg"
          }`}
          title={`${Math.abs(change)} place${Math.abs(change) === 1 ? "" : "s"} ${
            change > 0 ? "up" : "down"
          } in the last week`}
        >
          {change > 0 ? <ArrowUp size={9} /> : <ArrowDown size={9} />}
          {Math.abs(change)}
        </span>
      ) : change === 0 ? (
        <span className="ml-1.5 inline-flex text-faint" title="Unchanged over the week">
          <Minus size={9} />
        </span>
      ) : null}
    </td>
  );
}

export default function SectorRotation({
  view,
  onSelect,
}: {
  view: RotationView;
  onSelect: (sector: string) => void;
}) {
  const bench = view.benchmark;

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-wrap items-end gap-x-8 gap-y-3 border-b border-line pb-3.5">
        <div>
          <h2 className="font-display text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
            Nifty 200 · in-house benchmark
          </h2>
          <div className="mt-1 flex items-baseline gap-2.5">
            <span className="tnum font-mono text-[27px] font-semibold leading-none">
              {grouped(bench.level, 2)}
            </span>
            <span
              className={`tnum font-mono text-[14px] font-semibold ${
                bench.changePct >= 0 ? "text-pos" : "text-neg"
              }`}
            >
              {fmtSignedPct(bench.changePct)}
            </span>
          </div>
        </div>

        <Stat label="As of">{view.asOf}</Stat>
        <Stat label="Sessions stored">{view.depth}</Stat>
        <Stat label="1M">{ppPct(bench.ret.m1)}</Stat>
        <Stat label="3M">{ppPct(bench.ret.m3)}</Stat>
        <Stat label="Above 50D">
          {bench.breadth.above50Pct == null ? "—" : `${bench.breadth.above50Pct.toFixed(0)}%`}
        </Stat>

        <p className="ml-auto max-w-[30ch] text-[10.5px] leading-snug text-faint">
          Sector strength is measured against this, not against zero. Every excess column below is
          in percentage points over it.
        </p>
      </section>

      {view.ready ? (
        <section className="rounded-md border border-line bg-surface">
          <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
            <h2 className="font-display text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
              Relative rotation · {view.params.tail}-session tails
            </h2>
            <div className="ml-auto flex flex-wrap items-center gap-3.5 text-[11px]">
              {(["improving", "leading", "weakening", "lagging"] as Quadrant[]).map((q) => (
                <span key={q} className={`flex items-center gap-1.5 ${QUADRANT_CLASS[q]}`}>
                  <span aria-hidden>{QUADRANT_GLYPH[q]}</span>
                  {QUADRANT_LABEL[q]}
                </span>
              ))}
            </div>
          </div>
          <div className="px-2 py-3">
            <RotationGraph rows={view.rows} />
          </div>
        </section>
      ) : (
        <p className="rounded-md border border-line bg-surface px-4 py-3 text-[12px] text-muted">
          The rotation graph needs {MIN_DEPTH} stored sessions before its coordinates mean anything —
          both axes are normalised over a {view.params.rsWindow}-session window, and the second one
          normalises a change measured across the first. {view.depth} stored so far. The table below
          works from the first session.
        </p>
      )}

      <section className="overflow-hidden rounded-md border border-line bg-surface">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <h2 className="font-display text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
            Rotation table · ranked on {HORIZON_LABEL[view.rankedOn]} excess
          </h2>
          <span className="ml-auto text-[11px] text-muted">
            {view.rankedOn === "m1"
              ? "Rank arrows compare with the same measure one week ago"
              : `Only ${view.depth} sessions stored — too short for the usual one-month ranking, so this is the longest window the chain supports`}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="bg-surface2 text-[10px] uppercase tracking-[0.08em] text-muted">
                <Th align="right" hint={`Position on the ${HORIZON_LABEL[view.rankedOn]} excess ranking`}>
                  #
                </Th>
                <Th hint="Click to open the sector">Sector</Th>
                <Th align="right" hint="Chained index level — not rebased daily">
                  Level
                </Th>
                <Th align="right" hint="Last stored session">
                  1D
                </Th>
                <Th align="right" hint="Excess return over the benchmark, 1 week, in points">
                  1W ex
                </Th>
                <Th align="right" hint="Excess return over the benchmark, 1 month, in points">
                  1M ex
                </Th>
                <Th align="right" hint="Excess return over the benchmark, 3 months, in points">
                  3M ex
                </Th>
                <Th align="right" hint="Normalised relative strength — above 100 is outperforming">
                  RS-Ratio
                </Th>
                <Th align="right" hint="Change in RS-Ratio, normalised — above 100 is still gaining">
                  RS-Mom
                </Th>
                <Th hint="Quadrant, and how many sessions it has held it">Quadrant</Th>
                <Th align="right" hint="Constituents above their own 50-session average">
                  &gt;50D
                </Th>
                <Th align="right" hint="Session turnover against this sector own 20-session average">
                  Flow
                </Th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row) => (
                <tr key={row.sector} className="hover:bg-surface2">
                  <RankCell row={row} />
                  <td className="whitespace-nowrap border-b border-line px-2.5 py-2">
                    <button
                      type="button"
                      onClick={() => onSelect(row.sector)}
                      className="text-left hover:text-accent hover:underline"
                    >
                      {row.sector}
                    </button>
                  </td>
                  <td className="tnum whitespace-nowrap border-b border-line px-2.5 py-2 text-right font-mono">
                    {grouped(row.level, 2)}
                  </td>
                  <Signed value={row.changePct} suffix="%" />
                  <Signed value={row.excess.w1} />
                  <Signed value={row.excess.m1} />
                  <Signed value={row.excess.m3} />
                  <td className="tnum whitespace-nowrap border-b border-line px-2.5 py-2 text-right font-mono">
                    {row.rsRatio == null ? "—" : row.rsRatio.toFixed(2)}
                  </td>
                  <td className="tnum whitespace-nowrap border-b border-line px-2.5 py-2 text-right font-mono">
                    {row.rsMomentum == null ? "—" : row.rsMomentum.toFixed(2)}
                  </td>
                  <td className="whitespace-nowrap border-b border-line px-2.5 py-2">
                    {row.quadrant ? (
                      <span className={`flex items-center gap-1.5 ${QUADRANT_CLASS[row.quadrant]}`}>
                        <span aria-hidden>{QUADRANT_GLYPH[row.quadrant]}</span>
                        {QUADRANT_LABEL[row.quadrant]}
                        {row.sessionsInQuadrant ? (
                          <span className="tnum font-mono text-[10px] text-faint">
                            {row.sessionsInQuadrant}d
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td
                    className={`tnum whitespace-nowrap border-b border-line px-2.5 py-2 text-right font-mono ${
                      row.breadth.above50Pct == null
                        ? "text-faint"
                        : row.breadth.above50Pct >= 50
                          ? "text-pos"
                          : "text-neg"
                    }`}
                  >
                    {row.breadth.above50Pct == null ? "—" : `${row.breadth.above50Pct.toFixed(0)}%`}
                  </td>
                  <Signed value={row.turnoverDriftPct} suffix="%" />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-md border border-line bg-surface px-4 py-3.5">
        <h2 className="font-display text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
          How to read it
        </h2>
        <p className="mt-2 max-w-[92ch] text-[12px] leading-relaxed text-ink2">
          Sectors rotate <strong>clockwise</strong>:{" "}
          <span className="text-accent">Improving</span> →{" "}
          <span className="text-pos">Leading</span> →{" "}
          <span className="text-alert">Weakening</span> →{" "}
          <span className="text-neg">Lagging</span> → back to Improving. The trade is at the two
          hinges, not in the middle of a quadrant. A sector crossing into{" "}
          <span className="text-accent">Improving</span> is still behind on every trailing return
          column — that is the point, the ranking confirms it weeks later. A sector sliding into{" "}
          <span className="text-alert">Weakening</span> still tops the 1M and 3M columns while the
          money is already leaving.
        </p>
        <ul className="mt-2.5 flex max-w-[92ch] flex-col gap-1.5 text-[12px] leading-relaxed text-ink2">
          <li>
            <strong>Distance from the centre is conviction.</strong> A dot hugging (100, 100) is a
            sector doing nothing relative to the market, whichever side of the line it fell on.
          </li>
          <li>
            <strong>Read the tail, not the dot.</strong> A long smooth arc is a rotation; a scribble
            near the middle is noise, and a sector that turns back into the quadrant it came from
            without completing the loop is a failed rotation, not an early one.
          </li>
          <li>
            <strong>Check breadth before believing a leader.</strong> Leading with{" "}
            <span className="font-mono">&gt;50D</span> under 40% is one or two heavy constituents
            wearing a sector costume — the index is free-float weighted, so a single ₹10-lakh-crore
            name can carry a whole sector on its own.
          </li>
          <li>
            <strong>Flow separates a re-rating from a drift.</strong> Positive Flow is turnover
            running above this sector own recent normal, which is money arriving rather than price
            moving on nothing.
          </li>
          <li>
            <strong>Rank change leads the ranking.</strong> A sector four places higher than last
            week is rotating whether or not it has reached the top yet.
          </li>
        </ul>
      </section>
    </div>
  );
}

function Th({
  children,
  align,
  hint,
}: {
  children: React.ReactNode;
  align?: "right";
  hint: string;
}) {
  return (
    <th
      title={hint}
      className={`whitespace-nowrap border-b border-line px-2.5 py-2 font-semibold ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
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
