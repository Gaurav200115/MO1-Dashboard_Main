"use client";

import { Fragment, useMemo, useState } from "react";
import type { LedgerDay, LedgerReport } from "@/lib/backtest/store";

/**
 * A backtest run's capital ledger (backtest/ledger.py): the balance the run
 * started with, how it moved trade by trade and day by day, and which trades it
 * could not afford. Shown for runs asked with a capital; read from the run, so it
 * is the whole run - the page's filters do not apply to it.
 *
 * The balance decided the trades: a signal whose premium did not fit in what was
 * left after the open trades was skipped (counted per day). 1 lot always.
 */
export default function LedgerPanel({ ledger }: { ledger: LedgerReport }) {
  const [openMonth, setOpenMonth] = useState<string | null>(null);

  const months = useMemo(() => {
    const byMonth = new Map<string, LedgerDay[]>();
    for (const day of ledger.days) {
      const key = day.date.slice(0, 7);
      const list = byMonth.get(key);
      if (list) list.push(day);
      else byMonth.set(key, [day]);
    }
    return [...byMonth.entries()].map(([month, days]) => ({
      month,
      days,
      open: days[0].open,
      close: days[days.length - 1].close,
      low: Math.min(...days.map((d) => Math.min(d.open, d.close))),
      high: Math.max(...days.map((d) => Math.max(d.open, d.close))),
      trades: days.reduce((s, d) => s + d.trades, 0),
      skipped: days.reduce((s, d) => s + d.skipped, 0),
      charges: days.reduce((s, d) => s + d.charges, 0),
    }));
  }, [ledger.days]);

  const change = ledger.final - ledger.capital;

  return (
    <section className="rounded-[7px] border border-line bg-surface">
      <div className="flex flex-wrap items-baseline gap-2 border-b border-line px-4 py-2.5">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.13em] text-muted">Capital ledger</h3>
        <span className="text-[10.5px] text-faint">
          Whole run, after charges. A trade was taken only if its premium fitted in the balance left
          after open trades; 1 lot always. The filters above do not apply here.
        </span>
      </div>

      <div className="grid gap-2 px-4 py-3 sm:grid-cols-3 xl:grid-cols-7">
        <Stat label="Started with" value={rupees(ledger.capital)} />
        <Stat label="Ended with" value={rupees(ledger.final)} hint={signed(change)} tone={change} />
        <Stat label="Highest" value={rupees(ledger.peak)} />
        <Stat label="Lowest" value={rupees(ledger.low)} tone={ledger.low - ledger.capital} />
        <Stat
          label="Deepest fall"
          value={signed(ledger.maxDrawdown)}
          hint={`${ledger.maxDrawdownPct.toFixed(1)}% from a high`}
          tone={ledger.maxDrawdown}
        />
        <Stat label="Longest below a high" value={`${ledger.longestUnderwaterDays} days`} />
        <Stat label="Skipped, no capital" value={String(ledger.skipped)} hint="signals that did not fit" />
      </div>

      <BalanceChart days={ledger.days} capital={ledger.capital} />

      <div className="overflow-x-auto border-t border-line">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-muted">
              <th className="px-3 py-1 font-bold">Month</th>
              <th className="px-3 py-1 text-right font-bold">Start</th>
              <th className="px-3 py-1 text-right font-bold">Lowest</th>
              <th className="px-3 py-1 text-right font-bold">Highest</th>
              <th className="px-3 py-1 text-right font-bold">End</th>
              <th className="px-3 py-1 text-right font-bold">Change</th>
              <th className="px-3 py-1 text-right font-bold">Trades</th>
              <th className="px-3 py-1 text-right font-bold">Skipped</th>
              <th className="px-3 py-1" />
            </tr>
          </thead>
          <tbody>
            {months.map((m) => (
              <Fragment key={m.month}>
                <tr
                  className="cursor-pointer border-t border-line hover:bg-surface2"
                  onClick={() => setOpenMonth((v) => (v === m.month ? null : m.month))}
                >
                  <td className="px-3 py-1.5 font-mono">{m.month}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{rupees(m.open)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-muted">{rupees(m.low)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-muted">{rupees(m.high)}</td>
                  <td className="px-3 py-1.5 text-right font-mono font-semibold">{rupees(m.close)}</td>
                  <td className={`px-3 py-1.5 text-right font-mono ${tone(m.close - m.open)}`}>{signed(m.close - m.open)}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{m.trades}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-muted">{m.skipped || "—"}</td>
                  <td className="px-3 py-1.5 text-[10.5px] text-faint">{openMonth === m.month ? "hide days" : "days"}</td>
                </tr>
                {openMonth === m.month
                  ? m.days.map((d) => (
                      <tr key={d.date} className="border-t border-line bg-sunken text-[11.5px]">
                        <td className="px-3 py-1 pl-6 font-mono text-muted">{d.date}</td>
                        <td className="px-3 py-1 text-right font-mono text-muted">{rupees(d.open)}</td>
                        <td className="px-3 py-1 text-right font-mono text-faint" colSpan={2}>
                          P&amp;L {signed(d.pnl)} · charges {rupees(d.charges)}
                        </td>
                        <td className="px-3 py-1 text-right font-mono">{rupees(d.close)}</td>
                        <td className={`px-3 py-1 text-right font-mono ${tone(d.close - d.open)}`}>{signed(d.close - d.open)}</td>
                        <td className="px-3 py-1 text-right font-mono">{d.trades}</td>
                        <td className="px-3 py-1 text-right font-mono text-muted">{d.skipped || "—"}</td>
                        <td />
                      </tr>
                    ))
                  : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The balance at each day's close, against the starting capital. */
function BalanceChart({ days, capital }: { days: LedgerDay[]; capital: number }) {
  if (days.length < 2) return null;
  const W = 900;
  const H = 140;
  const pad = 6;
  const values = [capital, ...days.map((d) => d.close)];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const x = (i: number) => pad + (i / (values.length - 1)) * (W - 2 * pad);
  const y = (v: number) => pad + (1 - (v - lo) / span) * (H - 2 * pad);
  const line = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <div className="px-4 pb-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[140px] w-full" preserveAspectRatio="none" role="img" aria-label="Balance by day">
        <line x1={pad} x2={W - pad} y1={y(capital)} y2={y(capital)} className="stroke-line" strokeDasharray="4 4" strokeWidth={1} />
        <polyline points={line} fill="none" className="stroke-accent" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between font-mono text-[10px] text-faint">
        <span>{days[0].date}</span>
        <span>dashed: started with {rupees(capital)} · range {rupees(lo)} – {rupees(hi)}</span>
        <span>{days[days.length - 1].date}</span>
      </div>
    </div>
  );
}

function Stat({ label, value, hint, tone: t }: { label: string; value: string; hint?: string; tone?: number }) {
  return (
    <div className="rounded-[5px] border border-line bg-sunken px-3 py-2">
      <div className="text-[9.5px] font-bold uppercase tracking-[0.1em] text-muted">{label}</div>
      <div className={`font-mono text-[14px] font-semibold ${t === undefined ? "text-ink" : tone(t)}`}>{value}</div>
      {hint ? <div className="text-[10px] text-faint">{hint}</div> : null}
    </div>
  );
}

function rupees(v: number): string {
  return `₹${Math.round(v).toLocaleString("en-IN")}`;
}

function signed(v: number): string {
  const r = Math.round(v);
  return `${r < 0 ? "−" : r > 0 ? "+" : ""}₹${Math.abs(r).toLocaleString("en-IN")}`;
}

function tone(v: number): string {
  return v > 0 ? "text-pos" : v < 0 ? "text-neg" : "text-muted";
}
