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
