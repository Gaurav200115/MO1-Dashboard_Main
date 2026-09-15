import { fmtCell, fmtPeriod } from "@/lib/format";
import type { Statement } from "@/lib/types";

export default function StatementTable({ statement }: { statement: Statement }) {
  const labels = Object.keys(statement.rows);

  return (
    <div className="overflow-x-auto rounded-md border border-line bg-surface">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky left-0 z-[2] whitespace-nowrap border-b border-line bg-surface2 px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-muted"
            >
              Line item
            </th>
            {statement.periods.map((p) => (
              <th
                key={p}
                scope="col"
                className="whitespace-nowrap border-b border-line bg-surface2 px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-[0.08em] text-muted"
              >
                {fmtPeriod(p)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map((label) => (
            <tr key={label} className="hover:bg-surface2">
              <th
                scope="row"
                className="sticky left-0 z-[1] whitespace-nowrap border-b border-line bg-surface px-3 py-2 text-left font-medium text-ink2"
              >
                {label}
              </th>
              {statement.rows[label].map((v, i) => (
                <td
                  key={`${label}-${statement.periods[i]}`}
                  className={`tnum whitespace-nowrap border-b border-line px-3 py-2 text-right font-mono ${
                    v == null ? "text-faint" : ""
                  }`}
                >
                  {fmtCell(v, label)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
