"use client";

import { useCallback, useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { FloatTable } from "@/lib/float";
import { COLUMNS, sortCompanies } from "@/lib/metrics";
import { anchorIsStale, computeSectorIndices } from "@/lib/sectorIndex";
import { confirmedStocks, currentStocks } from "@/lib/eod/watch";
import { effectiveSector, groupBySector } from "@/lib/sectors";
import type { DeskIndex, LiveRow, MetricKey, SortKey } from "@/lib/types";
import { useAlerts } from "@/lib/useAlerts";
import { useEod } from "@/lib/useEod";
import { useQuotes } from "@/lib/useQuotes";
import { useSectors } from "@/lib/useSectors";
import { useTrades } from "@/lib/useTrades";
import AlertsBell from "./AlertsBell";
import CompanySheet from "./CompanySheet";
import CompanyTable from "./CompanyTable";
import FeedStatus from "./FeedStatus";
import LeaderStrip from "./LeaderStrip";
import LevelArchive from "./LevelArchive";
import SectorIndexChart from "./SectorIndexChart";
import SectorIndexStrip from "./SectorIndexStrip";
import SectorRail, { ALL, ARCHIVE, CURRENT, ROTATION, SPECIAL, TRADES } from "./SectorRail";
import SectorRotation from "./SectorRotation";
import ThemeToggle from "./ThemeToggle";
import TodaysSpecial from "./TodaysSpecial";
import TradeBlotter from "./TradeBlotter";

export default function Desk({ data, floats }: { data: DeskIndex; floats: FloatTable }) {
  const [sector, setSector] = useState<string>(ALL);
  const [metric, setMetric] = useState<MetricKey>("mcap");
  const [sortKey, setSortKey] = useState<SortKey>("mcap");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const { quotes, feed } = useQuotes();
  const { report } = useEod();

  /*
   * The stored index chain. Loaded client-side rather than on the server for
   * the same reason the EOD report is: this page is statically prerendered, and
   * reading the chain during render would bake one evening previous close into
   * the build and never move it again.
   */
  const { anchor, rotation, missing: noChain } = useSectors();
  const { alerts, armed, unread, markRead } = useAlerts(report, quotes);

  /*
   * Lifted out of the blotter so the rail can show a live count without a second
   * poll. The hook backs off to a one-minute cadence when no position is open,
   * so carrying it at this level costs one small request a minute.
   */
  const tradeData = useTrades(true);

  /**
   * The one place the live feed meets the snapshot. Only `price` is overwritten
   * and `chg` added — every multiple below stays as screener.in reported it, so
   * the table never pairs a live numerator with stale fundamentals.
   *
   * Because sortCompanies reads `price` off the row, sorting by Price or Δ% is
   * live sorting for free.
   */
  const rows = useMemo<LiveRow[]>(
    () =>
      data.companies.map((c) => {
        const quote = quotes[c.symbol];
        if (!quote) return c;
        return { ...c, price: quote.ltp, chg: quote.changePct, live: true };
      }),
    [data.companies, quotes]
  );

  /**
   * Recomputed on every coalesced batch, which is cheap: one pass over 200 rows
   * summing two floats per constituent, no allocation per tick.
   */
  const indices = useMemo(
    () => computeSectorIndices(data.companies, quotes, floats, anchor),
    [data.companies, quotes, floats, anchor]
  );

  /** The chain has not been extended recently enough for its last bar to be yesterday. */
  const chainStale = useMemo(() => anchorIsStale(anchor), [anchor]);

  /** Member counts per sector, after the banks / ex-banks split. */
  const sectorCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [name, members] of groupBySector(data.companies)) {
      counts.set(name, members.length);
    }
    return counts;
  }, [data.companies]);

  const inSector = useMemo(
    () => (sector === ALL ? rows : rows.filter((c) => effectiveSector(c) === sector)),
    [rows, sector]
  );

  /**
   * Picking a sector switches the sort to today's move once, since that is the
   * question a sector view is asked. Later column clicks stick, so choosing a
   * sector and then sorting by P/E is not undone.
   */
  const handleSectorSelect = useCallback((next: string) => {
    setSector(next);
    const isPanel =
      next === ALL ||
      next === SPECIAL ||
      next === CURRENT ||
      next === ARCHIVE ||
      next === TRADES ||
      next === ROTATION;
    if (!isPanel) {
      setSortKey("chg");
      setSortDir(-1);
    }
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? inSector.filter(
          (c) =>
            c.symbol.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)
        )
      : inSector;
    return sortCompanies(filtered, sortKey, sortDir);
  }, [inSector, query, sortKey, sortDir]);

  const activeIndex = sector === ALL ? undefined : indices.get(sector);

  /** The rail shows the current leader, so the panel is worth opening or not. */
  const rotationSummary = useMemo(
    () =>
      rotation
        ? { sessions: rotation.depth, leader: rotation.rows[0]?.sector ?? null }
        : null,
    [rotation]
  );

  /**
   * The two stages of the watchlist. Today's Special is the overnight output;
   * Current Special narrows it to where live price has actually arrived.
   */
  const todayList = useMemo(() => confirmedStocks(report), [report]);
  const currentList = useMemo(() => currentStocks(report, armed), [report, armed]);

  const special = useMemo(
    () =>
      todayList.length === 0
        ? null
        : { today: todayList.length, current: currentList.length },
    [todayList, currentList]
  );

  const tradeCounts = useMemo(
    () => ({
      taken: tradeData.trades.length,
      open: tradeData.trades.filter((trade) => trade.status === "open").length,
    }),
    [tradeData.trades]
  );

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 1 ? -1 : 1));
      return;
    }
    setSortKey(key);
    setSortDir(COLUMNS.find((c) => c.key === key)?.defaultDir ?? -1);
  }

  return (
    <>
      <header className="sticky top-0 z-30 flex items-center gap-5 border-b border-line bg-surface px-5 py-3">
        <div className="flex items-baseline gap-2.5">
          <h1 className="font-display text-[17px] font-extrabold tracking-tight">Nifty 200 Desk</h1>
          <span className="rounded-[3px] border border-linestrong px-1.5 py-px text-[10px] uppercase tracking-[0.1em] text-muted">
            {data.meta.snapshot} · {data.meta.companies} companies
          </span>
          <FeedStatus feed={feed} />
        </div>

        <div className="relative ml-auto">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
            aria-hidden
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search symbol or company"
            aria-label="Search companies"
            className="w-[220px] rounded-md border border-line bg-sunken py-1.5 pl-7 pr-2.5 text-[13px] placeholder:text-faint"
          />
        </div>

        <AlertsBell
          alerts={alerts}
          unread={unread}
          markRead={markRead}
          feed={feed}
          onOpen={setOpen}
        />

        <ThemeToggle />
      </header>

      <div className="grid items-start lg:grid-cols-[224px_minmax(0,1fr)]">
        <aside className="border-b border-line bg-surface px-3 py-4 lg:sticky lg:top-[57px] lg:h-[calc(100vh-57px)] lg:overflow-y-auto lg:border-b-0 lg:border-r">
          <SectorRail
            sectors={sectorCounts}
            indices={indices}
            total={data.companies.length}
            active={sector}
            onSelect={handleSectorSelect}
            special={special}
            trades={tradeCounts}
            rotation={rotationSummary}
          />
        </aside>

        <main className="min-w-0 px-6 pb-16 pt-5">
          {sector === ROTATION ? (
            rotation ? (
              <SectorRotation view={rotation} onSelect={handleSectorSelect} />
            ) : (
              <p className="text-[12.5px] text-muted">
                {noChain
                  ? "No stored index chain yet. Sign in to Kite and POST /api/sectors to build it — one call reads a year of daily candles and writes the chained history the rotation view runs on."
                  : "Loading the stored index chain…"}
              </p>
            )
          ) : sector === TRADES ? (
            <TradeBlotter data={tradeData} />
          ) : sector === ARCHIVE ? (
            <LevelArchive active />
          ) : sector === SPECIAL || sector === CURRENT ? (
            report && special ? (
              <TodaysSpecial
                report={report}
                stocks={sector === CURRENT ? currentList : todayList}
                title={sector === CURRENT ? "Current Special" : "Today's Special"}
                tag={
                  sector === CURRENT
                    ? `Price within ${report.params.bandMaxPct}% of a level`
                    : "Pivot × option chain"
                }
                empty={
                  sector === CURRENT
                    ? `No stock is within ${report.params.bandMaxPct}% of one of its confirmed levels right now. ${todayList.length} are on the Today's Special list waiting for price to arrive.`
                    : "No pivot was corroborated by the option chain for this session."
                }
                quotes={quotes}
                armed={armed}
                onOpen={setOpen}
              />
            ) : (
              <p className="text-[12.5px] text-muted">
                No levels yet — the scan runs on server start and needs a signed-in Kite session.
              </p>
            )
          ) : (
            <>
              {activeIndex ? (
                <div className="mb-5 flex flex-col gap-4">
                  <SectorIndexStrip index={activeIndex} chainStale={chainStale} />
                  <SectorIndexChart sector={sector} />
                </div>
              ) : null}

              <LeaderStrip
                companies={inSector}
                sector={sector}
                metric={metric}
                onMetricChange={setMetric}
                onOpen={setOpen}
              />

              <section className="overflow-hidden rounded-md border border-line bg-surface">
                <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
                  <h2 className="font-display text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
                    {sector === ALL ? "All companies" : sector} · {visible.length}
                  </h2>
                  <div className="ml-auto flex flex-wrap items-center gap-3.5 text-[11px] text-muted">
                    <Key className="bg-alert animate-report-pulse">Reports today</Key>
                    <Key className="bg-alert">Due within 14 days</Key>
                    <span className="flex items-center gap-1.5">
                      <span className="rounded-full bg-alertsoft px-1.5 py-px text-[10px] text-alert">
                        SA
                      </span>
                      Standalone figures
                    </span>
                  </div>
                </div>

                <CompanyTable
                  companies={visible}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                  onOpen={setOpen}
                />
              </section>

              {data.meta.calendarEntries === 0 ? (
                <p className="mt-4 text-[11.5px] text-faint">
                  No confirmed board-meeting dates yet — the NSE calendar has no Nifty 200 entries
                  until Q2 intimations begin in late October. Dates shown are the statutory SEBI
                  filing deadlines until then.
                </p>
              ) : null}
            </>
          )}
        </main>
      </div>

      {open ? (
        <CompanySheet
          symbol={open}
          snapshot={data.meta.snapshot}
          quote={quotes[open]}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}

function Key({ children, className }: { children: React.ReactNode; className: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-[7px] w-[7px] rounded-full ${className}`} aria-hidden />
      {children}
    </span>
  );
}
