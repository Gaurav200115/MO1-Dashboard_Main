"use client";

import { useEffect, useRef, useState } from "react";
import { COLUMNS } from "@/lib/metrics";
import { DASH } from "@/lib/format";
import type { LiveRow, SortKey } from "@/lib/types";
import ResultsMarker from "./ResultsMarker";

/**
 * Flashes for 420ms in the direction a value moved. Returns nothing on first
 * sight of a value, so the initial snapshot does not light the whole table up.
 */
function useTickFlash(value: number | null | undefined): "" | "tick-up" | "tick-down" {
  const previous = useRef(value);
  const [direction, setDirection] = useState<"" | "tick-up" | "tick-down">("");

  useEffect(() => {
    const before = previous.current;
    previous.current = value;
    if (before == null || value == null || before === value) return;

    setDirection(value > before ? "tick-up" : "tick-down");
    const timer = setTimeout(() => setDirection(""), 420);
    return () => clearTimeout(timer);
  }, [value]);

  return direction;
}

function LiveCell({
  value,
  text,
  tone,
}: {
  value: number | null;
  text: string;
  tone?: "signed" | "plain";
}) {
  const flash = useTickFlash(value);
  const colour =
    tone === "signed" && value != null
      ? value > 0
        ? "text-pos"
        : value < 0
          ? "text-neg"
          : "text-muted"
      : value == null
        ? "text-faint"
        : "";

  return (
    <td
      className={`tnum whitespace-nowrap border-b border-line px-3 py-2 text-right font-mono ${colour} ${flash}`}
    >
      {text}
    </td>
  );
}

export default function CompanyTable({
  companies,
  sortKey,
  sortDir,
  onSort,
  onOpen,
  today,
}: {
  companies: LiveRow[];
  sortKey: SortKey;
  sortDir: 1 | -1;
  onSort: (key: SortKey) => void;
  onOpen: (symbol: string) => void;
  today?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr>
            {COLUMNS.map((col) => {
              const active = sortKey === col.key;
              const alignLeft = col.kind === "symbol" || col.kind === "name";
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={active ? (sortDir === -1 ? "descending" : "ascending") : "none"}
                  className={`sticky top-0 z-[2] whitespace-nowrap border-b border-line bg-surface2 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] ${
                    alignLeft ? "text-left" : "text-right"
                  } ${active ? "text-accent" : "text-muted"}`}
                >
                  <button
                    type="button"
                    onClick={() => onSort(col.key)}
                    className="w-full cursor-pointer select-none uppercase"
                    style={{ textAlign: alignLeft ? "left" : "right" }}
                  >
                    {col.label}
                    {active ? (
                      <span className="ml-1 text-[9px] opacity-60">
                        {sortDir === -1 ? "▼" : "▲"}
                      </span>
                    ) : null}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {companies.length === 0 ? (
            <tr>
              <td colSpan={COLUMNS.length} className="p-10 text-center text-[13px] text-muted">
                Nothing matches that search.
              </td>
            </tr>
          ) : (
            companies.map((c) => (
              <tr
                key={c.symbol}
                tabIndex={0}
                role="button"
                onClick={() => onOpen(c.symbol)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpen(c.symbol);
                  }
                }}
                className="cursor-pointer hover:bg-surface2"
              >
                {COLUMNS.map((col) => {
                  if (col.kind === "symbol") {
                    return (
                      <td key={col.key} className="border-b border-line px-3 py-2 text-left">
                        <span className="font-display text-[12.5px] font-bold">{c.symbol}</span>
                        {c.variant === "standalone" ? (
                          <span
                            title="Standalone figures — no consolidated filing"
                            className="ml-1.5 rounded-full bg-alertsoft px-1.5 py-px text-[10px] text-alert"
                          >
                            SA
                          </span>
                        ) : null}
                      </td>
                    );
                  }
                  if (col.kind === "name") {
                    return (
                      <td
                        key={col.key}
                        className="max-w-[260px] truncate border-b border-line px-3 py-2 text-left text-muted"
                      >
                        {c.name}
                      </td>
                    );
                  }
                  if (col.kind === "due") {
                    return (
                      <td
                        key={col.key}
                        className="whitespace-nowrap border-b border-line px-3 py-2 text-right"
                      >
                        <ResultsMarker company={c} today={today} />
                      </td>
                    );
                  }
                  const value = (c[col.key as keyof LiveRow] ?? null) as number | null;
                  const text = col.fmt ? col.fmt(value) : DASH;

                  // Price and Δ% are the only cells the feed touches, so they are
                  // the only ones that pay for change detection.
                  if (col.kind === "price" || col.kind === "chg") {
                    return (
                      <LiveCell
                        key={col.key}
                        value={value}
                        text={text}
                        tone={col.kind === "chg" ? "signed" : "plain"}
                      />
                    );
                  }

                  return (
                    <td
                      key={col.key}
                      className={`tnum whitespace-nowrap border-b border-line px-3 py-2 text-right font-mono ${
                        value == null ? "text-faint" : ""
                      }`}
                    >
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
