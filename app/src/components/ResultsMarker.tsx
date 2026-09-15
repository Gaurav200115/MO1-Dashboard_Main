import { dueState } from "@/lib/format";
import type { CompanySummary } from "@/lib/types";

const DOT: Record<string, string> = {
  today: "bg-alert animate-report-pulse",
  soon: "bg-alert",
  overdue: "bg-neg",
  quiet: "bg-faint/50",
};

/**
 * Reporting state, shown as colour + motion so it reads before the text does.
 * Amber is reserved for this and nothing else on the desk.
 */
export default function ResultsMarker({
  company,
  today,
}: {
  company: Pick<CompanySummary, "resultsDate" | "resultsDueBy">;
  today?: string;
}) {
  const state = dueState(company, today);
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap ${
        state.tone === "today" ? "font-semibold text-alert" : "text-muted"
      }`}
    >
      <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${DOT[state.tone]}`} aria-hidden />
      {state.label}
    </span>
  );
}
