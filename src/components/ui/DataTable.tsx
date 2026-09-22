import type { ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: "left" | "right";
  /** Monospace tabular cell. */
  mono?: boolean;
  muted?: boolean;
  sortable?: boolean;
  sortValue?: (row: T) => number | string;
  width?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
  /** Controlled sort state. */
  sortKey?: string | null;
  sortDir?: "asc" | "desc";
  onSort?: (key: string) => void;
  ariaLabel?: string;
}

/**
 * Ops-grade data table: uppercase column headers, tabular numerals, right-aligned
 * numeric columns, real <th scope> semantics, optional sortable headers with
 * aria-sort, clickable rows. Status/color is the caller's cell content.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty,
  sortKey,
  sortDir,
  onSort,
  ariaLabel,
}: DataTableProps<T>) {
  return (
    <div className="cp-table-wrap">
      <table className="cp-table" aria-label={ariaLabel}>
        <thead>
          <tr>
            {columns.map((col) => {
              const isSorted = sortKey === col.key;
              return (
                <th
                  key={col.key}
                  scope="col"
                  style={{ textAlign: col.align ?? "left", width: col.width }}
                  aria-sort={isSorted ? (sortDir === "asc" ? "ascending" : "descending") : undefined}
                >
                  {col.sortable && onSort ? (
                    <button
                      type="button"
                      className="cp-sort-head"
                      onClick={() => onSort(col.key)}
                      style={{
                        all: "unset",
                        cursor: "pointer",
                        display: "inline-flex",
                        gap: 4,
                        alignItems: "center",
                        font: "inherit",
                        color: "inherit",
                      }}
                    >
                      {col.header}
                      <span
                        aria-hidden="true"
                        className="cp-sort-caret"
                        data-sorted={isSorted ? (sortDir === "asc" ? "asc" : "desc") : undefined}
                        style={{ opacity: isSorted ? 1 : 0 }}
                      >
                        {isSorted && sortDir === "desc" ? "▼" : "▲"}
                      </span>
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length}>
                {empty ?? <div className="cp-table-empty">No data</div>}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                className={onRowClick ? "clickable" : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === "Enter") onRowClick(row);
                      }
                    : undefined
                }
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={[
                      col.align === "right" ? "num" : "",
                      col.mono ? "mono" : "",
                      col.muted ? "muted" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Generic client-side sort helper honoring column sortValue. */
export function sortRows<T>(rows: T[], col: Column<T> | undefined, dir: "asc" | "desc"): T[] {
  if (!col?.sortValue) return rows;
  const sv = col.sortValue;
  return [...rows].sort((a, b) => {
    const va = sv(a);
    const vb = sv(b);
    if (va < vb) return dir === "asc" ? -1 : 1;
    if (va > vb) return dir === "asc" ? 1 : -1;
    return 0;
  });
}