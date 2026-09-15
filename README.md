# MO1-200 — Nifty 200 universe

Constituent list of the **NIFTY 200** index (Nifty 100 + Nifty Midcap 100), taken from
the official NSE file so symbols match exactly what the exchange and broker APIs use.

| File | What it is |
| --- | --- |
| `nifty200.ts` | Typed TS module — `NIFTY_200`, `NIFTY_200_SYMBOLS`, `NIFTY_200_BY_SYMBOL`, `NIFTY_200_BY_SECTOR`, `isNifty200Symbol()`, `toYahooTicker()` |
| `nifty200.json` | Full records with metadata envelope (`index`, `source`, `asOf`, `count`, `constituents`) |
| `symbols.json` | Flat array of the 200 NSE trading symbols |
| `ind_nifty200list.csv` | Raw NSE snapshot, unmodified |
| `generate.mjs` | Regenerates every file above from NSE |

Each record: `{ symbol, name, sector, series, isin }` — e.g.

```json
{ "symbol": "RELIANCE", "name": "Reliance Industries Ltd.", "sector": "Oil Gas & Consumable Fuels", "series": "EQ", "isin": "INE002A01018" }
```

## Usage

```ts
import { NIFTY_200_SYMBOLS, NIFTY_200_BY_SYMBOL, isNifty200Symbol } from '../MO1-200/nifty200';

NIFTY_200_SYMBOLS.length;                  // 200
NIFTY_200_BY_SYMBOL['TCS'].sector;         // "Information Technology"
isNifty200Symbol('hdfcbank');              // true (case-insensitive)
```

```js
const symbols = require('./MO1-200/symbols.json'); // ["360ONE", "ABB", ...]
```

## Refreshing

NSE rebalances the index semi-annually (effective end of March and September), so re-run
after each rebalance:

```bash
node generate.mjs             # re-download from NSE, rewrite CSV + JSON + TS
node generate.mjs --offline   # rebuild JSON + TS from the local CSV only
```

The script fails loudly if the list isn't exactly 200 unique symbols.

- Source: <https://nsearchives.nseindia.com/content/indices/ind_nifty200list.csv>
- Snapshot taken: **2026-08-27**

## Notes

- Symbols are NSE cash-market trading symbols; a few carry punctuation (`M&M`, `M&MFIN`, `BAJAJ-AUTO`) — keep them verbatim when building API requests.
- All 200 are series `EQ`.
- For Yahoo Finance / `yfinance`, suffix `.NS` (`toYahooTicker`).
