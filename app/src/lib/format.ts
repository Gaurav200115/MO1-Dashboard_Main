/**
 * One formatting rule per unit, used everywhere so the whole desk reads
 * consistently. Indian digit grouping throughout — 3,36,304 not 336,304.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const DASH = "—";

export function grouped(v: number, dp = 0): string {
  return v.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function fmtCrore(v: number | null | undefined): string {
  return v == null ? DASH : `₹${grouped(Math.round(v))} Cr`;
}

/**
 * Always two decimals. NSE quotes in paise and most tick sizes are ₹0.05, so
 * rounding to whole rupees would hide real movement on the live feed — a stock
 * ticking 1,42,350.05 → 1,42,350.60 would look frozen.
 */
export function fmtPrice(v: number | null | undefined): string {
  return v == null ? DASH : `₹${grouped(v, 2)}`;
}

export function fmtRatio(v: number | null | undefined): string {
  return v == null ? DASH : grouped(v, 2);
}

export function fmtPct(v: number | null | undefined): string {
  return v == null ? DASH : `${grouped(v, 2)}%`;
}

/** Day change always carries its sign, so a flat tape reads as +0.00% not 0.00%. */
export function fmtSignedPct(v: number | null | undefined): string {
  if (v == null) return DASH;
  return `${v >= 0 ? "+" : "−"}${grouped(Math.abs(v), 2)}%`;
}

/** "2026-06" -> "Jun 2026"; "TTM" passes through. */
export function fmtPeriod(p: string | null | undefined): string {
  if (!p) return DASH;
  if (p === "TTM") return "TTM";
  const [y, m] = p.split("-");
  const idx = parseInt(m, 10) - 1;
  return MONTHS[idx] ? `${MONTHS[idx]} ${y}` : p;
}

/** Statement cells carry their unit in the line-item label, not the value. */
export function unitForLabel(label: string): "pct" | "rs" | "count" | "cr" {
  if (label.trim().endsWith("%")) return "pct";
  if (label.includes("EPS")) return "rs";
  if (label.includes("Shareholders")) return "count";
  return "cr";
}

export function fmtCell(v: number | null, label: string): string {
  if (v == null) return DASH;
  switch (unitForLabel(label)) {
    case "pct":
      return `${grouped(v, 2)}%`;
    case "rs":
      return `₹${grouped(v, 2)}`;
    case "count":
      return grouped(Math.round(v));
    default:
      return grouped(Math.round(v));
  }
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export type DueTone = "today" | "soon" | "overdue" | "quiet";

export interface DueState {
  tone: DueTone;
  label: string;
  /** True only when a confirmed board-meeting date equals today. */
  confirmed: boolean;
}

/**
 * Results timing. A confirmed NSE board-meeting date wins; absent that we fall
 * back to the statutory filing deadline, which is always derivable.
 */
export function dueState(
  c: { resultsDate: string | null; resultsDueBy: string | null },
  today = todayISO()
): DueState {
  if (c.resultsDate && c.resultsDate === today) {
    return { tone: "today", label: "Reports today", confirmed: true };
  }
  const target = c.resultsDate ?? c.resultsDueBy;
  if (!target) return { tone: "quiet", label: DASH, confirmed: false };

  const days = Math.round((Date.parse(target) - Date.parse(today)) / 86_400_000);
  if (days < 0) {
    return { tone: "overdue", label: `Overdue ${fmtPeriod(target.slice(0, 7))}`, confirmed: !!c.resultsDate };
  }
  const prefix = c.resultsDate ? "" : "Due ";
  return {
    tone: days <= 14 ? "soon" : "quiet",
    label: `${prefix}${fmtPeriod(target.slice(0, 7))} · ${days}d`,
    confirmed: !!c.resultsDate,
  };
}
