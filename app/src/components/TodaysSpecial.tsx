"use client";

import type { ConfirmedLevel } from "@/lib/eod/confluence";
import type { EodReport, SpecialStock } from "@/lib/eod/types";
import { levelId } from "@/lib/eod/watch";
import { fmtPeriod, fmtPrice, fmtSignedPct, grouped } from "@/lib/format";
import type { Quote } from "@/lib/types";

/**
 * Both stages of the funnel render through here. Today's Special is the
 * overnight output — pivots that the option chain corroborated. Current Special
 * is the subset live price has since arrived at. Same card, different list, so
 * the two always read identically.
 */
export default function TodaysSpecial({
  report,
  stocks,
  title,
  tag,
  empty,
  quotes,
  armed,
  onOpen,
}: {
  report: EodReport;
  stocks: SpecialStock[];
  title: string;
  tag: string;
  empty: string;
  quotes: Record<string, Quote>;
  armed: Set<string>;
  onOpen: (symbol: string) => void;
}) {
  return (
    <section
      aria-label={title}
      className="mb-5 overflow-hidden rounded-md border border-line bg-surface"
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <h2 className="font-display text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
          {title} · {stocks.length}
        </h2>
        <span className="rounded-[3px] border border-linestrong px-1.5 py-px text-[10px] uppercase tracking-[0.1em] text-muted">
          {tag}
        </span>
        {report.verifiedAt ? null : (
          <span
            className="rounded-[3px] bg-alertsoft px-1.5 py-px text-[10px] uppercase tracking-[0.1em] text-alert"
            title="Kite finalises the daily candle overnight, so these closes may still be provisional. They are re-read and the pivots recomputed on the first run after midnight."
          >
            Provisional
          </span>
        )}
        <p
          className="ml-auto max-w-[56ch] text-[10.5px] leading-snug text-faint"
          title={`A session's pivots are always derived from the previous session's high, low and close — that is what makes these ${fmtDate(
            report.computedFor
          )}'s levels rather than ${fmtDate(report.basedOn)}'s.`}
        >
          <b className="font-semibold text-muted">{fmtDate(report.computedFor)} Fibonacci pivots</b>{" "}
          (from the {fmtDate(report.basedOn)} range) ×{" "}
          <b className="font-semibold text-muted">
            {fmtDate(report.basedOn)} closing option writing
          </b>{" "}
          — {report.params.oiRatio}× skew, matched within {report.params.bandMaxPct}%.{" "}
          <span className="text-accent">◆</span> marks agreement inside{" "}
          {report.params.preciousPct}%.
        </p>
      </div>

      <div className="px-4 py-3.5">
        {stocks.length === 0 ? (
          <p className="text-[12px] text-muted">{empty}</p>
        ) : (
          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {stocks.map((stock) => (
              <StockCard
                key={stock.symbol}
                stock={stock}
                quote={quotes[stock.symbol]}
                armed={armed}
                onOpen={onOpen}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function StockCard({
  stock,
  quote,
  armed,
  onOpen,
}: {
  stock: SpecialStock;
  quote: Quote | undefined;
  armed: Set<string>;
  onOpen: (symbol: string) => void;
}) {
  const live = quote?.ltp ?? null;
  const hot = stock.levels.some((level) => armed.has(levelId(stock.symbol, level.pivot)));

  return (
    <article className={`rounded-md border p-3 ${hot ? "border-alert" : "border-line"}`}>
      <header className="flex items-baseline gap-2">
        <button
          type="button"
          onClick={() => onOpen(stock.symbol)}
          className="font-mono text-[12.5px] font-semibold tracking-tight hover:text-accent"
        >
          {stock.symbol}
        </button>
        {hot ? (
          <span
            className="h-[7px] w-[7px] rounded-full bg-alert animate-report-pulse"
            aria-label="A level is inside the alert band right now"
          />
        ) : null}
        <span className="ml-auto tnum font-mono text-[12.5px] font-semibold">
          {live == null ? "—" : fmtPrice(live)}
        </span>
        {quote ? (
          <span
            className={`tnum font-mono text-[11px] ${
              quote.changePct >= 0 ? "text-pos" : "text-neg"
            }`}
          >
            {fmtSignedPct(quote.changePct)}
          </span>
        ) : null}
      </header>

      <p className="truncate text-[10.5px] text-muted" title={stock.name}>
        {stock.name}
      </p>

      <ul className="mt-2 flex flex-col gap-1">
        {stock.levels.map((level) => (
          <LevelRow
            key={level.pivot}
            level={level}
            live={live}
            armed={armed.has(levelId(stock.symbol, level.pivot))}
          />
        ))}
      </ul>

      <p className="mt-2 text-[10px] text-faint">
        {quote ? "" : "No live quote · "}
        {stock.session.date} close {fmtPrice(stock.session.close)} · {stock.expiry} expiry
      </p>
    </article>
  );
}

function LevelRow({
  level,
  live,
  armed,
}: {
  level: ConfirmedLevel;
  live: number | null;
  armed: boolean;
}) {
  const support = level.kind === "support";
  // Distance is re-measured against live price where there is one, so the card
  // answers "how far now", not "how far at the close".
  const away = live != null ? (Math.abs(live - level.pivotValue) / level.pivotValue) * 100 : level.reachPct;
  const dominant = support ? level.putOi : level.callOi;
  const other = support ? level.callOi : level.putOi;
  const skew = other > 0 ? dominant / other : null;

  return (
    <li
      className={`flex items-baseline gap-2 rounded-[3px] px-1.5 py-1 text-[11px] ${
        armed ? "bg-alertsoft" : level.precious ? "bg-accentsoft" : "bg-sunken"
      }`}
    >
      <span
        className={`w-[15px] shrink-0 text-center font-mono text-[10px] font-bold ${
          support ? "text-pos" : "text-neg"
        }`}
        title={support ? "Support" : "Resistance"}
      >
        {support ? "S" : "R"}
      </span>
      <span className="w-[18px] shrink-0 font-mono text-[10px] text-muted">{level.pivot}</span>
      <span className="tnum font-mono font-semibold">{fmtPrice(level.pivotValue)}</span>
      {level.precious ? (
        <span
          className="shrink-0 font-mono text-[10px] font-bold text-accent"
          title={`Precious — the pivot and strike ${level.strike} agree to ${grouped(
            level.gapPct,
            2
          )}%, effectively the same price`}
          aria-label="Precious match"
        >
          ◆
        </span>
      ) : null}
      <span className="tnum ml-auto font-mono text-[10px] text-muted" title="Distance from price">
        {grouped(away, 2)}% away
      </span>
      <span
        className="tnum font-mono text-[10px] text-faint"
        title={`Strike ${level.strike} · ${grouped(level.callOi, 0)} call OI vs ${grouped(
          level.putOi,
          0
        )} put OI`}
      >
        {skew == null ? "1-sided" : `${grouped(skew, 1)}×`}
      </span>
    </li>
  );
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${Number(d)} ${fmtPeriod(`${y}-${m}`).split(" ")[0]}`;
}
