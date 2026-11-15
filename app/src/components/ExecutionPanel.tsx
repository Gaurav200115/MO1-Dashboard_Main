"use client";

import { useCallback, useEffect, useState } from "react";
import { fmtPrice } from "@/lib/format";
import { istClock } from "@/lib/strategy/ist";
import type { DeskStatus } from "@/lib/execution/desk";
import type { LivePosition } from "@/lib/execution/types";

/**
 * Live orders: the switch, the kill switch, and every real order today.
 *
 * Paper always runs; this panel is only about the real orders that follow it.
 * Polls every 10 seconds - live positions are protected by their exchange
 * stops, not by this screen, so it does not need to be faster.
 */

const POLL_MS = 10_000;

export default function ExecutionPanel() {
  const [status, setStatus] = useState<DeskStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/execution", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setStatus((await response.json()) as DeskStatus);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load live status");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const post = async (body: Record<string, string>) => {
    setWorking(true);
    try {
      const response = await fetch("/api/execution", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { error?: string; status?: DeskStatus };
      if (!response.ok) setError(payload.error ?? `HTTP ${response.status}`);
      else {
        setError(null);
        if (payload.status) setStatus(payload.status);
      }
    } finally {
      setWorking(false);
    }
  };

  const turnOn = () => {
    const typed = window.prompt(
      "Real orders will be sent to Zerodha with real money.\n\nType LIVE to switch live orders on."
    );
    if (typed === null) return;
    void post({ action: "mode", mode: "live", confirm: typed.trim() });
  };

  const turnOff = () => void post({ action: "mode", mode: "paper" });

  const kill = () => {
    if (!window.confirm("KILL SWITCH: switch live orders off and exit every live position now?")) return;
    void post({ action: "kill" });
  };

  if (!status) {
    return error ? (
      <p className="mb-4 rounded-md border border-line bg-surface px-4 py-2.5 text-[11.5px] text-muted">
        Live orders: {error}
      </p>
    ) : null;
  }

  const on = status.mode === "live" && status.allowed && !status.halted;
  const sent = status.positions.filter((p) => p.entry.status !== "not-placed" || p.entry.orderId);

  return (
    <section
      aria-label="Live orders"
      className={`mb-4 rounded-md border px-4 py-2.5 ${on ? "border-neg/60 bg-surface" : "border-line bg-surface"}`}
    >
      <div className="flex flex-wrap items-center gap-3 text-[11.5px]">
        <span
          className={`h-[7px] w-[7px] shrink-0 rounded-full ${on ? "bg-neg" : status.halted ? "bg-alert" : "bg-faint"}`}
          aria-hidden
        />
        <span className="font-semibold">
          {on ? "LIVE ORDERS ON" : status.halted ? "Live orders halted" : "Live orders off"}
        </span>
        <span className="text-[10px] uppercase tracking-[0.1em] text-muted">
          {on ? `max ${status.maxOpen} open · LIMIT IOC at the ask · MIS` : "paper only"}
        </span>
        {status.halted ? <span className="text-alert">{status.halted}</span> : null}
        {!status.allowed ? (
          <span className="text-muted">LIVE_ALLOWED is not set on the server - the switch stays off.</span>
        ) : null}

        <span className="ml-auto flex items-center gap-2">
          {status.mode === "live" ? (
            <button
              type="button"
              disabled={working}
              onClick={turnOff}
              className="rounded-md border border-line px-2.5 py-1 text-[11px]"
            >
              Switch off
            </button>
          ) : (
            <button
              type="button"
              disabled={working || !status.allowed}
              onClick={turnOn}
              className="rounded-md border border-line px-2.5 py-1 text-[11px] disabled:opacity-40"
            >
              Switch live orders on
            </button>
          )}
          <button
            type="button"
            disabled={working}
            onClick={kill}
            className="rounded-md border border-neg/60 px-2.5 py-1 text-[11px] font-semibold text-neg"
          >
            Kill switch
          </button>
        </span>
      </div>

      {error ? <p className="mt-1.5 text-[11px] text-neg">{error}</p> : null}

      {sent.length > 0 ? (
        <table className="mt-2 w-full text-[11px]">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-muted">
              <th className="py-1 pr-3 font-normal">Time</th>
              <th className="py-1 pr-3 font-normal">Contract</th>
              <th className="py-1 pr-3 font-normal">Entry</th>
              <th className="py-1 pr-3 font-normal">Stop</th>
              <th className="py-1 pr-3 font-normal">Exit</th>
              <th className="py-1 font-normal">P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {sent.map((p) => (
              <Row key={p.tradeId} p={p} />
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mt-1 text-[11px] text-muted">No live orders today.</p>
      )}
    </section>
  );
}

function Row({ p }: { p: LivePosition }) {
  const entry =
    p.entry.status === "filled"
      ? `filled ${p.entry.filledQty} @ ${fmtPrice(p.entry.fillPrice ?? 0)}`
      : `${p.entry.status}${p.entry.reason ? ` — ${p.entry.reason}` : ""}`;
  const stop = p.stop ? `${p.stop.status} · ${fmtPrice(p.stop.trigger)} / ${fmtPrice(p.stop.limit)}` : "—";
  const exit = p.exit
    ? p.exit.fillPrice != null
      ? `@ ${fmtPrice(p.exit.fillPrice)} (${p.exit.reason})`
      : `${p.exit.reason}, try ${p.exit.attempts}`
    : "—";
  return (
    <tr className="border-t border-line align-top">
      <td className="py-1 pr-3 font-mono">{istClock(p.entry.sentAt)}</td>
      <td className="py-1 pr-3 font-mono">
        {p.tradingsymbol} ×{p.qty}
      </td>
      <td className={`py-1 pr-3 ${p.entry.status === "rejected" ? "text-neg" : ""}`}>{entry}</td>
      <td className="py-1 pr-3">{stop}</td>
      <td className="py-1 pr-3">{exit}</td>
      <td className={`py-1 font-mono ${(p.profit ?? 0) < 0 ? "text-neg" : (p.profit ?? 0) > 0 ? "text-pos" : ""}`}>
        {p.profit == null ? "—" : `₹${Math.round(p.profit)}`}
      </td>
    </tr>
  );
}
