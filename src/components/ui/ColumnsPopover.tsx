import { useEffect, useMemo, useRef, useState } from "react";

export interface ColumnDef {
  key: string;
  label: string;
}

/**
 * Right-anchored columns popover (never a modal): search input, "Show all
 * columns" reset, checkbox rows in schema order. Controlled visibility; the
 * caller persists the per-view selection.
 */
export function ColumnsPopover({
  columns,
  visible,
  onChange,
  defaultKeys,
}: {
  columns: ColumnDef[];
  visible: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  /** Keys restored by "Show all columns". */
  defaultKeys?: string[];
}) {
  const [openState, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openState) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [openState]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? columns.filter((c) => c.label.toLowerCase().includes(s)) : columns;
  }, [columns, q]);

  const toggle = (key: string) => {
    const next = new Set(visible);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  };

  return (
    <div className="cp-columns" ref={ref}>
      <button
        type="button"
        className="cp-btn ghost"
        aria-haspopup="true"
        aria-expanded={openState}
        onClick={() => setOpen((o) => !o)}
      >
        Columns
      </button>
      {openState ? (
        <div className="cp-columns-panel" role="group" aria-label="Visible columns">
          <input
            type="search"
            className="cp-columns-search"
            aria-label="Search columns"
            placeholder="Search columns"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button type="button" className="cp-columns-reset" onClick={() => onChange(new Set(defaultKeys ?? columns.map((c) => c.key)))}>
            Show all columns
          </button>
          <div className="cp-columns-list">
            {filtered.map((c) => (
              <label key={c.key} className="cp-columns-row">
                <input type="checkbox" checked={visible.has(c.key)} onChange={() => toggle(c.key)} />
                <span>{c.label}</span>
              </label>
            ))}
            {filtered.length === 0 ? <div className="cp-columns-empty">No columns match.</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
