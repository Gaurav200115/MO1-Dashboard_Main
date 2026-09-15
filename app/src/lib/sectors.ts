/**
 * Sector taxonomy for the in-house indices.
 *
 * NSE's own labels are used as-is with one exception: "Financial Services" is 48
 * of the 200 stocks and roughly a third of the universe's free float, with banks
 * alone driving ~62% of it. Left whole, the index is a bank tracker that hides
 * the bank/NBFC divergence the rate cycle produces every year. So it splits in
 * two, and both halves clear the constituent minimum comfortably.
 */

const NSE_FINANCIALS = "Financial Services";

export const SECTOR_BANKS = "Banks";
export const SECTOR_FIN_EX_BANKS = "Financial Services (ex-Banks)";

/**
 * RBI-licensed banks in the Nifty 200. Two judgment calls: AUBANK is in, being a
 * licensed small finance bank; SBICARD is out, being an NBFC that issues cards.
 *
 * Screener's own `isBank` flag is deliberately not used here — it marks *lenders*,
 * so it is true for BAJFINANCE, MUTHOOTFIN, PFC, IRFC and RECLTD too.
 */
export const BANK_SYMBOLS: ReadonlySet<string> = new Set([
  "HDFCBANK",
  "ICICIBANK",
  "SBIN",
  "KOTAKBANK",
  "AXISBANK",
  "INDUSINDBK",
  "FEDERALBNK",
  "AUBANK",
  "IDFCFIRSTB",
  "YESBANK",
  "UNIONBANK",
  "PNB",
  "BANKBARODA",
  "CANBK",
  "INDIANB",
  "BANKINDIA",
]);

/**
 * Below this, a sector index says more about its two largest members than about
 * the sector, so those sectors stay browsable but carry no index.
 */
export const MIN_CONSTITUENTS = 8;

export function effectiveSector(company: { symbol: string; sector: string }): string {
  if (company.sector !== NSE_FINANCIALS) return company.sector;
  return BANK_SYMBOLS.has(company.symbol) ? SECTOR_BANKS : SECTOR_FIN_EX_BANKS;
}

/** Sector -> member symbols, after the financials split. */
export function groupBySector<T extends { symbol: string; sector: string }>(
  companies: T[]
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const company of companies) {
    const sector = effectiveSector(company);
    const bucket = groups.get(sector);
    if (bucket) bucket.push(company);
    else groups.set(sector, [company]);
  }
  return groups;
}
