import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Free-float inputs for index weighting, derived from the screener snapshots.
 *
 * Server-only — reads the per-company JSONs. The desk page is statically
 * prerendered, so all 200 files are parsed once at build time (~27ms) and the
 * result ships to the browser as a prop. No extra pipeline step to remember.
 */
export interface FloatFactor {
  /** Shares outstanding, in crore, exactly as screener reports it. */
  shares: number;
  /** Fraction of the book that is not promoter-held, 0 to 1. */
  float: number;
  /** Latest promoter stake as a percentage, kept for display. */
  promoterPct: number | null;
}

export type FloatTable = Record<string, FloatFactor>;

type ShareholdingSeries = {
  rows?: Record<string, (number | null)[]>;
};

function latestPromoterPct(shareholding: ShareholdingSeries | undefined): number | null {
  const promoters = shareholding?.rows?.Promoters;
  if (!Array.isArray(promoters)) return null;
  // Newest period is last, but the tail can be null when a filing is pending.
  for (let i = promoters.length - 1; i >= 0; i -= 1) {
    const value = promoters[i];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

export async function loadFloatTable(symbols: string[]): Promise<FloatTable> {
  const dir = path.join(process.cwd(), "public", "data", "companies");
  const table: FloatTable = {};

  await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const raw = await readFile(path.join(dir, `${symbol}.json`), "utf8");
        const detail = JSON.parse(raw) as {
          shares?: number;
          series?: { shareholding?: ShareholdingSeries };
        };

        const shares = detail.shares;
        if (typeof shares !== "number" || !Number.isFinite(shares) || shares <= 0) return;

        const promoterPct = latestPromoterPct(detail.series?.shareholding);

        // An absent Promoters row is not missing data — ICICIBANK, ITC, SWIGGY
        // and six others genuinely have no promoter, so the whole book floats.
        const float =
          promoterPct == null ? 1 : Math.min(1, Math.max(0, 1 - promoterPct / 100));

        table[symbol] = { shares, float, promoterPct };
      } catch {
        // A symbol with no company file simply carries no index weight.
      }
    })
  );

  return table;
}
