import type { SeedProvenance, ComputeProvenance } from "../../api/types";

/** Union of both provenance vocabularies the badge renders. */
export type AnyProvenance = SeedProvenance | ComputeProvenance;

export const PROVENANCE_LABEL: Record<AnyProvenance, string> = {
  detected: "Detected",
  probed: "Probed",
  user: "User supplied",
  unknown: "Unknown",
  // Compute-local vocabulary (guided Add Compute).
  discovered: "Discovered",
  configured: "Configured",
  inferred: "Inferred",
  manual: "Manual",
};

/** Dot+word role per docs/DESIGN_LANGCHAIN.md §10 — never color alone. */
const PROVENANCE_TONE: Record<AnyProvenance, string> = {
  detected: "var(--color-success)",
  discovered: "var(--color-success)",
  probed: "var(--color-warning)",
  configured: "var(--color-muted-strong)",
  manual: "var(--color-muted-strong)",
  user: "var(--color-muted-strong)",
  inferred: "var(--color-warning)",
  unknown: "var(--color-muted)",
};

interface ProvenanceBadgeProps {
  value: AnyProvenance | undefined;
  className?: string;
  /** Show an inline "confirm" affordance for UNKNOWN values. */
  onConfirm?: () => void;
}

/**
 * Provenance is always visible, never implied. Renders nothing when a field has
 * no provenance (blank form). UNKNOWN carries a confirm affordance so the
 * operator explicitly resolves it before saving.
 */
export function ProvenanceBadge({ value, className = "", onConfirm }: ProvenanceBadgeProps) {
  if (!value) return null;
  const tone = PROVENANCE_TONE[value];
  return (
    <span className={`cp-prov ${value} ${className}`.trim()} style={{ color: tone }} title={`Provenance: ${PROVENANCE_LABEL[value]}`}>
      <span className="cp-prov-dot" style={{ background: tone }} aria-hidden="true" />
      {PROVENANCE_LABEL[value]}
      {value === "unknown" && onConfirm ? (
        <button type="button" className="cp-prov-confirm" onClick={onConfirm}>
          confirm
        </button>
      ) : null}
    </span>
  );
}
