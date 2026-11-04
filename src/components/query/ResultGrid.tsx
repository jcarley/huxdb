import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, TriangleAlert } from "lucide-react";
import type { ResultSet } from "../../lib/types";
import { PAGE_SIZES } from "../../stores/dataEditor";
import { useDataGridPrefs } from "../../stores/dataGridPrefs";
import { BarButton } from "../data/DataEditor";
import { ResizeHandle, SizedTable } from "../data/SizedTable";
import { defaultWidths, fitWidth } from "../data/columnWidths";

/** Tooltips show the whole value, but not one of megabytes. */
const MAX_TITLE = 2000;

function limitMessage(result: ResultSet, rowsAffected: number | null) {
  const kept = `Showing the first ${result.rows.length.toLocaleString()} rows`;
  if (result.cancelledAtLimit) return `${kept}. The statement was cancelled at that limit, so its total is unknown.`;
  return rowsAffected === null ? `${kept}.` : `${kept} of ${rowsAffected.toLocaleString()}.`;
}

/** One statement's rows: read-only, with client-side pages over what was fetched. */
export function ResultGrid({ result, rowsAffected }: { result: ResultSet; rowsAffected: number | null }) {
  const { columns, rows } = result;
  const fontSize = useDataGridPrefs((s) => s.fontSize);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [dragged, setDragged] = useState<Record<number, number>>({});
  const defaults = useMemo(() => defaultWidths(columns, rows, fontSize), [columns, rows, fontSize]);
  const widths = defaults.map((w, i) => dragged[i] ?? w);

  const lastPage = Math.max(0, Math.ceil(rows.length / pageSize) - 1);
  useEffect(() => setPage((p) => Math.min(p, lastPage)), [lastPage]);
  const first = page * pageSize;
  const shown = rows.slice(first, first + pageSize);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {result.truncated && (
        <div role="status" className="alert alert-warning alert-soft mx-2 mt-1 rounded-md py-1 text-sm">
          <TriangleAlert className="size-4" />
          <span>{limitMessage(result, rowsAffected)}</span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto select-text" style={{ fontSize }}>
        <SizedTable widths={widths}>
          <thead className="text-[1em]">
            <tr>
              <th className="sticky left-0 z-[2] border-r border-b border-base-300 bg-base-200" />
              {columns.map((column, i) => (
                <th key={i} title={column} className="relative truncate border-r border-b border-base-300 bg-base-200 px-1.5 py-1 font-semibold text-base-content">
                  {column}
                  <ResizeHandle
                    onResize={(width) => setDragged((d) => ({ ...d, [i]: width }))}
                    onFit={() => setDragged((d) => ({ ...d, [i]: fitWidth(column, rows, i, fontSize) }))}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, r) => (
              <tr key={first + r}>
                <th className="sticky left-0 z-[1] border-r border-b border-base-300 bg-base-200 px-1 py-0 text-right font-normal text-base-content/50 tabular-nums">{first + r + 1}</th>
                {row.map((value, c) => (
                  <td
                    key={c}
                    title={value !== null && value.length <= MAX_TITLE ? value : undefined}
                    className={`truncate border-r border-b border-base-300 px-1.5 py-0.5 font-mono ${value === null ? "text-base-content/40 italic" : ""}`}
                  >
                    {value ?? "(NULL)"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </SizedTable>
        {rows.length === 0 && <p className="p-4 text-center text-sm text-base-content/50">No rows</p>}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1 border-t border-base-300 bg-base-200/50 px-2 py-0.5 text-xs">
        <span className="mr-2 tabular-nums text-base-content/70">
          {rows.length === 0 ? "No rows" : `Rows ${(first + 1).toLocaleString()}–${(first + shown.length).toLocaleString()} of ${rows.length.toLocaleString()}`}
        </span>
        <BarButton icon={ChevronsLeft} label="First Page" disabled={page === 0} onClick={() => setPage(0)} />
        <BarButton icon={ChevronLeft} label="Previous Page" disabled={page === 0} onClick={() => setPage(page - 1)} />
        <span className="tabular-nums">
          {page + 1} / {lastPage + 1}
        </span>
        <BarButton icon={ChevronRight} label="Next Page" disabled={page >= lastPage} onClick={() => setPage(page + 1)} />
        <BarButton icon={ChevronsRight} label="Last Page" disabled={page >= lastPage} onClick={() => setPage(lastPage)} />
        <select
          className="select select-xs w-20"
          aria-label="Rows per page"
          value={pageSize}
          onChange={(e) => {
            setPageSize(Number(e.target.value));
            setPage(0);
          }}
        >
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
