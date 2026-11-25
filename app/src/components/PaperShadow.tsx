"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { ShadowTrade } from "@/lib/strategy/shadowAtr";

/**
 * The ATR600 paper forward test, beside the desk's own paper trades.
 *
 * Every paper trade since 2026-11-25 also runs, in paper only, under the
 * backtest's -ATR600 exit (lib/strategy/shadowAtr.ts): same entry, same option,
 * same fills - SL at the stock's 5-min ATR / 3 in premium points, ladder in
 * Rs 600 steps with the stop to cost at +900. One row a day; click a day for its
 * trades. Read-only - nothing here touches the paper or the live desk.
 */

interface Row {
  shadow: ShadowTrade;
  paper: {
    profit: number | null;
    status: string;
    reason: string | null;
    exitPrice: number | null;
    exitAt: number | null;
  } | null;
}

interface Reply {
  configured?: boolean;
  rows?: Row[];
  error?: string;
}

export default function PaperShadow() {
  const [reply, setReply] = useState<Reply | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/paper-shadow", { cache: "no-store" })
      .then(async (r) => setReply((await r.json()) as Reply))
      .catch((err) => setReply({ error: (err as Error).message }));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const days = useMemo(() => {
    const byDay = new Map<string, Row[]>();
    for (const row of reply?.rows ?? []) {
      const list = byDay.get(row.shadow.tradingDate);
      if (list) list.push(row);
      else byDay.set(row.shadow.tradingDate, [row]);
    }
    return [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([date, rows]) => {
        // Only trades both sides have finished are summed, so an open one never
        // makes either column look better than it is.
        const done = rows.filter((r) => r.shadow.status === "closed" && r.paper?.status === "closed");
        return {
          date,
          rows,
          compared: done.length,
          paper: done.reduce((s, r) => s + (r.paper?.profit ?? 0), 0),
          atr: done.reduce((s, r) => s + (r.shadow.profit ?? 0), 0),
          pending: rows.filter((r) => r.shadow.status === "open" || r.paper?.status !== "closed").length,
          noAtr: rows.filter((r) => r.shadow.status === "no-atr").length,
        };
      });
  }, [reply]);

  const total = days.reduce(
    (t, d) => ({ n: t.n + d.compared, paper: t.paper + d.paper, atr: t.atr + d.atr }),
    { n: 0, paper: 0, atr: 0 }
  );

  return (
    <div className="rounded-[5px] border border-line">
      <div className="flex flex-wrap items-baseline gap-2 border-b border-line px-3 py-2">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.13em] text-muted">
          Paper forward test — ATR600 exit
        </h3>
        <span className="text-[10.5px] text-faint">
          Same paper trades, exited under ATR/3 SL + ₹600 ladder (cost at +₹900). Paper only.
        </span>
        <button
          type="button"
          onClick={load}
          className="ml-auto rounded-[4px] border border-line px-2 py-0.5 text-[11px] text-ink2 hover:bg-surface2"
        >
          Refresh
        </button>
      </div>

      {reply?.error ? (
        <p className="px-3 py-3 text-[12px] text-neg">Could not load: {reply.error}</p>
      ) : !reply ? (
        <p className="px-3 py-3 text-[12px] text-muted">Loading…</p>
      ) : days.length === 0 ? (
        <p className="px-3 py-3 text-[12px] text-muted">
          No paper trades with an ATR600 shadow yet — they start with the first paper trade after this deploy.
        </p>
      ) : (
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-muted">
              <th className="px-3 py-1 font-bold">Day</th>
              <th className="px-3 py-1 text-right font-bold">Trades</th>
              <th className="px-3 py-1 text-right font-bold">Desk exit (paper)</th>
              <th className="px-3 py-1 text-right font-bold">ATR600 exit</th>
              <th className="px-3 py-1 text-right font-bold">Difference</th>
              <th className="px-3 py-1 font-bold" />
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-line bg-sunken font-semibold">
              <td className="px-3 py-1.5">All days</td>
              <td className="px-3 py-1.5 text-right font-mono">{total.n}</td>
              <td className={`px-3 py-1.5 text-right font-mono ${tone(total.paper)}`}>{rupees(total.paper)}</td>
              <td className={`px-3 py-1.5 text-right font-mono ${tone(total.atr)}`}>{rupees(total.atr)}</td>
              <td className={`px-3 py-1.5 text-right font-mono ${tone(total.atr - total.paper)}`}>
                {rupees(total.atr - total.paper)}
              </td>
              <td />
            </tr>
            {days.map((d) => (
              <Fragment key={d.date}>
                <tr
                  className="cursor-pointer border-t border-line hover:bg-surface2"
                  onClick={() => setOpen((v) => (v === d.date ? null : d.date))}
                >
                  <td className="px-3 py-1.5 font-mono">{d.date}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{d.compared}</td>
                  <td className={`px-3 py-1.5 text-right font-mono ${tone(d.paper)}`}>{rupees(d.paper)}</td>
                  <td className={`px-3 py-1.5 text-right font-mono ${tone(d.atr)}`}>{rupees(d.atr)}</td>
                  <td className={`px-3 py-1.5 text-right font-mono ${tone(d.atr - d.paper)}`}>
                    {rupees(d.atr - d.paper)}
                  </td>
                  <td className="px-3 py-1.5 text-[10.5px] text-faint">
                    {d.pending ? `${d.pending} still running · ` : ""}
                    {d.noAtr ? `${d.noAtr} no ATR · ` : ""}
                    {open === d.date ? "hide" : "trades"}
                  </td>
                </tr>
                {open === d.date ? (
                  <tr className="border-t border-line bg-sunken">
                    <td colSpan={6} className="px-3 py-2">
                      <Trades rows={d.rows} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Trades({ rows }: { rows: Row[] }) {
  return (
    <table className="w-full border-collapse text-[11.5px]">
      <thead>
        <tr className="text-left text-[9.5px] uppercase tracking-[0.08em] text-muted">
          <th className="py-0.5 pr-3">Time</th>
          <th className="py-0.5 pr-3">Stock</th>
          <th className="py-0.5 pr-3 text-right">Entry</th>
          <th className="py-0.5 pr-3 text-right">Desk exit</th>
          <th className="py-0.5 pr-3 text-right">ATR · SL pts · R</th>
          <th className="py-0.5 pr-3 text-right">ATR600 exit</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ shadow, paper }) => (
          <tr key={shadow._id}>
            <td className="py-0.5 pr-3 font-mono">{clock(shadow.entryAt)}</td>
            <td className="py-0.5 pr-3 font-mono">
              {shadow.symbol} <span className="text-faint">{shadow.setup}</span>
            </td>
            <td className="py-0.5 pr-3 text-right font-mono">{shadow.entry.toFixed(2)}</td>
            <td className={`py-0.5 pr-3 text-right font-mono ${tone(paper?.profit ?? 0)}`}>
              {paper?.status === "closed" && paper.profit != null
                ? `${rupees(paper.profit)} · ${paper.reason ?? ""}`
                : "running"}
            </td>
            <td className="py-0.5 pr-3 text-right font-mono text-muted">
              {shadow.atr != null && shadow.stopPoints != null && shadow.riskRupees != null
                ? `${shadow.atr.toFixed(2)} · ${shadow.stopPoints.toFixed(2)} · ₹${Math.round(shadow.riskRupees)}`
                : "no ATR"}
            </td>
            <td className={`py-0.5 pr-3 text-right font-mono ${tone(shadow.profit ?? 0)}`}>
              {shadow.status === "closed" && shadow.profit != null && shadow.exit
                ? `${rupees(shadow.profit)} · ${shadow.exit.reason}`
                : shadow.status === "no-atr"
                  ? "—"
                  : "running"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function rupees(v: number): string {
  const r = Math.round(v);
  return `${r < 0 ? "−" : r > 0 ? "+" : ""}₹${Math.abs(r).toLocaleString("en-IN")}`;
}

function tone(v: number): string {
  return v > 0 ? "text-pos" : v < 0 ? "text-neg" : "text-muted";
}

function clock(ms: number): string {
  return new Date(ms + 5.5 * 3_600_000).toISOString().slice(11, 16);
}
