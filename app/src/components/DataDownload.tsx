"use client";

import { useEffect, useState } from "react";

/**
 * Progress of the overnight market-data download. The download runs on the VPS from 16:00 to
 * 06:00 IST and writes a snapshot every minute; this panel polls it through /api/marketdata.
 */

interface DatasetProgress {
  key: string;
  label: string;
  done: number;
  total: number;
}

interface Progress {
  updatedAt: string;
  state: "starting" | "running" | "paused" | "waiting" | "complete" | "stopped";
  message: string;
  profile: string;
  currentJob: string | null;
  range: { from: string | null; to: string | null; tradingDays: number };
  window: { from: string; to: string; hours?: number; endsAt: string | null; nextStart: string };
  stocks?: number;
  fnoStocks?: number;
  strikeBand?: number | null;
  overall: { done: number; total: number };
  datasets: DatasetProgress[];
  eta: { secondsPerPiece: number; hoursLeft: number; nightsLeft: number } | null;
  failedPieces?: number;
  failed?: { retrying: number; gaveUp: number; maxAttempts: number; items: FailedPiece[] };
  optionStocks?: { perMonth: number; thisMonth: number | null; acrossRange: number; minAtmOiLots: number };
  dhanCallsToday?: number | null;
}

interface FailedPiece {
  dataset: string;
  symbol: string;
  series: string;
  day: string;
  attempts: number;
  reason: string | null;
  status: "retrying" | "gave up";
  lastTry: string;
}

type Reply = { available: true; progress: Progress } | { available: false; reason: string };

const POLL_MS = 30_000;
/** The download writes every minute while it runs; silence longer than this means it stopped. */
const STALE_MS = 5 * 60_000;

const STATE_LABEL: Record<Progress["state"], string> = {
  starting: "Starting",
  running: "Running",
  paused: "Paused for the day",
  waiting: "Waiting for 16:00",
  complete: "Complete",
  stopped: "Stopped",
};

export default function DataDownload() {
  const [reply, setReply] = useState<Reply | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch("/api/marketdata", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as Reply;
        if (alive) {
          setReply(body);
          setError(null);
        }
      } catch (err) {
        if (alive) setError((err as Error).message);
      }
    }
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <section className="overflow-hidden rounded-md border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <h2 className="font-display text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
          Data download
        </h2>
        {reply?.available ? <StateChip progress={reply.progress} /> : null}
        <p className="ml-auto max-w-[52ch] text-[10.5px] leading-snug text-faint">
          NIFTY 200 options, futures and spot from Dhan, end-of-day files from NSE, into PostgreSQL on
          the VPS. Runs 16:00–06:00 IST and carries on each evening.
        </p>
      </div>

      {error ? (
        <p className="px-4 py-4 text-[12px] text-neg">Could not load progress: {error}</p>
      ) : !reply ? (
        <p className="px-4 py-4 text-[12px] text-muted">Loading…</p>
      ) : !reply.available ? (
        <p className="px-4 py-4 text-[12px] text-muted">{reply.reason}</p>
      ) : (
        <Body progress={reply.progress} />
      )}
    </section>
  );
}

function StateChip({ progress }: { progress: Progress }) {
  const stale = isStale(progress);
  const tone =
    progress.state === "stopped" || stale
      ? "border-neg text-neg"
      : progress.state === "complete"
        ? "border-pos text-pos"
        : progress.state === "running" || progress.state === "starting"
          ? "border-accent text-accent"
          : "border-linestrong text-muted";
  return (
    <span className={`rounded-[3px] border px-1.5 py-px text-[10px] uppercase tracking-[0.1em] ${tone}`}>
      {stale ? "No update" : STATE_LABEL[progress.state] ?? progress.state}
    </span>
  );
}

function isStale(p: Progress): boolean {
  if (p.state !== "running" && p.state !== "starting") return false;
  return Date.now() - new Date(p.updatedAt).getTime() > STALE_MS;
}

function Body({ progress: p }: { progress: Progress }) {
  const stale = isStale(p);
  return (
    <div className="flex flex-col gap-5 px-4 py-4">
      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <span className="text-[12.5px] font-semibold text-ink">Overall</span>
          <span className="font-mono text-[12px] text-ink2">
            {pct(p.overall.done, p.overall.total)} · {fmt(p.overall.done)} of {fmt(p.overall.total)} pieces
          </span>
        </div>
        <Bar done={p.overall.done} total={p.overall.total} state={p.state} tall />
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[11.5px] sm:grid-cols-4">
        <Fact
          label="Date range"
          value={p.range.from ? `${p.range.from} → ${p.range.to}` : "—"}
          sub={p.range.tradingDays ? `${p.range.tradingDays} trading days` : undefined}
        />
        <Fact
          label="Stocks"
          value={p.stocks != null ? `${p.stocks}` : "—"}
          sub={p.fnoStocks != null ? `${p.fnoStocks} with F&O · spot for all` : undefined}
        />
        <Fact
          label="Option stocks"
          value={p.optionStocks?.thisMonth != null ? `${p.optionStocks.thisMonth} this month` : "—"}
          sub={
            p.optionStocks
              ? `top ${p.optionStocks.perMonth} by option turnover, re-chosen monthly · ${p.optionStocks.acrossRange} over the range`
              : undefined
          }
        />
        <Fact
          label="Option strikes"
          value={p.strikeBand ? `ATM ±${p.strikeBand}` : "—"}
          sub="calls and puts, monthly expiry"
        />
        <Fact
          label="Time left"
          value={p.eta ? `≈ ${p.eta.nightsLeft} nights` : p.state === "complete" ? "Done" : "—"}
          sub={p.eta ? `${p.eta.hoursLeft} h of downloading` : undefined}
        />
        <Fact
          label="Schedule"
          value={`${p.window.from}–${p.window.to} IST`}
          sub={
            p.window.endsAt && (p.state === "running" || p.state === "starting")
              ? `stops at ${clock(p.window.endsAt)}`
              : `next start ${dayClock(p.window.nextStart)}`
          }
        />
        <Fact label="Now" value={p.currentJob ? jobLabel(p) : "—"} sub={`updated ${dayClock(p.updatedAt)}`} />
        <Fact
          label="Failed pieces"
          value={p.failed ? `${p.failed.retrying} retrying · ${p.failed.gaveUp} gave up` : `${p.failedPieces ?? 0}`}
          sub={p.failed ? `retried each night, up to ${p.failed.maxAttempts} tries` : undefined}
        />
        <Fact label="Dhan calls today" value={p.dhanCallsToday != null ? fmt(p.dhanCallsToday) : "—"} sub="limit 100,000" />
      </dl>

      {stale ? (
        <p className="rounded-md border border-neg px-3 py-2 text-[11.5px] text-neg">
          No progress update for {Math.round((Date.now() - new Date(p.updatedAt).getTime()) / 60_000)} minutes
          while it should be running. On the VPS: <code className="font-mono">journalctl -u marketdata-backfill -n 50</code>
        </p>
      ) : p.message ? (
        <p className={`text-[11.5px] ${p.state === "stopped" ? "text-neg" : "text-muted"}`}>{p.message}</p>
      ) : null}

      <div className="flex flex-col gap-3">
        {p.datasets.map((d) => (
          <div key={d.key}>
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <span className="text-[12px] text-ink2">{d.label}</span>
              <span className="font-mono text-[11px] text-muted">
                {pct(d.done, d.total)} · {fmt(d.done)} / {fmt(d.total)}
              </span>
            </div>
            <Bar done={d.done} total={d.total} state={p.state} />
          </div>
        ))}
      </div>

      {p.failed && p.failed.items.length > 0 ? <FailedTable failed={p.failed} /> : null}
    </div>
  );
}

const DATASET_LABEL: Record<string, string> = {
  fo_bhavcopy: "NSE F&O bhavcopy",
  cm_bhavcopy: "NSE cash bhavcopy",
  corporate_actions: "Corporate actions",
  fo_ban: "F&O ban list",
  spot_1min: "Spot 1-min",
  futures_1min: "Futures 1-min",
  options_1min: "Options 1-min",
};

/** "MONTH1:ATM-2:PUT" -> "ATM-2 PE"; "1m" -> ""; "" (an NSE file) -> "". */
function seriesLabel(series: string): string {
  const parts = series.split(":");
  if (parts.length === 3) return `${parts[1]} ${parts[2] === "CALL" ? "CE" : "PE"}`;
  return "";
}

function FailedTable({ failed }: { failed: NonNullable<Progress["failed"]> }) {
  const total = failed.retrying + failed.gaveUp;
  return (
    <div>
      <h3 className="mb-1.5 font-display text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
        Failed pieces{total > failed.items.length ? ` — showing ${failed.items.length} of ${total}` : ""}
      </h3>
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full border-collapse text-[11.5px]">
          <thead>
            <tr className="border-b border-line text-left text-[10px] uppercase tracking-[0.08em] text-muted">
              <th className="px-3 py-1.5 font-semibold">Data</th>
              <th className="px-3 py-1.5 font-semibold">Stock</th>
              <th className="px-3 py-1.5 font-semibold">Strike</th>
              <th className="px-3 py-1.5 font-semibold">Day</th>
              <th className="px-3 py-1.5 text-right font-semibold">Tries</th>
              <th className="px-3 py-1.5 font-semibold">Status</th>
              <th className="px-3 py-1.5 font-semibold">Last reason</th>
            </tr>
          </thead>
          <tbody>
            {failed.items.map((f) => (
              <tr key={`${f.dataset}|${f.symbol}|${f.series}|${f.day}`} className="border-b border-line last:border-0">
                <td className="px-3 py-1.5 text-ink2">{DATASET_LABEL[f.dataset] ?? f.dataset}</td>
                <td className="px-3 py-1.5 font-mono text-ink">{f.symbol === "*" ? "—" : f.symbol}</td>
                <td className="px-3 py-1.5 font-mono text-ink2">{seriesLabel(f.series) || "—"}</td>
                <td className="px-3 py-1.5 font-mono text-ink2">{f.day}</td>
                <td className="px-3 py-1.5 text-right font-mono text-ink2">
                  {f.attempts}/{failed.maxAttempts}
                </td>
                <td className={`px-3 py-1.5 ${f.status === "gave up" ? "text-neg" : "text-muted"}`}>{f.status}</td>
                <td className="px-3 py-1.5 text-faint">{f.reason ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Bar({ done, total, state, tall }: { done: number; total: number; state: Progress["state"]; tall?: boolean }) {
  const share = total > 0 ? Math.min(1, done / total) : 0;
  const fill = share >= 1 ? "bg-pos" : state === "stopped" ? "bg-neg" : "bg-accent";
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      className={`w-full overflow-hidden rounded-full bg-sunken ${tall ? "h-3" : "h-1.5"}`}
    >
      <div className={`h-full rounded-full ${fill} transition-[width] duration-700`} style={{ width: `${share * 100}%` }} />
    </div>
  );
}

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.08em] text-muted">{label}</dt>
      <dd className="font-mono text-[12px] text-ink">{value}</dd>
      {sub ? <dd className="text-[10.5px] text-faint">{sub}</dd> : null}
    </div>
  );
}

const JOB_LABEL: Record<string, string> = {
  stock_list: "Stock list",
  fo_bhavcopy: "NSE F&O bhavcopy",
  cm_bhavcopy: "NSE cash bhavcopy",
  corporate_actions: "Corporate actions",
  fo_ban: "F&O ban list",
  spot_1min: "Spot 1-minute",
  futures_1min: "Futures 1-minute",
  options_1min: "Options 1-minute",
  compressing: "Compressing",
  report: "Writing the report",
};

function jobLabel(p: Progress): string {
  return (p.currentJob && JOB_LABEL[p.currentJob]) || p.currentJob || "—";
}

function pct(done: number, total: number): string {
  if (total <= 0) return "0%";
  if (done >= total) return "100%";
  const v = (done / total) * 100;               // rounded down: never shows 100% while work is left
  return `${v >= 10 || v === 0 ? Math.floor(v) : Math.floor(v * 10) / 10}%`;
}

function fmt(n: number): string {
  return n.toLocaleString("en-IN");
}

/** ISO time with an offset -> "16:00" in IST. */
function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
}

function dayClock(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  });
}
