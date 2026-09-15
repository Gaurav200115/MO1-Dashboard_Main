"use client";

import { useMemo, useState } from "react";
import { Calendar, ChevronDown, ChevronRight } from "lucide-react";
import { DASH, fmtPrice, grouped } from "@/lib/format";
import { istClock } from "@/lib/strategy/ist";
import type {
  EngineSnapshot,
  StrategyDefinition,
  StrategyTrade,
} from "@/lib/strategy/types";
import type { TradesResult } from "@/lib/useTrades";

/**
 * The blotter: every paper trade the strategy engine took, by day.
 *
 * Each row names the strategy and the leg of it that fired, because a season of
 * results from three rules mixed into one list answers nothing. The four figures
 * that matter — in, out, profit, and the two times — lead; the reasoning behind
 * a trade is one click away rather than crowding the line.
 */
export default function TradeBlotter({ data }: { data: TradesResult }) {
  const { trades, days, strategies, engines, date, loading, error, configured, select } = data;
  const [expanded, setExpanded] = useState<string | null>(null);

  const dates = useMemo(() => {
    const seen = new Set<string>(days.map((day) => day.tradingDate));
    seen.add(date);
    return [...seen].sort((a, b) => b.localeCompare(a));
  }, [days, date]);

  const totals = useMemo(() => {
    let realised = 0;
    let running = 0;
    let wins = 0;
    let losses = 0;
    let open = 0;
    for (const trade of trades) {
      if (trade.status === "open") {
        open += 1;
        running += trade.mtm?.profit ?? 0;
      } else if (trade.profit != null) {
        realised += trade.profit;
        if (trade.profit > 0) wins += 1;
        else if (trade.profit < 0) losses += 1;
      }
    }
    return { realised, running, wins, losses, open };
  }, [trades]);

  if (!configured) {
    return (
      <Shell>
        <p className="text-[12.5px] text-muted">
          Trades cannot be recorded —{" "}
          <code className="font-mono text-[11.5px]">MONGO_CONNECTION_STRING</code> is not set in{" "}
          <code className="font-mono text-[11.5px]">.env.local</code>.
        </p>
      </Shell>
    );
  }

  return (
    <>
      <EngineStrip engines={engines} strategies={strategies} />

      <section
        aria-label="Strategy trades"
        className="mb-5 overflow-hidden rounded-md border border-line bg-surface"
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <h2 className="font-display text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
            Trades
          </h2>

          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            <Calendar size={12} aria-hidden />
            <span className="sr-only">Trading day</span>
            <select
              value={date}
              onChange={(event) => select(event.target.value)}
              className="rounded-md border border-line bg-sunken px-2 py-1 font-mono text-[11.5px] text-ink"
            >
              {dates.map((day) => (
                <option key={day} value={day}>
                  {day}
                </option>
              ))}
            </select>
          </label>

          {trades.length > 0 ? (
            <>
              <span className="rounded-[3px] border border-linestrong px-1.5 py-px text-[10px] uppercase tracking-[0.1em] text-muted">
                {trades.length} taken · {totals.wins}W / {totals.losses}L
                {totals.open > 0 ? ` · ${totals.open} open` : ""}
              </span>
              <Rupees label="Realised" value={totals.realised} />
              {totals.open > 0 ? <Rupees label="Running" value={totals.running} muted /> : null}
            </>
          ) : null}

          <p className="ml-auto max-w-[42ch] text-[10.5px] leading-snug text-faint">
            Paper fills, priced off the live book at the moment the rule fired. This desk places
            no orders.
          </p>
        </div>

        {loading && trades.length === 0 ? (
          <p className="px-4 py-4 text-[12px] text-muted">Loading…</p>
        ) : error ? (
          <p className="px-4 py-4 text-[12px] text-neg">{error}</p>
        ) : trades.length === 0 ? (
          <p className="px-4 py-4 text-[12px] text-muted">
            No trades on {date}. The engine records one the moment a setup fires.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-line text-[10px] uppercase tracking-[0.08em] text-muted">
                  <Th className="text-left">In</Th>
                  <Th className="text-left">Stock</Th>
                  <Th className="text-left">Strategy</Th>
                  <Th className="text-left">Contract</Th>
                  <Th>Buy</Th>
                  <Th>Sell</Th>
                  <Th>Out</Th>
                  <Th>Stop</Th>
                  <Th>Target</Th>
                  <Th>P&amp;L</Th>
                </tr>
              </thead>
              <tbody>
                {trades.map((trade) => (
                  <TradeRow
                    key={trade._id}
                    trade={trade}
                    expanded={expanded === trade._id}
                    onToggle={() =>
                      setExpanded((current) => (current === trade._id ? null : trade._id))
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function TradeRow({
  trade,
  expanded,
  onToggle,
}: {
  trade: StrategyTrade;
  expanded: boolean;
  onToggle: () => void;
}) {
  const open = trade.status === "open";
  const profit = open ? (trade.mtm?.profit ?? null) : trade.profit;
  const mark = open ? trade.mtm?.price ?? null : trade.sell?.price ?? null;

  return (
    <>
      <tr className="border-t border-line hover:bg-surface2">
        <Td className="text-left">{istClock(trade.buy.at)}</Td>

        <td className="px-3 py-1.5 text-left align-top">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="flex items-center gap-1 text-left"
          >
            {expanded ? (
              <ChevronDown size={11} className="text-faint" aria-hidden />
            ) : (
              <ChevronRight size={11} className="text-faint" aria-hidden />
            )}
            <span className="font-mono text-[12px] font-semibold">{trade.symbol}</span>
          </button>
        </td>

        <td className="px-3 py-1.5 text-left align-top">
          <span className="text-[11.5px]">{trade.strategyName}</span>
          <span className="block text-[10px] text-faint">
            v{trade.strategyVersion} · {trade.setupLabel}
          </span>
        </td>

        <td className="px-3 py-1.5 text-left align-top">
          <span className="font-mono text-[11px]">{trade.instrument.tradingsymbol}</span>
          <span className="block text-[10px] text-faint">
            {trade.qty} qty · {trade.instrument.lotSize}/lot
            {trade.riskCapped ? (
              <span className="ml-1 text-alert" title="Premium was below the risk budget — the real stop was the premium going to zero">
                capped
              </span>
            ) : null}
          </span>
        </td>

        <Td>{fmtPrice(trade.buy.price)}</Td>
        <Td className={open ? "text-muted" : ""}>{mark == null ? DASH : fmtPrice(mark)}</Td>
        <Td className="text-[11px]">
          {open ? (
            <span className="text-accent">open</span>
          ) : trade.sell ? (
            <span title={istClock(trade.sell.at)}>{trade.sell.reason}</span>
          ) : (
            DASH
          )}
        </Td>
        <Td>{fmtPrice(trade.stop)}</Td>
        <Td>
          {fmtPrice(trade.target)}
          {trade.step > 1 ? (
            <span className="ml-1 text-[10px] text-accent" title={`Trailed ${trade.step - 1}x`}>
              ×{trade.step - 1}
            </span>
          ) : null}
        </Td>
        <Td>
          <Money value={profit} pending={open} />
        </Td>
      </tr>

      {expanded ? (
        <tr className="bg-sunken">
          <td colSpan={10} className="px-4 py-3">
            <Detail trade={trade} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Detail({ trade }: { trade: StrategyTrade }) {
  const { trigger } = trade;
  return (
    <div className="flex flex-wrap gap-x-10 gap-y-3 text-[11.5px]">
      <Field label="Trigger">
        {trigger.level.kind === "support" ? "Support" : "Resistance"} {trigger.level.pivot} at{" "}
        <strong>{fmtPrice(trigger.level.value)}</strong>, strike {grouped(trigger.level.strike, 2)}
        , skew{" "}
        {trigger.level.skew == null ? "one-sided" : `${grouped(trigger.level.skew, 1)}×`}, pivot and
        strike agree to {grouped(trigger.level.gapPct, 2)}%
      </Field>

      {trigger.basis ? (
        <Field label="Held above">
          Major support {trigger.basis.pivot} at {fmtPrice(trigger.basis.value)} (skew{" "}
          {trigger.basis.skew == null ? "one-sided" : `${grouped(trigger.basis.skew, 1)}×`})
        </Field>
      ) : null}

      <Field label="At entry">
        Spot {fmtPrice(trigger.spot)} · 21 EMA {fmtPrice(trigger.ema)}
        {trigger.crossedAt ? ` · crossed ${istClock(trigger.crossedAt)}` : ""}
      </Field>

      <Field label="Risk">
        ₹{grouped(Math.round(trade.riskPerUnit * trade.qty))} planned ·{" "}
        {fmtPrice(trade.riskPerUnit)}/unit
      </Field>

      {trade.ladder.length > 0 ? (
        <Field label="Trail">
          {trade.ladder.map((step) => (
            <span key={step.step} className="mr-3 inline-block">
              {istClock(step.at)} → stop {fmtPrice(step.stop)} locks ₹{grouped(Math.round(step.locked))}
            </span>
          ))}
        </Field>
      ) : null}

      <Field label="Record">
        <code className="font-mono text-[10.5px] text-faint">{trade._id}</code>
      </Field>
    </div>
  );
}

function EngineStrip({
  engines,
  strategies,
}: {
  engines: EngineSnapshot[];
  strategies: StrategyDefinition[];
}) {
  const [shown, setShown] = useState<string | null>(null);
  if (engines.length === 0) return null;

  return (
    <section className="mb-4 flex flex-col gap-2">
      {engines.map((engine) => {
        const definition = strategies.find((s) => s.id === engine.strategyId);
        const live = engine.status === "running";
        const expanded = shown === engine.strategyId;

        return (
          <div
            key={engine.strategyId}
            className="rounded-md border border-line bg-surface px-4 py-2.5"
          >
            <div className="flex flex-wrap items-center gap-3 text-[11.5px]">
              <span
                className={`h-[7px] w-[7px] shrink-0 rounded-full ${
                  live ? "bg-pos" : engine.status === "error" ? "bg-neg" : "bg-faint"
                }`}
                aria-hidden
              />
              <span className="font-semibold">{engine.strategyName}</span>
              <span className="text-[10px] uppercase tracking-[0.1em] text-muted">
                v{engine.version} · {engine.status}
              </span>

              {live ? (
                <>
                  <Chip>{engine.watching} watching</Chip>
                  <Chip>{engine.emaReady} EMA ready</Chip>
                  <Chip>
                    {engine.entriesOpen ? "entries open" : `entries shut (${engine.entryCutoffIst})`}
                  </Chip>
                  {engine.basedOn ? <Chip>levels from {engine.basedOn}</Chip> : null}
                </>
              ) : engine.detail ? (
                <span className="text-muted">{engine.detail}</span>
              ) : null}

              {definition ? (
                <button
                  type="button"
                  onClick={() =>
                    setShown((current) => (current === engine.strategyId ? null : engine.strategyId))
                  }
                  aria-expanded={expanded}
                  className="ml-auto text-[11px] text-accent"
                >
                  {expanded ? "Hide rule" : "Show rule"}
                </button>
              ) : null}
            </div>

            {expanded && definition ? (
              <div className="mt-3 border-t border-line pt-3">
                <ol className="flex flex-col gap-1 text-[11.5px] leading-snug text-ink2">
                  {definition.spec.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ol>
                <p className="mt-2 text-[10.5px] text-faint">
                  ₹{definition.risk.rupeesPerTrade} risk · {definition.risk.lots} lot ·{" "}
                  {definition.risk.moneyness} · 1:{definition.risk.rewardMultiple} then{" "}
                  {definition.risk.trail === "ladder" ? "laddered trail" : "one trail step"} ·{" "}
                  {definition.params.emaPeriod} EMA on {definition.params.emaIntervalMinutes}m ·
                  skew ≥ {definition.params.resistanceSkew}× / {definition.params.supportSkew}× ·
                  max {definition.params.maxOpenTrades} open, {definition.params.maxTradesPerDay}/day
                </p>
              </div>
            ) : null}

            {engine.errors.length > 0 ? (
              <ul className="mt-2 flex flex-col gap-0.5 text-[10.5px] text-faint">
                {engine.errors.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

function Money({ value, pending }: { value: number | null; pending: boolean }) {
  if (value == null) return <span className="text-faint">{DASH}</span>;
  const rounded = Math.round(value);
  return (
    <span
      className={`font-semibold ${
        pending ? "text-muted" : rounded > 0 ? "text-pos" : rounded < 0 ? "text-neg" : ""
      }`}
    >
      {rounded >= 0 ? "+" : "−"}₹{grouped(Math.abs(rounded))}
    </span>
  );
}

function Rupees({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  const rounded = Math.round(value);
  return (
    <span className="flex items-center gap-1.5 text-[11px]">
      <span className="text-muted">{label}</span>
      <span
        className={`tnum font-mono font-semibold ${
          muted ? "text-muted" : rounded > 0 ? "text-pos" : rounded < 0 ? "text-neg" : "text-ink"
        }`}
      >
        {rounded >= 0 ? "+" : "−"}₹{grouped(Math.abs(rounded))}
      </span>
    </span>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-[3px] border border-linestrong px-1.5 py-px text-[10px] text-muted">
      {children}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="max-w-[52ch]">
      <span className="block font-display text-[9.5px] font-bold uppercase tracking-[0.12em] text-faint">
        {label}
      </span>
      <span className="text-ink2">{children}</span>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="mb-5 overflow-hidden rounded-md border border-line bg-surface">
      <div className="border-b border-line px-4 py-3">
        <h2 className="font-display text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
          Trades
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
  return <td className={`tnum px-3 py-1.5 text-right align-top font-mono ${className}`}>{children}</td>;
}
