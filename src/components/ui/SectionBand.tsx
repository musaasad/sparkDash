import type { ReactNode } from "react";

/**
 * Full-bleed dashboard section header: 36px surfaceSecondary band, 16px icon +
 * 13px/600 title, right-aligned LOCAL filter (each section filters
 * independently). Sits above a hairline table/container.
 */
export function SectionBand({
  icon,
  title,
  count,
  local,
  actions,
  bleed = true,
}: {
  icon?: ReactNode;
  title: string;
  /** Muted numeral suffix, never a pill. */
  count?: number | string;
  /** Right-aligned local filter (e.g. a window picker). */
  local?: ReactNode;
  /** Secondary right-side affordances, after the local filter. */
  actions?: ReactNode;
  /** Remove the container's horizontal radius so the band bleeds to edges. */
  bleed?: boolean;
}) {
  return (
    <div className="cp-section-band" data-bleed={bleed ? "true" : undefined}>
      {icon ? (
        <span className="cp-section-band-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <h2 className="cp-section-band-title">
        {title}
        {count != null && count !== "" ? <span className="cp-section-band-count"> {count}</span> : null}
      </h2>
      {local ? <div className="cp-section-band-local">{local}</div> : null}
      {actions ? <div className="cp-section-band-actions">{actions}</div> : null}
    </div>
  );
}
