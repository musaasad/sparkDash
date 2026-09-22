import type { ReactNode } from "react";
import type { DeploymentState } from "../../api/types";

/**
 * Lifecycle status primitives for the control plane. Status color lives ONLY on
 * the dot/pill — never on numeric cells. Transitional states (starting/loading)
 * pulse in accent; they never borrow success.
 */

export type StatusKind = DeploymentState | "online" | "offline" | "archived" | "unknown";

const LABELS: Record<string, string> = {
  available: "Available",
  starting: "Starting",
  loading: "Loading",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  error: "Error",
  online: "Online",
  offline: "Offline",
  archived: "Archived",
  unknown: "Unknown",
};

export function statusLabel(kind: StatusKind): string {
  return LABELS[kind] ?? kind;
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
  return (
    <span className={`cp-pill ${status} ${className}`} title={title}>
      <StatusDot status={status} />
      {label ?? statusLabel(status)}
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

export function EmptyState({
  icon,
  title,
  subtitle,
  action,
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="cp-empty">
      {icon ? <div className="cp-empty-icon">{icon}</div> : null}
      <div className="cp-empty-title">{title}</div>
      {subtitle ? <div className="cp-empty-sub">{subtitle}</div> : null}
      {action ? <div style={{ marginTop: 6 }}>{action}</div> : null}
    </div>
  );
}

export function Skeleton({ height = 14, width = "100%", style }: { height?: number; width?: number | string; style?: React.CSSProperties }) {
  return <div className="cp-skeleton" style={{ height, width, ...style }} />;
}