"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ArchiveCoverage, BacktestRun } from "@/lib/backtest/store";
import type { SetupOption } from "@/lib/backtest/setups";

/**
 * Asking for a backtest, watching it run, and finding one that was already run.
 *
 * Nothing is replayed here. Pressing Run writes a queued row; the worker on the
 * VPS — the only process with the archive in reach — picks it up within its
 * poll interval. So the button does not "start" anything it can report on
 * immediately, and the panel is honest about that: a run sits at "Queued" until
 * the worker takes it.
 *
 * A run's id comes from the strategies and the dates alone, so asking twice for
 * the same thing lands on the row that already exists. That is the whole point
 * of the screen — the second ask shows the first answer instead of spending
 * twenty minutes reproducing it.
 */

interface Reply {
  configured: boolean;
  runs?: BacktestRun[];
  coverage?: { coverage: ArchiveCoverage; updatedAt: string } | null;
  setups?: SetupOption[];
  error?: string;
}

/** While something is queued or running the worker is moving; look more often. */
const POLL_IDLE_MS = 30_000;
const POLL_BUSY_MS = 4_000;

const STATUS_TONE: Record<string, string> = {
  queued: "border-linestrong text-muted",
  running: "border-accent text-accent",
  done: "border-pos text-pos",
  failed: "border-neg text-neg",
};

export default function Backtest({ onOpenRun }: { onOpenRun?: (runId: string) => void }) {
  const [reply, setReply] = useState<Reply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/backtest", { cache: "no-store" });
      const body: Reply = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setReply(body);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const working = useMemo(
    () => (reply?.runs ?? []).some((r) => r.status === "queued" || r.status === "running"),
    [reply]
  );

  useEffect(() => {
    const id = setInterval(() => void load(), working ? POLL_BUSY_MS : POLL_IDLE_MS);
    return () => clearInterval(id);
  }, [load, working]);

  // Default to every leg, which is what the desk runs. One leg at a time is how
  // you find out which of them is carrying the result — but note the cap is
  // desk-wide, so a single leg on its own gets all three slots and had more
  // room than it really had.
  useEffect(() => {
    if (reply?.setups && picked.length === 0) {
      setPicked(reply.setups.map((s) => s.setup));
    }
  }, [reply, picked.length]);

  const coverage = reply?.coverage?.coverage ?? null;
  const options = coverage?.options ?? null;

  useEffect(() => {
    if (options && !from && !to) {
      setFrom(options.from);
      setTo(options.to);
    }
  }, [options, from, to]);

  const outOfRange =
    options && from && to && (from < options.from || to > options.to);

  async function submit() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/backtest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setups: picked, from, to }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setNote(
        body.created
          ? "Queued. The worker picks it up within half a minute."
          : body.run?.status === "done"
            ? "Already run — its result is below."
            : `Already ${body.run?.status}.`
      );
      await load();
    } catch (err) {
      setNote(`Could not queue it: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-[7px] border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="font-display text-[13px] font-bold tracking-[0.02em] text-ink">Backtest</h2>
        <p className="ml-auto max-w-[56ch] text-[10.5px] leading-snug text-faint">
          Replays the desk&rsquo;s own rules over the archived minute data on the VPS, priced on real
          option prices. Every run is kept, so asking the same question twice answers from the
          record instead of running again.
        </p>
      </div>

      {error ? (
        <p className="px-4 py-4 text-[12px] text-neg">Could not load runs: {error}</p>
      ) : !reply ? (
        <p className="px-4 py-4 text-[12px] text-muted">Loading…</p>
      ) : !reply.configured ? (
        <p className="px-4 py-4 text-[12px] text-muted">
          MongoDB is not configured, so there is nowhere to keep runs.
        </p>
      ) : (
        <div className="flex flex-col gap-5 px-4 py-4">
          <Ask
            setups={reply.setups ?? []}
            picked={picked}
            onPick={setPicked}
            from={from}
            to={to}
            onFrom={setFrom}
            onTo={setTo}
            coverage={coverage}
            outOfRange={!!outOfRange}
            busy={busy}
            note={note}
            onRun={submit}
          />
          <Runs runs={reply.runs ?? []} onOpenRun={onOpenRun} onChanged={load} />
        </div>
      )}
    </section>
  );
}

function Ask({
  setups,
  picked,
  onPick,
  from,
  to,
  onFrom,
  onTo,
  coverage,
  outOfRange,
  busy,
  note,
  onRun,
}: {
  setups: SetupOption[];
  picked: string[];
  onPick: (ids: string[]) => void;
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
  coverage: ArchiveCoverage | null;
  outOfRange: boolean;
  busy: boolean;
  note: string | null;
  onRun: () => void;
}) {
  const options = coverage?.options ?? null;
  const ready = picked.length > 0 && !!from && !!to && from <= to && !busy;

  return (
    <div className="rounded-[5px] border border-line bg-sunken p-3">
      <div className="mb-3 flex flex-wrap items-end gap-4">
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
            Setups
          </legend>
          {setups.map((s) => (
            <label
              key={s.setup}
              title={s.description}
              className="flex items-center gap-2 text-[12.5px] text-ink2"
            >
              <input
                type="checkbox"
                checked={picked.includes(s.setup)}
                onChange={(e) =>
                  onPick(
                    e.target.checked
                      ? [...picked, s.setup]
                      : picked.filter((id) => id !== s.setup)
                  )
                }
              />
              <span className="font-mono font-semibold">{s.setup}</span>
              {s.label}
              <span
                className={`rounded-[3px] border px-1 py-px font-mono text-[9.5px] uppercase ${
                  s.side === "LONG" ? "border-pos text-pos" : "border-neg text-neg"
                }`}
              >
                {s.side === "LONG" ? "long · CE" : "short · PE"}
              </span>
              <span className="font-mono text-[11px] text-faint">v{s.version}</span>
            </label>
          ))}
        </fieldset>

        <label className="flex flex-col gap-1 text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
          From
          <input
            type="date"
            value={from}
            min={options?.from}
            max={options?.to}
            onChange={(e) => onFrom(e.target.value)}
            className="rounded-[4px] border border-line bg-surface px-2 py-1 font-mono text-[12px] font-normal normal-case tracking-normal text-ink"
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
          To
          <input
            type="date"
            value={to}
            min={options?.from}
            max={options?.to}
            onChange={(e) => onTo(e.target.value)}
            className="rounded-[4px] border border-line bg-surface px-2 py-1 font-mono text-[12px] font-normal normal-case tracking-normal text-ink"
          />
        </label>

        <button
          type="button"
          disabled={!ready}
          onClick={onRun}
          className={`rounded-[4px] border px-3 py-1.5 text-[12.5px] font-semibold ${
            ready
              ? "border-accent bg-accentsoft text-accent hover:bg-accent hover:text-accentink"
              : "cursor-not-allowed border-line text-faint"
          }`}
        >
          {busy ? "Queueing…" : "Run"}
        </button>
      </div>

      <Coverage coverage={coverage} outOfRange={outOfRange} />
      {picked.length === 1 ? (
        <p className="mt-2 text-[11.5px] text-muted">
          One leg on its own gets all three position slots. Run together, the legs compete for
          them and a stock already traded by one cannot be taken by another the same day — so the
          separate runs will not add up to the combined one.
        </p>
      ) : null}
      {note ? <p className="mt-2 text-[12px] text-ink2">{note}</p> : null}
    </div>
  );
}

/**
 * What the archive actually holds.
 *
 * Options are the binding constraint and the one worth saying out loud: spot
 * and the NSE files cover all ~200 stocks, options only the ~100 most liquid,
 * re-chosen every month. A range outside this comes back empty, and without
 * this line there is nothing on screen to explain why.
 */
function Coverage({
  coverage,
  outOfRange,
}: {
  coverage: ArchiveCoverage | null;
  outOfRange: boolean;
}) {
  if (!coverage) {
    return (
      <p className="text-[11.5px] text-muted">
        The worker has not reported what the archive holds yet. It publishes this when it starts,
        so this line fills in once <code className="font-mono text-[11px]">backtest-worker</code> is
        running on the VPS.
      </p>
    );
  }

  const o = coverage.options;
  if (!o) {
    return (
      <p className="text-[11.5px] text-neg">
        The archive holds no option minute data at all, so nothing can be backtested yet.
      </p>
    );
  }

  const months = coverage.months.slice(-6);
  return (
    <div className="flex flex-col gap-1">
      <p className={`text-[11.5px] ${outOfRange ? "text-neg" : "text-muted"}`}>
        Options cover <strong className="font-semibold text-ink2">{o.stocks}</strong> stocks from{" "}
        <span className="font-mono">{o.from}</span> to <span className="font-mono">{o.to}</span>
        {coverage.spot ? (
          <>
            {" "}
            · spot covers {coverage.spot.symbols} symbols from{" "}
            <span className="font-mono">{coverage.spot.from}</span>
          </>
        ) : null}
        {outOfRange ? " — the dates picked fall outside this." : ""}
      </p>
      {months.length > 0 ? (
        <p className="font-mono text-[10.5px] text-faint">
          {months
            .map((m) => `${m.month.slice(0, 7)} ${m.stocks} stocks / ${fmt(m.stockDays)} days`)
            .join("   ·   ")}
        </p>
      ) : null}
    </div>
  );
}

function Runs({
  runs,
  onOpenRun,
  onChanged,
}: {
  runs: BacktestRun[];
  onOpenRun?: (runId: string) => void;
  onChanged: () => void;
}) {
  if (runs.length === 0) {
    return <p className="text-[12px] text-muted">No runs yet.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[10px] font-bold uppercase tracking-[0.13em] text-muted">Past runs</h3>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-linestrong text-left text-[10px] uppercase tracking-[0.1em] text-muted">
              <th className="py-1 pr-3 font-bold">Range</th>
              <th className="py-1 pr-3 font-bold">Setups</th>
              <th className="py-1 pr-3 font-bold">State</th>
              <th className="py-1 pr-3 text-right font-bold">Trades</th>
              <th className="py-1 pr-3 text-right font-bold">Net</th>
              <th className="py-1 pr-3 text-right font-bold">Win</th>
              <th className="py-1 pr-3 text-right font-bold">PF</th>
              <th className="py-1 pr-3 text-right font-bold">Max DD</th>
              <th className="py-1 pr-3 font-bold">Gate</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <RunRow key={run._id} run={run} onOpenRun={onOpenRun} onChanged={onChanged} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RunRow({
  run,
  onOpenRun,
  onChanged,
}: {
  run: BacktestRun;
  onOpenRun?: (runId: string) => void;
  onChanged: () => void;
}) {
  const s = run.summary;
  const gate = run.gateCounts ?? {};
  const approx = gate.approx ?? 0;
  const [openDetail, setOpenDetail] = useState(false);

  async function remove() {
    if (!window.confirm(`Delete this run (${run.from} to ${run.to}) and its trades?`)) return;
    await fetch(`/api/backtest?run=${encodeURIComponent(run._id)}`, { method: "DELETE" });
    onChanged();
  }

  return (
    <>
    <tr className="border-b border-line align-top">
      <td className="py-1.5 pr-3 font-mono text-[11.5px] text-ink2">
        {run.from} → {run.to}
      </td>
      <td className="py-1.5 pr-3 font-mono text-[11.5px] text-ink2">
        {(run.setups ?? []).join(" ") || run.strategyIds.map(short).join(", ")}
      </td>
      <td className="py-1.5 pr-3">
        <span
          className={`rounded-[3px] border px-1.5 py-px text-[10px] uppercase tracking-[0.1em] ${
            STATUS_TONE[run.status] ?? "border-line text-muted"
          }`}
        >
          {run.status}
        </span>
        {run.status === "running" && run.progress?.total ? (
          <span className="ml-2 font-mono text-[10.5px] text-faint">
            {run.progress.done}/{run.progress.total} · {run.progress.day}
          </span>
        ) : null}
        {run.status === "failed" && run.error ? (
          <span className="ml-2 text-[10.5px] text-neg">{run.error.slice(0, 80)}</span>
        ) : null}
      </td>
      <td className="py-1.5 pr-3 text-right font-mono">{s ? fmt(s.trades) : "—"}</td>
      <td
        className={`py-1.5 pr-3 text-right font-mono ${
          s ? (s.net > 0 ? "text-pos" : s.net < 0 ? "text-neg" : "text-muted") : "text-muted"
        }`}
      >
        {s ? money(s.net) : "—"}
      </td>
      <td className="py-1.5 pr-3 text-right font-mono">
        {s?.winRate != null ? `${Math.round(s.winRate * 100)}%` : "—"}
      </td>
      <td className="py-1.5 pr-3 text-right font-mono">
        {s?.profitFactor != null ? s.profitFactor.toFixed(2) : "—"}
      </td>
      <td className="py-1.5 pr-3 text-right font-mono text-neg">
        {s ? money(s.maxDrawdown) : "—"}
      </td>
      <td className="py-1.5 pr-3 font-mono text-[10.5px] text-faint">
        {run.status === "done" ? (
          <span title="Trades the live book gate would almost certainly have allowed / that rested on the liquidity approximation / signals refused">
            {gate.clear ?? 0}c {approx}a {gate.rejected ?? 0}r
          </span>
        ) : (
          "—"
        )}
      </td>
      <td className="py-1.5 text-right">
        {run.status === "done" && run.bySetup && Object.keys(run.bySetup).length > 1 ? (
          <button
            type="button"
            onClick={() => setOpenDetail((v) => !v)}
            title="Each leg's own figures"
            className="mr-1 rounded-[4px] border border-line px-2 py-0.5 text-[11.5px] text-ink2 hover:bg-surface2"
          >
            {openDetail ? "Hide legs" : "Legs"}
          </button>
        ) : null}
        {run.status === "done" && onOpenRun ? (
          <button
            type="button"
            onClick={() => onOpenRun(run._id)}
            className="rounded-[4px] border border-line px-2 py-0.5 text-[11.5px] text-ink2 hover:bg-surface2"
          >
            Open
          </button>
        ) : null}
        <button
          type="button"
          onClick={remove}
          title="Delete this run and its trades"
          className="ml-1 rounded-[4px] border border-line px-2 py-0.5 text-[11.5px] text-muted hover:border-neg hover:text-neg"
        >
          ×
        </button>
      </td>
    </tr>
    {openDetail && run.bySetup ? (
      <tr className="border-b border-line bg-sunken">
        <td colSpan={10} className="px-3 py-2">
          <table className="w-full border-collapse text-[11.5px]">
            <tbody>
              {Object.entries(run.bySetup).map(([setup, st]) => (
                <tr key={setup}>
                  <td className="py-0.5 pr-3 font-mono font-semibold">{setup}</td>
                  <td className="py-0.5 pr-3 text-muted">{st.signals} signals</td>
                  <td className="py-0.5 pr-3 font-mono">{fmt(st.trades)} trades</td>
                  <td
                    className={`py-0.5 pr-3 font-mono ${
                      st.net > 0 ? "text-pos" : st.net < 0 ? "text-neg" : "text-muted"
                    }`}
                  >
                    {money(st.net)}
                  </td>
                  <td className="py-0.5 pr-3 font-mono">
                    {st.winRate != null ? `${Math.round(st.winRate * 100)}% win` : "—"}
                  </td>
                  <td className="py-0.5 pr-3 font-mono">
                    PF {st.profitFactor != null ? st.profitFactor.toFixed(2) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-[10.5px] text-faint">
            These are the legs as they ran <em>together</em>, competing for the same three slots.
            A leg replayed on its own will not match its row here.
          </p>
        </td>
      </tr>
    ) : null}
    </>
  );
}

function short(id: string): string {
  return id.replace("-retrace-21ema", "");
}

function fmt(n: number): string {
  return n.toLocaleString("en-IN");
}

function money(n: number): string {
  return `${n < 0 ? "−" : "+"}₹${Math.abs(Math.round(n)).toLocaleString("en-IN")}`;
}
