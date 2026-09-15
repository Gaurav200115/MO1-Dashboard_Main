"use client";

import { Fragment, useMemo } from "react";
import { Calendar } from "lucide-react";
import type { StoredDay, StoredLevel } from "@/lib/eod/store";
import { DASH, fmtPrice, grouped } from "@/lib/format";
import { useLevels } from "@/lib/useLevels";

interface Group {
  symbol: string;
  name: string;
  close: number;
  nearestReach: number;
  levels: StoredLevel[];
}

/**
 * The stored archive, grouped by stock: one block per symbol, its levels listed
 * as a price ladder so the close can be read against them at a glance.
 */
export default function LevelArchive({ active }: { active: boolean }) {
  const { sessions, session, days, loading, error, configured, select } = useLevels(active);

  const groups = useMemo<Group[]>(
    () =>
      days
        .map((day) => ({
          symbol: day.symbol,
          name: day.name,
          close: day.close.close,
          nearestReach: Math.min(...day.levels.map((level) => level.reachPct)),
          // Highest first, so the block reads as a ladder around the close.
          levels: [...day.levels].sort((a, b) => b.pivotValue - a.pivotValue),
        }))
        .sort((a, b) => a.nearestReach - b.nearestReach),
    [days]
  );

  const summary = useMemo(() => sessions.find((s) => s.session === session), [sessions, session]);
  const levelCount = groups.reduce((n, group) => n + group.levels.length, 0);
  const scored = groups.reduce(
    (n, group) => n + group.levels.filter((level) => level.hit !== null).length,
    0
  );

  if (!configured) {
    return (
      <Shell>
        <p className="text-[12.5px] text-muted">
          No archive yet — <code className="font-mono text-[11.5px]">MONGO_CONNECTION_STRING</code>{" "}
          is not set in <code className="font-mono text-[11.5px]">.env.local</code>.
        </p>
      </Shell>
    );
  }

  return (
    <section
      aria-label="Level archive"
      className="mb-5 overflow-hidden rounded-md border border-line bg-surface"
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <h2 className="font-display text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
          Archive
        </h2>

        <label className="flex items-center gap-1.5 text-[11px] text-muted">
          <Calendar size={12} aria-hidden />
          <span className="sr-only">Session</span>
          <select
            value={session ?? ""}
            onChange={(event) => select(event.target.value)}
            disabled={sessions.length === 0}
            className="rounded-md border border-line bg-sunken px-2 py-1 font-mono text-[11.5px] text-ink"
          >
            {sessions.length === 0 ? <option value="">No sessions stored</option> : null}
            {sessions.map((entry) => (
              <option key={entry.session} value={entry.session}>
                {entry.session} → {entry.tradingFor}
              </option>
            ))}
          </select>
        </label>

        {summary ? (
          <span className="rounded-[3px] border border-linestrong px-1.5 py-px text-[10px] uppercase tracking-[0.1em] text-muted">
            {summary.stocks} stocks · {summary.levels} levels · {summary.precious} ◆
          </span>
        ) : null}

        <p className="ml-auto max-w-[46ch] text-[10.5px] leading-snug text-faint">
          Closing range, the pivots derived for the next session, and the levels the option chain
          corroborated. Outcome is scored once that session has traded.
        </p>
      </div>

      {loading ? (
        <p className="px-4 py-4 text-[12px] text-muted">Loading…</p>
      ) : error ? (
        <p className="px-4 py-4 text-[12px] text-neg">{error}</p>
      ) : groups.length === 0 ? (
        <p className="px-4 py-4 text-[12px] text-muted">
          Nothing archived yet. The scan writes a session after it runs.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-line text-[10px] uppercase tracking-[0.08em] text-muted">
                <Th className="text-left">Stock</Th>
                <Th>Close</Th>
                <Th>Type</Th>
                <Th>Pivot</Th>
                <Th>Level</Th>
                <Th>Strike</Th>
                <Th>Gap</Th>
                <Th>Reach</Th>
                <Th>Skew</Th>
                <Th>Outcome</Th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <Fragment key={group.symbol}>
                  {group.levels.map((level, index) => (
                    <tr
                      key={level.pivot}
                      className={`hover:bg-surface2 ${
                        index === 0 ? "border-t-2 border-linestrong" : ""
                      }`}
                    >
                      {index === 0 ? (
                        <>
                          <td
                            rowSpan={group.levels.length}
                            className="px-3 py-1.5 align-top text-left"
                          >
                            <span className="font-mono text-[12px] font-semibold">
                              {group.symbol}
                            </span>
                            <span
                              className="block max-w-[18ch] truncate text-[10px] text-faint"
                              title={group.name}
                            >
                              {group.name}
                            </span>
                          </td>
                          <td
                            rowSpan={group.levels.length}
                            className="tnum px-3 py-1.5 text-right align-top font-mono"
                          >
                            {fmtPrice(group.close)}
                          </td>
                        </>
                      ) : null}
                      <LevelCells level={level} />
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {groups.length > 0 ? (
        <p className="border-t border-line px-4 py-2 text-[10.5px] text-faint">
          {groups.length} stocks · {levelCount} levels · {scored} scored.{" "}
          {scored === 0
            ? "Outcomes fill in once the traded session can be compared against these levels."
            : null}
        </p>
      ) : null}
    </section>
  );
}

function LevelCells({ level }: { level: StoredLevel }) {
  const support = level.kind === "support";
  const dominant = support ? level.putOi : level.callOi;
  const other = support ? level.callOi : level.putOi;
  const skew = other > 0 ? dominant / other : null;

  return (
    <>
      <Td>
        <span className={`font-mono text-[10px] font-bold ${support ? "text-pos" : "text-neg"}`}>
          {support ? "S" : "R"}
        </span>
      </Td>
      <Td>
        <span className="font-mono text-[11px] text-muted">{level.pivot}</span>
      </Td>
      <Td>
        <span className="font-semibold">{fmtPrice(level.pivotValue)}</span>
        {level.precious ? (
          <span className="ml-1 text-accent" title={`Agree to ${grouped(level.gapPct, 2)}%`}>
            ◆
          </span>
        ) : null}
      </Td>
      <Td>{grouped(level.strike, 2)}</Td>
      <Td>{grouped(level.gapPct, 2)}%</Td>
      <Td>{grouped(level.reachPct, 2)}%</Td>
      <Td>{skew == null ? "1-sided" : `${grouped(skew, 1)}×`}</Td>
      <Td>
        {level.hit === null ? (
          <span className="text-faint">{DASH}</span>
        ) : level.hit === false ? (
          <span className="text-muted">not reached</span>
        ) : level.held ? (
          <span className="text-pos">held</span>
        ) : (
          <span className="text-neg">broke</span>
        )}
      </Td>
    </>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="mb-5 overflow-hidden rounded-md border border-line bg-surface">
      <div className="border-b border-line px-4 py-3">
        <h2 className="font-display text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
          Archive
        </h2>
      </div>
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2 text-right font-medium ${className}`}>{children}</th>;
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`tnum px-3 py-1.5 text-right font-mono ${className}`}>{children}</td>;
}
