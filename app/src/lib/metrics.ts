import { fmtCrore, fmtPct, fmtPrice, fmtRatio, fmtSignedPct } from "./format";
import type { LiveRow, MetricKey, SortKey } from "./types";

export interface MetricDef {
  key: MetricKey;
  label: string;
  fmt: (v: number | null) => string;
}

/**
 * "Highest valuation" is ambiguous between biggest and most expensive, so the
 * leader strip exposes both readings rather than picking one.
 */
export const LEADER_METRICS: MetricDef[] = [
  { key: "mcap", label: "Market cap", fmt: fmtCrore },
  { key: "pe", label: "P/E", fmt: fmtRatio },
  { key: "pb", label: "P/B", fmt: fmtRatio },
  { key: "evEbitda", label: "EV/EBITDA", fmt: fmtRatio },
  { key: "dy", label: "Div yield", fmt: fmtPct },
];

export interface ColumnDef {
  key: SortKey;
  label: string;
  kind: "symbol" | "name" | "due" | "number" | "price" | "chg";
  fmt?: (v: number | null) => string;
  /** Ascending feels natural for text and dates, descending for magnitudes. */
  defaultDir: 1 | -1;
}

export const COLUMNS: ColumnDef[] = [
  { key: "symbol", label: "Symbol", kind: "symbol", defaultDir: 1 },
  { key: "name", label: "Company", kind: "name", defaultDir: 1 },
  { key: "price", label: "Price", kind: "price", fmt: fmtPrice, defaultDir: -1 },
  { key: "chg", label: "Δ%", kind: "chg", fmt: fmtSignedPct, defaultDir: -1 },
  { key: "mcap", label: "Mkt cap", kind: "number", fmt: fmtCrore, defaultDir: -1 },
  { key: "pe", label: "P/E", kind: "number", fmt: fmtRatio, defaultDir: -1 },
  { key: "pb", label: "P/B", kind: "number", fmt: fmtRatio, defaultDir: -1 },
  { key: "ps", label: "P/S", kind: "number", fmt: fmtRatio, defaultDir: -1 },
  { key: "evEbitda", label: "EV/EBITDA", kind: "number", fmt: fmtRatio, defaultDir: -1 },
  { key: "dy", label: "Div yld", kind: "number", fmt: fmtPct, defaultDir: -1 },
  { key: "roce", label: "ROCE", kind: "number", fmt: fmtPct, defaultDir: -1 },
  { key: "roe", label: "ROE", kind: "number", fmt: fmtPct, defaultDir: -1 },
  { key: "due", label: "Next result", kind: "due", defaultDir: 1 },
];

export function sortCompanies(list: LiveRow[], key: SortKey, dir: 1 | -1): LiveRow[] {
  return [...list].sort((a, b) => {
    if (key === "symbol") return a.symbol.localeCompare(b.symbol) * dir;
    if (key === "name") return a.name.localeCompare(b.name) * dir;
    if (key === "due") {
      const av = a.resultsDate ?? a.resultsDueBy ?? "9999-12-31";
      const bv = b.resultsDate ?? b.resultsDueBy ?? "9999-12-31";
      return av.localeCompare(bv) * dir;
    }
    const av = a[key];
    const bv = b[key];
    // Missing values always sink, whichever way the column is sorted — otherwise
    // reversing a sort fills the top with blanks.
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av - bv) * dir;
  });
}
