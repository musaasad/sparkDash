import type { Route } from "../../hooks/router";

export interface Crumb {
  label: string;
  /** Omit on the last (current) segment. */
  route?: Route;
}

/**
 * 12px breadcrumb, '/' separated, sitting ABOVE the page H1 — never replacing
 * it. Ancestor segments are textSecondary links, the last is textPrimary.
 */
export function Breadcrumb({
  items,
  navigate,
}: {
  items: Crumb[];
  navigate: (route: Route) => void;
}) {
  return (
    <nav className="cp-crumb" aria-label="Breadcrumb">
      {items.map((item, i) => {
        const last = i === items.length - 1;
        return (
          <span key={`${item.label}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            {item.route && !last ? (
              <button type="button" onClick={() => navigate(item.route as Route)}>
                {item.label}
              </button>
            ) : (
              <span className={last ? "cp-crumb-current" : undefined} aria-current={last ? "page" : undefined}>
                {item.label}
              </span>
            )}
            {!last ? <span className="cp-crumb-sep">/</span> : null}
          </span>
        );
      })}
    </nav>
  );
}
