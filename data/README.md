# Nifty 200 fundamentals corpus

Backfilled from screener.in on **2026-08-27**. All 200 index constituents, current
through the **Jun 2026** quarter.

## Layout

```
data/raw/{SYMBOL}/{YYYY-MM-DD}.html.gz   archived page, ~20 KB each  (4.4 MB total)
data/facts/{SYMBOL}.json                 parsed long-format facts    (17 MB total)
data/state/variants.json                 consolidated vs standalone per symbol
data/state/screener.jar                  cookie jar (persisted across runs)
data/state/runs/fetch-{DATE}.jsonl       per-fetch audit log
```

Raw pages are the source of truth. `facts/` is regenerable at any time with
`node scripts/parse.mjs` — so a parser fix never requires re-crawling.

## Fact record

```json
{ "statement": "quarters", "lineItem": "Sales",
  "periodEnd": "2026-06", "value": 19114, "unit": "cr" }
```

`statement` ∈ `quarters` `pnl` `balance_sheet` `cash_flow` `ratios` `shareholding` `growth`.
`unit` ∈ `cr` `pct` `rs` `days` `count`. `periodEnd` is `YYYY-MM`, or `TTM`, or
`null` for growth boxes.

**Long format is deliberate.** Banks and manufacturers expose different line items,
so a wide schema would silently null out the ~48 financials in the index:

| | Manufacturer | Bank / NBFC |
|---|---|---|
| Revenue line | `Sales` | `Revenue` |
| Margin | `Operating Profit`, `OPM %` | `Financing Profit`, `Financing Margin %` |
| Debt | `Borrowings` | `Borrowing`, `Deposits` |
| Asset quality | — | `Gross NPA %`, `Net NPA %` |
| Ratios | 6 working-capital ratios + `ROCE %` | `ROE %` only |

Corpus totals: 67 universal labels, 12 sector-specific, 131,006 facts.

## Consolidated vs standalone

186 companies use consolidated, **14 use standalone** (see `state/variants.json`).
Two distinct reasons, both caught by `scripts/validate.mjs`:

1. **No consolidated filing.** Screener still serves the `/consolidated/` URL but
   renders empty tables — the page is ~120 KB instead of ~230 KB. Silent, and it
   parses as "success" without structural assertions.
2. **`TATAELXSI` — a source-data defect.** Its consolidated view is stuck at
   Mar 2012–Mar 2015 while its annual data is current. Standalone is correct and
   current. Re-fetching returned a byte-identical page, so this is screener's data,
   not a stale cache.

**Rule for refreshes:** pick the variant that actually carries current quarterly
data, never blindly prefer consolidated. Read `state/variants.json` first.

## Refreshing

```bash
./scripts/fetch.sh                        # all pending, skips today's completed
./scripts/fetch.sh --only ITC,HDFCBANK
./scripts/fetch.sh --standalone --only PAGEIND
node scripts/parse.mjs                    # raw -> facts
node scripts/validate.mjs                 # QA gate, run after every refresh
```

`fetch.sh` is sequential with a 4–9s randomised gap, persists cookies, and halts
the entire run on the first 403/429/503 rather than retrying. It is resumable —
completed symbols are skipped, so re-running after a halt continues where it left off.

Backfill cost: 200 pages in 27 minutes, zero blocks, zero failures.

## Known gaps

- **No cash line item** — screener folds cash into "Other Assets", so EV is a band, not a number.
- **No embedded value / NNPA-adjusted book value** — needed for insurers and banks; requires filings.
- **No `reportedOn`** — screener doesn't publish filing dates. Pair with the NSE
  results calendar for point-in-time correctness before backtesting.
