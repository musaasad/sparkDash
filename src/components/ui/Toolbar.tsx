import type { ReactNode } from "react";

/**
 * Toolbar Row1: entity tabs / search left, ghost utilities + filters middle,
 * one accent primary right. 40px tall, 12px gap to the table.
 */
export function Toolbar({
  search,
  filters,
  primary,
  utilities,
  role = "search",
}: {
  search?: ReactNode;
  filters?: ReactNode;
  primary?: ReactNode;
  utilities?: ReactNode;
  role?: string;
}) {
  return (
    <div className="cp-toolbar" role={role}>
      {search ? <div className="cp-toolbar-search">{search}</div> : null}
      {filters ? <div className="cp-toolbar-filters">{filters}</div> : null}
      {utilities ? <div className="cp-toolbar-utilities">{utilities}</div> : null}
      {primary ? <div className="cp-toolbar-primary">{primary}</div> : null}
    </div>
  );
}

/** Density toggle affordance: comfortable (36px) / dense (32px) icon pair. */
export function DensityToggle({
  dense,
  onChange,
}: {
  dense: boolean;
  onChange: (dense: boolean) => void;
}) {
  return (
    <div className="cp-density" role="group" aria-label="Row density">
      <button
        type="button"
        className="cp-btn ghost icon"
        aria-pressed={!dense}
        title="Comfortable rows"
        onClick={() => onChange(false)}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <path d="M1 3h12M1 7h12M1 11h12" />
        </svg>
      </button>
      <button
        type="button"
        className="cp-btn ghost icon"
        aria-pressed={dense}
        title="Dense rows"
        onClick={() => onChange(true)}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <path d="M1 2.5h12M1 5.5h12M1 8.5h12M1 11.5h12" />
        </svg>
      </button>
    </div>
  );
}
