import type { ReactNode } from "react";
import type { DeploymentDisplay, DeploymentState, RecipeLifecycleState } from "../../api/types";

/**
 * Lifecycle status primitives for the control plane. Status colour lives ONLY on
 * the dot/pill — never on numeric cells. Transitional states (starting/loading/
 * stopping/validating) pulse the DOT only; they never borrow success.
 *
 * Dot + WORD always — never colour alone. The derived DISPLAY vocabulary rides
 * the same primitives: "Running external" is running-green plus a muted
 * "external" suffix chip, and only "Expected · not detected" takes warning.
 */

export type StatusKind =
  | DeploymentState
  | DeploymentDisplay
  | RecipeLifecycleState
  | "online"
  | "offline"
  | "archived"
  | "unknown"
  | "failed"
  | "degraded"
  | "retired"
  | "warning"
  | "validating";

const LABELS: Record<string, string> = {
  available: "Available",
  starting: "Starting",
  loading: "Loading",
  validating: "Validating",
  running: "Running",
  "running-external": "Running",
  "expected-not-detected": "Expected · not detected",
  degraded: "Degraded",
  stopping: "Stopping",
  stopped: "Stopped",
  error: "Error",
  failed: "Failed",
  warning: "Warning",
  online: "Online",
  offline: "Offline",
  retired: "Retired",
  archived: "Archived",
  unknown: "Unknown",
  draft: "Draft",
  validated: "Validated",
  proven: "Proven",
  deprecated: "Deprecated",
};

export function statusLabel(kind: StatusKind): string {
  return LABELS[kind] ?? kind;
}

/** True for the display vocabularies that carry a suffix chip. */
export function statusSuffix(kind: StatusKind): string | null {
  return kind === "running-external" ? "external" : null;
}

export function StatusDot({ status, className = "" }: { status: StatusKind; className?: string }) {
  return <span className={`cp-dot ${status} ${className}`} aria-hidden="true" />;
}

interface StatusPillProps {
  status: StatusKind;
  label?: string;
  className?: string;
  title?: string;
}

export function StatusPill({ status, label, className = "", title }: StatusPillProps) {
  const suffix = statusSuffix(status);
  return (
    <span className={`cp-pill ${status} ${className}`} title={title}>
      <StatusDot status={status} />
      {label ?? statusLabel(status)}
      {suffix ? <span className="cp-pill-suffix">{suffix}</span> : null}
    </span>
  );
}

type ChipTone = "default" | "accent" | "mono";

export function Chip({
  children,
  tone = "default",
  className = "",
  title,
}: {
  children: ReactNode;
  tone?: ChipTone;
  className?: string;
  title?: string;
}) {
  return (
    <span className={`cp-chip ${tone} ${className}`} title={title}>
      {children}
    </span>
  );
}

/** Lifecycle badge — word-first dot+word pill, purple-free neutral palette. */
export function LifecycleBadge({ state, className = "" }: { state: RecipeLifecycleState; className?: string }) {
  return <StatusPill status={state} className={`cp-lifecycle ${className}`} title={`Lifecycle: ${statusLabel(state)}`} />;
}

export function EmptyState({
  icon,
  title,
  subtitle,
  action,
  learnMore,
  variant = "page",
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  action?: ReactNode;
  learnMore?: ReactNode;
  /** `table` = one hairline sentence box (headers/pager stay); page = centered. */
  variant?: "page" | "table";
}) {
  if (variant === "table") {
    return <div className="cp-table-empty-box">{subtitle ?? title}</div>;
  }
  return (
    <div className="cp-empty">
      {icon ? <div className="cp-empty-icon">{icon}</div> : null}
      <div className="cp-empty-title">{title}</div>
      {subtitle ? <div className="cp-empty-sub">{subtitle}</div> : null}
      {action || learnMore ? (
        <div className="cp-empty-cta">
          {action}
          {learnMore}
        </div>
      ) : null}
    </div>
  );
}

export { Skeleton, SkeletonRows } from "./Skeleton";
