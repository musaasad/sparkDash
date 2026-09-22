import { Fragment, type KeyboardEvent, type ReactNode } from "react";

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
  /** Optional element rendered above the table (search-left/filters/primary-right). */
  toolbar?: ReactNode;
  /** Row keys currently expanded inline. */
  expandedKeys?: ReadonlySet<string>;
  /** Render an inline expansion row for an expanded key; null = no row. */
  renderExpanded?: (row: T) => ReactNode;
  /** Dense 32px rows (toolbar density toggle). */
  dense?: boolean;
  /** Extra class per row (e.g. offline dimming). */
  rowClassName?: (row: T) => string;
}

/**
 * Ops-grade data table: uppercase column headers, tabular numerals, right-aligned
 * numeric columns, real <th scope> semantics, optional sortable headers with
 * aria-sort, clickable rows. Status/color is the caller's cell content.
 *
 * Optional toolbar sits above the table; optional expandedKeys/renderExpanded
 * add an inline expansion row under the matching row.
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
  toolbar,
  expandedKeys,
  renderExpanded,
  dense = false,
  rowClassName,
}: DataTableProps<T>) {
  return (
    <>
      {toolbar ? <div className="cp-toolbar">{toolbar}</div> : null}
      <div className="cp-table-wrap">
        <table className="cp-table" aria-label={ariaLabel} data-dense={dense ? "true" : undefined}>
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
                <td colSpan={columns.length} className="cp-empty-cell">
                  {empty ?? <span className="cp-table-empty-box">No data</span>}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const key = rowKey(row);
                const expanded = expandedKeys?.has(key) ?? false;
                const expansion = expanded && renderExpanded ? renderExpanded(row) : null;
                return (
                  <Fragment key={key}>
                    <tr
                      className={[onRowClick ? "clickable" : "", rowClassName?.(row) ?? ""].filter(Boolean).join(" ") || undefined}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                      tabIndex={onRowClick ? 0 : undefined}
                      role={onRowClick ? "button" : undefined}
                      aria-expanded={renderExpanded && expandedKeys ? expanded : undefined}
                      onKeyDown={
                        onRowClick
                          ? (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                onRowClick(row);
                              }
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
                    {expansion ? (
                      <tr className="cp-expanded-row">
                        <td colSpan={columns.length}>{expansion}</td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Middle-truncate a long ID, keeping both ends legible. */
export function truncateMiddle(value: string, keep = 8): string {
  if (value.length <= keep * 2 + 1) return value;
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

/** Mono ID with middle truncation + click-to-copy affordance. */
export function CopyId({ value, className = "" }: { value: string; className?: string }) {
  return (
    <button
      type="button"
      className={`cp-id ${className}`}
      title={`${value} — click to copy`}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(value);
      }}
    >
      <span className="cp-id-text">{truncateMiddle(value)}</span>
      <span className="cp-id-copy" aria-hidden="true">
        ⧉
      </span>
    </button>
  );
}

/** Linked entity as an icon + label chip. */
export function EntityChip({
  icon,
  label,
  title,
  onClick,
}: {
  icon?: ReactNode;
  label: string;
  title?: string;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      {...(onClick ? { type: "button" as const, onClick } : {})}
      className={`cp-entity-chip${onClick ? " is-link" : ""}`}
      title={title}
    >
      {icon ? <span className="cp-entity-chip-icon" aria-hidden="true">{icon}</span> : null}
      {label}
    </Tag>
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

// ─── Counted status tabs ──────────────────────────────────

export interface CountedTab {
  key: string;
  label: string;
  count: number;
}

/**
 * Tally items into a Record keyed by bucket. Pure reducer shared by the
 * Models/Fleet counted tabs so both surfaces agree on the grammar.
 */
export function countBy<T>(items: readonly T[], keyOf: (item: T) => string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = keyOf(item);
    if (k == null) continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/**
 * Roving-tabindex keyboard nav shared by every tablist: ArrowLeft/Right wrap,
 * Home/End jump, focus follows selection.
 */
export function moveTabFocus(
  e: KeyboardEvent<HTMLElement>,
  keys: readonly string[],
  active: string,
  onSelect: (key: string) => void
) {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
  if (keys.length === 0) return;
  e.preventDefault();
  const i = Math.max(0, keys.indexOf(active));
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? keys.length - 1
        : e.key === "ArrowLeft"
          ? (i - 1 + keys.length) % keys.length
          : (i + 1) % keys.length;
  onSelect(keys[next]);
  const tabs = e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]');
  tabs[next]?.focus();
}

/**
 * Generic underlined tab strip with roving tabindex, arrow-key nav and
 * aria-controls wiring. `panelId` names the matching `role="tabpanel"` panels.
 */
export function TabStrip<T extends string>({
  tabs,
  active,
  onSelect,
  ariaLabel,
  panelId,
  className = "cp-tabs",
  tabClassName = "cp-tab",
  titleOf,
}: {
  tabs: readonly T[];
  active: T;
  onSelect: (tab: T) => void;
  ariaLabel?: string;
  panelId?: string;
  className?: string;
  tabClassName?: string;
  titleOf?: (tab: T) => string;
}) {
  return (
    <div className={className} role="tablist" aria-label={ariaLabel} onKeyDown={(e) => moveTabFocus(e, tabs, active, onSelect as (k: string) => void)}>
      {tabs.map((t) => {
        const isActive = t === active;
        return (
          <button
            key={t}
            type="button"
            role="tab"
            id={panelId ? `${panelId}-${t}-tab` : undefined}
            aria-controls={panelId ? `${panelId}-${t}` : undefined}
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            className={`${tabClassName} ${isActive ? "is-active" : ""}`}
            onClick={() => onSelect(t)}
            title={titleOf?.(t)}
          >
            {t}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Counted status tabs. The count replaces a repeated status column; a zero-count
 * bucket still renders so the vocabulary is stable.
 */
export function CountedTabs({
  tabs,
  active,
  onSelect,
  ariaLabel = "Status filters",
  panelId,
}: {
  tabs: CountedTab[];
  active: string;
  onSelect: (key: string) => void;
  ariaLabel?: string;
  /** Optional id of the controlled panel (adds aria-controls). */
  panelId?: string;
}) {
  const keys = tabs.map((t) => t.key);
  return (
    <div
      className="cp-counted-tabs"
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={(e) => moveTabFocus(e, keys, active, onSelect)}
    >
      {tabs.map((t) => {
        const isActive = t.key === active;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={panelId ? `${panelId}-${t.key}-tab` : undefined}
            aria-controls={panelId ? `${panelId}-${t.key}` : undefined}
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            className={`cp-counted-tab ${isActive ? "is-active" : ""}`}
            onClick={() => onSelect(t.key)}
          >
            {t.label}
            <sup className="cp-counted-count" aria-hidden="true">
              {t.count}
            </sup>
          </button>
        );
      })}
    </div>
  );
}
