# Nifty 200 Desk

Next.js 15 · React 19 · Tailwind v4 · TypeScript strict — same stack as `Trading_Journal`,
including `recharts` and `lucide-react`, so charts and icons need no new dependencies.

```bash
npm run data     # rebuild public/data from the fact corpus
npm run dev      # http://localhost:3000
npm run build
```

## Data flow

```
data/facts/{SYM}.json          parsed corpus (scripts/parse.mjs)
        ↓  scripts/build-data.mjs
app/public/data/index.json          94 KB   → read on the server, first paint
app/public/data/companies/{SYM}.json 1.09 MB → fetched per company on row open
```

The split matters: the table renders from a 94 KB index without a client round trip, and
thirteen quarters of statements load only for the company actually being inspected.
`build-data.mjs` resolves paths against the repo root, so it runs from any directory.

## Structure

| Path | Role |
| --- | --- |
| `src/app/page.tsx` | Server component — reads `index.json`, renders `<Desk>` |
| `src/components/Desk.tsx` | Client shell: sector, metric, sort, search, open-sheet state |
| `src/components/SectorRail.tsx` | 18 NSE sectors, largest first |
| `src/components/LeaderStrip.tsx` | Top 6, metric switchable |
| `src/components/CompanyTable.tsx` | Sortable table, keyboard-navigable rows |
| `src/components/CompanySheet.tsx` | Slide-over; lazy-loads statements, tabbed |
| `src/components/StatementTable.tsx` | Period-column table with sticky line-item column |
| `src/components/ResultsMarker.tsx` | Reporting state — dot + label |
| `src/lib/format.ts` | Every formatting rule, one per unit |
| `src/lib/metrics.ts` | Column and leader-metric definitions, sort comparator |
| `src/lib/types.ts` | Shared types, including the not-yet-populated `Quote` |

## Sector indices and rotation

The sector indices are **chained and stored**. They were previously rebased to 1,000 at
every previous close, which made the level a day gauge wearing an index costume: it said
+0.73% and forgot it by the evening. Now a session multiplies into yesterday level and the
result is written to disk, so 1,180 means the sector has compounded 18% since the base date.

```
.kite/sectors/history.json      the chain — source of truth, one file, all indices
Mongo sector_index_daily        queryable mirror, one doc per (date, sector)
```

Both halves of the desk use the same formula, a free-float market-cap weighted index
expressed as a weighted mean of constituent day-returns:

```
level_t = level_{t-1} * Sum(w_i * P_i,t / P_i,t-1) / Sum(w_i),   w_i = shares_i * float_i * P_i,t-1
```

`src/lib/sector/series.ts` runs it over daily candles for the stored history;
`src/lib/sectorIndex.ts` runs it over live quotes and chains onto the last stored close.
Extending the chain one session at a time is verified to land on exactly the levels a
single full build produces, so a daily append never drifts from a backfill.

| Path | Role |
| --- | --- |
| `src/lib/sector/series.ts` | The chaining maths, plus breadth and turnover per session |
| `src/lib/sector/rotation.ts` | Relative strength, RRG coordinates, quadrants, rankings |
| `src/lib/sector/store.ts` | `history.json` + the Mongo mirror |
| `src/lib/sector/job.ts` | Daily extend / first backfill, from Kite candles |
| `src/lib/sector/seed.ts` | Provisional chain from the stored EOD reports, no token needed |
| `src/components/SectorRotation.tsx` | The rotation panel — RRG, table, how to read it |
| `src/components/RotationGraph.tsx` | Relative Rotation Graph with 10-session tails |
| `src/components/SectorIndexChart.tsx` | One sector chain against the benchmark |

### Running it

The chain extends itself: `runDailyStartup` calls it after the EOD scan, which is deliberate
— that scan has just pulled a year of daily candles for every F&O name and the history cache
holds them for six hours, so the extend costs about fifteen requests rather than two hundred.

```bash
curl -X POST localhost:3000/api/sectors             # extend, or first backfill
curl -X POST 'localhost:3000/api/sectors?force=1'   # rebuild from candles, resets the base
curl -X POST 'localhost:3000/api/sectors?from=eod'  # provisional chain, no Kite session needed
curl 'localhost:3000/api/sectors'                   # rotation view
curl 'localhost:3000/api/sectors?view=series&sector=Banks'
```

`from=eod` exists because the Kite token dies at 06:00 IST and the reports on disk already
carry one settled close per stock per session. It covers only the F&O names and only as far
back as the reports go, so it is tagged `source: "eod-reports"` and the next signed-in run
**replaces** it with a full candle backfill rather than chaining onto it.

### What the numbers mean

`RS-Ratio` and `RS-Momentum` are a Relative Rotation Graph. The published JdK formulas are
proprietary; this is the open replication — z-score the relative-strength line over a
50-session window, and z-score its 10-session change the same way, both centred on 100.
Quadrants rotate clockwise, Improving → Leading → Weakening → Lagging, and the two hinges are
where the information is: a sector entering Improving is still bottom of every trailing
return column, and one entering Weakening still tops them.

Three caveats the panel does not hide:

- **Float factors and membership are the current snapshot applied backwards.** A promoter who
  sold down in March is treated as having sold a year ago, and a stock that joined the index
  in June is in it from the base date. Fine for ranking sectors against each other, not a
  tradable index history.
- **The benchmark is the in-house whole-universe index**, not the published Nifty 200 —
  otherwise relative strength would be partly the two constructions disagreeing.
- **The RRG needs 120 stored sessions.** Below that the panel says so and falls back to
  ranking on the longest horizon the chain actually supports.

## Conventions worth keeping

**Indian digit grouping everywhere** — `₹3,36,304 Cr`, via `en-IN`. All figures use
`font-mono` with `tabular-nums` so columns align.

**Missing data is `—`, never `0`.** The sort comparator sinks nulls in *both* directions, so
reversing a column never fills the top with blanks.

**EV multiples are null for lenders.** 31 of the 200 are banks/NBFCs where EV/EBITDA is
meaningless; the overview says so rather than showing a number.

**Standalone companies carry an `SA` badge.** 14 companies have no consolidated filing, so
their figures are not comparable with consolidated peers.

## Theming

Tokens are CSS variables in `globals.css`; `@theme inline` points Tailwind's utilities at the
variables so they swap at runtime. Three states are handled — explicit light, explicit dark,
and the default unstamped document where only `prefers-color-scheme` applies. A blocking
inline script in `layout.tsx` applies the stored choice before first paint to avoid a flash.

Amber (`--alert`) is reserved exclusively for reporting state so the pulse never competes with
valuation colour.

## Where the next pieces plug in

**Live prices (Zerodha).** Kite's WebSocket needs `api_key` + `access_token`, which must stay
server-side — never shipped to the browser. Add a route handler under `src/app/api/` that
holds the credentials and relays ticks, then merge them into `CompanySummary.price` in
`Desk.tsx`. The `Quote` type in `src/lib/types.ts` is the intended shape. Everything
downstream (P/E, P/B, P/S, EV multiples, yields) is derived from price, so recomputing on tick
is the same arithmetic `build-data.mjs` already does.

**Price charts.** `recharts` is installed. Candles come from Kite's historical endpoint, not
screener — this app has no OHLC data.

**Confirmed results dates.** `build-data.mjs` already reads
`data/state/results_calendar.json` (`{ SYMBOL: { date } }`) into `resultsDate`. Once the NSE
board-meeting poller writes that file, the marker switches from statutory deadline to
confirmed date and pulses on the day. No frontend change needed.
