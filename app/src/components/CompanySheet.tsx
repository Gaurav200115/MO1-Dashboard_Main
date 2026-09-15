"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { X } from "lucide-react";
import {
  DASH,
  fmtCrore,
  fmtPct,
  fmtPeriod,
  fmtPrice,
  fmtRatio,
  fmtSignedPct,
  grouped,
} from "@/lib/format";
import type { CompanyDetail, Quote } from "@/lib/types";
import ResultsMarker from "./ResultsMarker";
import StatementTable from "./StatementTable";

/**
 * Recharts is ~100kB and only this sheet needs it, so it downloads when a stock
 * is first opened rather than riding along with every page load.
 */
const StockChart = dynamic(() => import("./StockChart"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[260px] items-center justify-center rounded-[6px] border border-line bg-surface text-[12px] text-muted">
      Loading chart…
    </div>
  ),
});

const OVERVIEW = "__overview__";

const TABS: { key: string; label: string }[] = [
  { key: OVERVIEW, label: "Overview" },
  { key: "quarters", label: "Quarterly" },
  { key: "pnl", label: "Profit & Loss" },
  { key: "balance_sheet", label: "Balance sheet" },
  { key: "cash_flow", label: "Cash flow" },
  { key: "ratios", label: "Ratios" },
  { key: "shareholding", label: "Shareholding" },
];

export default function CompanySheet({
  symbol,
  snapshot,
  quote,
  onClose,
  today,
}: {
  symbol: string;
  snapshot: string;
  /** Live quote when the feed has one, so the header agrees with the chart. */
  quote?: Quote;
  onClose: () => void;
  today?: string;
}) {
  const [data, setData] = useState<CompanyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState(OVERVIEW);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setTab(OVERVIEW);

    fetch(`/data/companies/${encodeURIComponent(symbol)}.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`No statement data for ${symbol}`);
        return r.json();
      })
      .then((d: CompanyDetail) => {
        if (!cancelled) setData(d);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });

    return () => {
      cancelled = true;
    };
  }, [symbol]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const available = TABS.filter((t) => t.key === OVERVIEW || data?.series?.[t.key]);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-[rgba(10,13,17,0.45)] backdrop-blur-[2px]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={data ? data.name : symbol}
        className="flex h-full w-full max-w-[920px] flex-col overflow-hidden border-l border-line bg-ground"
      >
        <header className="border-b border-line bg-surface px-6 pt-5">
          <div className="flex items-start gap-4">
            <div className="min-w-0">
              <h2 className="font-display text-[22px] font-extrabold tracking-tight">
                {data?.name ?? symbol}
              </h2>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-muted">
                <span>{symbol}</span>
                {data ? (
                  <>
                    <span aria-hidden>·</span>
                    <span>{data.sector}</span>
                    <span aria-hidden>·</span>
                    <span>{data.variant === "standalone" ? "Standalone" : "Consolidated"}</span>
                    <span aria-hidden>·</span>
                    <span>latest {fmtPeriod(data.latestQuarter)}</span>
                    <span aria-hidden>·</span>
                    <ResultsMarker company={data} today={today} />
                  </>
                ) : null}
              </div>
            </div>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              className="ml-auto flex items-center gap-1.5 rounded-[5px] border border-line px-2.5 py-1.5 text-[12px] text-muted hover:bg-surface2 hover:text-ink"
            >
              <X size={13} aria-hidden />
              Close
              <kbd className="font-mono text-[10px]">Esc</kbd>
            </button>
          </div>

          {data ? (
            <div className="mt-4 flex flex-wrap gap-6">
              {(
                [
                  [
                    "Price",
                    quote ? (
                      <span className="flex items-baseline gap-1.5">
                        {fmtPrice(quote.ltp)}
                        <span
                          className={`text-[11.5px] font-semibold ${
                            quote.changePct >= 0 ? "text-pos" : "text-neg"
                          }`}
                        >
                          {fmtSignedPct(quote.changePct)}
                        </span>
                      </span>
                    ) : (
                      fmtPrice(data.price)
                    ),
                  ],
                  ["Market cap", fmtCrore(data.mcap)],
                  ["P/E", fmtRatio(data.pe)],
                  ["P/B", fmtRatio(data.pb)],
                  ["Div yield", fmtPct(data.dy)],
                  ["ROE", fmtPct(data.roe)],
                ] as const
              ).map(([k, v]) => (
                <div key={k}>
                  <div className="text-[10px] uppercase tracking-[0.09em] text-muted">{k}</div>
                  <div className="tnum font-mono text-[16px] font-semibold">{v}</div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="mt-3.5 flex gap-0.5 overflow-x-auto" role="tablist">
            {available.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={`whitespace-nowrap border-b-2 px-3 py-2 text-[12.5px] ${
                  tab === t.key
                    ? "border-accent font-semibold text-accent"
                    : "border-transparent text-muted hover:text-ink"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-6 pb-16 pt-5">
          {/* The chart leads the overview. Candles come from Kite rather than the
              screener snapshot, so it paints straight away instead of waiting on
              the statement JSON that fills in the fundamentals below it. */}
          {tab === OVERVIEW ? (
            <section className="mb-7">
              <StockChart symbol={symbol} />
              <p className="mt-2.5 text-[11px] text-faint">
                Kite Connect historical candles · 1D is 5-minute, 1W/1M/1Y are daily closes.
              </p>
            </section>
          ) : null}

          {error ? (
            <p className="rounded-md border border-line bg-surface p-8 text-center text-[13px] text-neg">
              {error}
            </p>
          ) : !data ? (
            <p className="p-8 text-center text-[13px] text-muted">Loading statements…</p>
          ) : tab === OVERVIEW ? (
            <Overview data={data} />
          ) : (
            <>
              <StatementTable statement={data.series[tab]} />
              <Note>
                Figures in ₹ crore unless the line item states otherwise. Source: screener.in
                snapshot {snapshot}, {data.variant} basis.
              </Note>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Overview({ data: c }: { data: CompanyDetail }) {
  const lender = c.isBank;
  const stats: [string, string, string?][] = [
    ["P/E", fmtRatio(c.pe), "Trailing"],
    ["P/B", fmtRatio(c.pb), "Price ÷ book value"],
    ["P/S", fmtRatio(c.ps), "Price ÷ sales per share"],
    ["EV/EBITDA", lender ? DASH : fmtRatio(c.evEbitda), lender ? "Not meaningful for lenders" : "Gross debt basis"],
    ["EV/EBITDA net", lender ? DASH : fmtRatio(c.evEbitdaNet), lender ? "" : "Investments netted off"],
    ["EV/Sales", lender ? DASH : fmtRatio(c.evSales), ""],
    ["P/FCF", fmtRatio(c.pfcf), "Latest annual free cash flow"],
    ["P/OCF", fmtRatio(c.pocf), "Latest annual operating cash flow"],
    ["Earnings yield", fmtPct(c.ey), "Inverse of P/E"],
    ["FCF yield", fmtPct(c.fcfy), "FCF ÷ market cap"],
    ["Dividend yield", fmtPct(c.dy), ""],
    ["ROCE", fmtPct(c.roce), ""],
    ["ROE", fmtPct(c.roe), ""],
    ["Book value", fmtPrice(c.bv), "Per share"],
    ["Face value", fmtPrice(c.fv), ""],
    ["52w high / low", c.hl ?? DASH, ""],
    ["Shares outstanding", c.shares != null ? `${grouped(c.shares, 1)} Cr` : DASH, "Market cap ÷ price"],
  ];
  const growth = Object.keys(c.growth ?? {});

  return (
    <>
      <Grid>
        {stats.map(([k, v, note]) => (
          <Stat key={k} label={k} value={v} note={note} />
        ))}
      </Grid>

      {growth.length > 0 ? (
        <>
          <h3 className="mb-2 mt-7 font-display text-[11px] font-bold uppercase tracking-[0.11em] text-muted">
            Compounded growth
          </h3>
          <Grid>
            {growth.map((k) => (
              <Stat key={k} label={k} value={fmtPct(c.growth[k])} />
            ))}
          </Grid>
        </>
      ) : null}

      <Note>
        <strong className="font-semibold">Reporting.</strong> Latest published quarter is{" "}
        {fmtPeriod(c.latestQuarter)}. The next quarter ends{" "}
        {c.nextQuarterEnd ? fmtPeriod(c.nextQuarterEnd.slice(0, 7)) : DASH}, so results are due by{" "}
        <strong className="font-semibold">{c.resultsDueBy ?? DASH}</strong> under SEBI LODR Reg 33.
        The exact board-meeting date is announced at least five days ahead and appears here once the
        NSE calendar poller runs — the marker turns amber and pulses on the day itself.
      </Note>
    </>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-2.5">{children}</div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-md border border-line bg-surface px-3.5 py-3">
      <div className="text-[10px] uppercase tracking-[0.09em] text-muted">{label}</div>
      <div className="tnum mt-0.5 font-mono text-[18px] font-semibold tracking-tight">{value}</div>
      {note ? <div className="mt-0.5 text-[11px] text-faint">{note}</div> : null}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-4 rounded-r-[5px] border-l-2 border-alert bg-alertsoft px-3.5 py-2.5 text-[12px] text-ink2">
      {children}
    </p>
  );
}
