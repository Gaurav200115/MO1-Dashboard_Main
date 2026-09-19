"use client";

import { useMemo } from "react";
import {
  CartesianGrid,
  Customized,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Quadrant, RotationRow } from "@/lib/sector/rotation";
import { QUADRANT_LABEL } from "@/lib/sector/rotation";

/**
 * The Relative Rotation Graph.
 *
 * Reading it: the x-axis is how far ahead of the market a sector *is*, the
 * y-axis is whether that lead is still growing. Sectors travel clockwise, so
 * the top-right (Leading) drains into the bottom-right (Weakening) and the
 * bottom-left (Lagging) feeds the top-left (Improving). The tail is ten
 * sessions of travel and matters more than the dot: a long smooth arc is a
 * rotation, a scribble around the centre is noise.
 *
 * Colour is *not* the identity channel here. Fourteen sectors is well past the
 * point where distinct hues stay distinguishable, so identity is carried by a
 * direct label on every dot, and colour only repeats the quadrant — which the
 * position already says. The desk red and green cannot be told apart under
 * deuteranopia, so the quadrant is additionally encoded as a marker shape:
 * circle leading, triangle-up improving, triangle-down weakening, square
 * lagging. Nothing on this chart is readable by colour alone.
 */

const QUADRANT_COLOUR: Record<Quadrant, string> = {
  leading: "var(--pos)",
  weakening: "var(--alert)",
  lagging: "var(--neg)",
  improving: "var(--accent)",
};

/** Shorter names, because fourteen labels have to sit on one plot. */
const SHORT: Record<string, string> = {
  "Financial Services (ex-Banks)": "Fin ex-Bk",
  "Consumer Durables": "Cons Dur",
  "Fast Moving Consumer Goods": "FMCG",
  "Information Technology": "IT",
  "Oil Gas & Consumable Fuels": "Oil & Gas",
  "Healthcare": "Health",
  "Capital Goods": "Cap Goods",
  "Construction Materials": "Cons Mat",
  "Automobile and Auto Components": "Auto",
  "Consumer Services": "Cons Svc",
  "Metals & Mining": "Metals",
  "Telecommunication": "Telecom",
  "Chemicals": "Chem",
  "Realty": "Realty",
  "Power": "Power",
  "Services": "Services",
  "Diversified": "Divers",
  "Forest Materials": "Forest",
  "Textiles": "Textiles",
  "Media Entertainment & Publication": "Media",
};

function short(sector: string): string {
  return SHORT[sector] ?? (sector.length > 10 ? `${sector.slice(0, 9)}.` : sector);
}

interface Point {
  x: number;
  y: number;
  sector: string;
  quadrant: Quadrant;
  head: boolean;
  date: string;
  rank: number;
  excess: number | null;
}

/**
 * One marker. Recharts hands the shape a resolved cx/cy, so the geometry below
 * is in pixels and needs no access to the scale.
 *
 * Typed as `unknown` because that is what Recharts declares a customised shape
 * to receive, and it has to return an element on every path rather than null.
 */
function Marker(raw: unknown) {
  const { cx, cy, payload } = (raw ?? {}) as { cx?: number; cy?: number; payload?: Point };
  if (cx == null || cy == null || !payload) return <g />;

  const colour = QUADRANT_COLOUR[payload.quadrant];

  // Tail points are small, hollow-ish and unlabelled — they are the path, not
  // the reading.
  if (!payload.head) {
    return <circle cx={cx} cy={cy} r={2} fill={colour} opacity={0.45} />;
  }

  const r = 5.5;
  const ring = { stroke: "var(--surface)", strokeWidth: 2 };
  let mark;
  switch (payload.quadrant) {
    case "leading":
      mark = <circle cx={cx} cy={cy} r={r} fill={colour} {...ring} />;
      break;
    case "lagging":
      mark = (
        <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} fill={colour} {...ring} />
      );
      break;
    case "improving":
      mark = (
        <polygon
          points={`${cx},${cy - r - 1} ${cx + r + 1},${cy + r} ${cx - r - 1},${cy + r}`}
          fill={colour}
          {...ring}
        />
      );
      break;
    default:
      mark = (
        <polygon
          points={`${cx},${cy + r + 1} ${cx + r + 1},${cy - r} ${cx - r - 1},${cy - r}`}
          fill={colour}
          {...ring}
        />
      );
  }

  return mark;
}

const LABEL_HEIGHT = 12;
const MARKER_R = 5.5;

/**
 * Sector labels, laid out in one pass over all of them.
 *
 * They cannot be drawn inside the marker shape: that runs once per point with no
 * knowledge of the others, and a dozen sectors bunched near the centre — which is
 * the normal state of a market that is not rotating hard — writes four names on
 * top of each other. Recharts hands a `Customized` layer the resolved axis
 * scales, which is the only place pixel positions for every head exist at once.
 *
 * The rule is a greedy vertical push-apart after sorting by y, the standard
 * treatment for direct labels on a scatter. Names on the right half anchor to the
 * left of their dot so nothing runs off the plot.
 */
function LabelLayer(raw: unknown) {
  const props = (raw ?? {}) as {
    xAxisMap?: Record<string, { scale?: (value: number) => number }>;
    yAxisMap?: Record<string, { scale?: (value: number) => number }>;
    heads?: Point[];
    offset?: { left: number; width: number };
  };

  const xScale = Object.values(props.xAxisMap ?? {})[0]?.scale;
  const yScale = Object.values(props.yAxisMap ?? {})[0]?.scale;
  const heads = props.heads ?? [];
  if (!xScale || !yScale || heads.length === 0) return <g />;

  const placed = heads
    .map((head) => ({ head, cx: xScale(head.x), cy: yScale(head.y) }))
    .filter((entry) => Number.isFinite(entry.cx) && Number.isFinite(entry.cy))
    .sort((a, b) => a.cy - b.cy);

  const midpoint = (props.offset?.left ?? 0) + (props.offset?.width ?? 0) / 2;
  let lastY = Number.NEGATIVE_INFINITY;

  return (
    <g>
      {placed.map(({ head, cx, cy }) => {
        const y = Math.max(cy + 3.5, lastY + LABEL_HEIGHT);
        lastY = y;
        // Right-half dots label leftwards, so a long name near the edge stays on
        // the plot instead of being clipped by it.
        const right = cx > midpoint;

        return (
          <text
            key={head.sector}
            x={right ? cx - MARKER_R - 4 : cx + MARKER_R + 4}
            y={y}
            textAnchor={right ? "end" : "start"}
            className="fill-ink2 font-mono"
            style={{
              fontSize: 10,
              paintOrder: "stroke",
              stroke: "var(--surface)",
              strokeWidth: 3,
            }}
          >
            {short(head.sector)}
          </text>
        );
      })}
    </g>
  );
}

function GraphTooltip({ active, payload }: { active?: boolean; payload?: { payload: Point }[] }) {
  const point = payload?.[0]?.payload;
  if (!active || !point || !point.head) return null;

  return (
    <div className="rounded-[5px] border border-linestrong bg-surface px-2.5 py-2 text-[11px] shadow-sm">
      <div className="mb-1 font-semibold">{point.sector}</div>
      <div className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 font-mono text-[10.5px]">
        <span className="text-muted">Quadrant</span>
        <span style={{ color: QUADRANT_COLOUR[point.quadrant] }}>
          {QUADRANT_LABEL[point.quadrant]}
        </span>
        <span className="text-muted">RS-Ratio</span>
        <span className="tnum text-right">{point.x.toFixed(2)}</span>
        <span className="text-muted">RS-Mom</span>
        <span className="tnum text-right">{point.y.toFixed(2)}</span>
        <span className="text-muted">1M excess</span>
        <span className="tnum text-right">
          {point.excess == null ? "—" : `${point.excess >= 0 ? "+" : "−"}${Math.abs(point.excess).toFixed(2)}pp`}
        </span>
      </div>
    </div>
  );
}

export default function RotationGraph({ rows }: { rows: RotationRow[] }) {
  const series = useMemo(() => {
    return rows
      .filter((row) => row.quadrant != null && row.tail.length > 0)
      .map((row) => ({
        sector: row.sector,
        points: row.tail.map((point, i): Point => ({
          x: point.rsRatio,
          y: point.rsMomentum,
          sector: row.sector,
          // The tail is coloured by where the sector is *now*, not by the
          // quadrant each point sat in — the path is one sector travelling, and
          // recolouring it mid-tail would read as four different sectors.
          quadrant: row.quadrant as Quadrant,
          head: i === row.tail.length - 1,
          date: point.date,
          rank: row.rank,
          excess: row.excess.m1,
        })),
      }));
  }, [rows]);

  /*
   * Symmetric about (100, 100), which is what makes the quadrants comparable by
   * eye: an asymmetric window would put the centre lines off-centre and make a
   * sector look further into a quadrant than it is.
   */
  const span = useMemo(() => {
    let widest = 0;
    for (const entry of series) {
      for (const point of entry.points) {
        widest = Math.max(widest, Math.abs(point.x - 100), Math.abs(point.y - 100));
      }
    }
    return Math.max(1.2, widest * 1.18);
  }, [series]);

  /** The current dot of each sector — the only points that get a name. */
  const heads = useMemo(
    () =>
      series
        .map((entry) => entry.points[entry.points.length - 1])
        .filter((point): point is Point => point != null),
    [series]
  );

  if (series.length === 0) {
    return (
      <p className="py-8 text-center text-[12px] text-muted">
        Not enough stored history yet for the rotation coordinates.
      </p>
    );
  }

  const low = 100 - span;
  const high = 100 + span;
  const tick = (value: number) => value.toFixed(1);

  return (
    <div className="h-[420px] w-full">
      <ResponsiveContainer>
        <ScatterChart margin={{ top: 12, right: 28, bottom: 26, left: 4 }}>
          {/* Quadrant washes. Faint on purpose — they name the regions, the dots
              carry the data, and a strong fill would fight the markers. */}
          <ReferenceArea x1={100} x2={high} y1={100} y2={high} fill="var(--pos)" fillOpacity={0.06} />
          <ReferenceArea x1={100} x2={high} y1={low} y2={100} fill="var(--alert)" fillOpacity={0.06} />
          <ReferenceArea x1={low} x2={100} y1={low} y2={100} fill="var(--neg)" fillOpacity={0.06} />
          <ReferenceArea x1={low} x2={100} y1={100} y2={high} fill="var(--accent)" fillOpacity={0.06} />

          <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" />

          <XAxis
            type="number"
            dataKey="x"
            domain={[low, high]}
            tickFormatter={tick}
            tick={{ fill: "var(--faint)", fontSize: 10 }}
            stroke="var(--line)"
            label={{
              value: "RS-Ratio  →  stronger relative to Nifty 200",
              position: "insideBottom",
              offset: -14,
              style: { fill: "var(--muted)", fontSize: 10.5 },
            }}
          />
          <YAxis
            type="number"
            dataKey="y"
            domain={[low, high]}
            tickFormatter={tick}
            tick={{ fill: "var(--faint)", fontSize: 10 }}
            stroke="var(--line)"
            width={44}
            label={{
              value: "RS-Momentum",
              angle: -90,
              position: "insideLeft",
              style: { fill: "var(--muted)", fontSize: 10.5, textAnchor: "middle" },
            }}
          />

          <ReferenceLine x={100} stroke="var(--line-strong)" />
          <ReferenceLine y={100} stroke="var(--line-strong)" />

          <Tooltip content={<GraphTooltip />} cursor={{ stroke: "var(--line-strong)" }} />

          {series.map((entry) => (
            <Scatter
              key={entry.sector}
              name={entry.sector}
              data={entry.points}
              shape={Marker}
              isAnimationActive={false}
              line={{
                stroke: QUADRANT_COLOUR[entry.points[entry.points.length - 1].quadrant],
                strokeWidth: 1.5,
                strokeOpacity: 0.5,
              }}
              lineType="joint"
            />
          ))}

          {/* Last, so the names sit above every marker and tail. */}
          <Customized component={LabelLayer} heads={heads} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
