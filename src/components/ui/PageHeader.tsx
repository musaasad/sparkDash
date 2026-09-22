import type { ReactNode } from "react";

/**
 * Page header grammar: 20px/600 H1 + 13px textSecondary subtitle, with a right
 * action cluster capped at three affordances (ghost icon, outline secondary,
 * one solid accent primary). Extras belong in an overflow menu (onOverflow).
 * Sits UNDER the breadcrumb, never replaces it.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  overflow,
}: {
  title: string;
  subtitle?: string;
  /** ≤3 affordances. */
  actions?: ReactNode;
  /** Extra actions, surfaced through an overflow menu button. */
  overflow?: ReactNode;
}) {
  return (
    <header className="cp-page-head">
      <div className="cp-page-head-text">
        <h1 className="cp-page-h1">{title}</h1>
        {subtitle ? <p className="cp-page-sub">{subtitle}</p> : null}
      </div>
      {actions || overflow ? (
        <div className="cp-page-actions">
          {actions}
          {overflow ? <div className="cp-page-overflow">{overflow}</div> : null}
        </div>
      ) : null}
    </header>
  );
}
