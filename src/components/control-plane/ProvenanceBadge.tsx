import type { SeedProvenance } from "../../api/types";

export const PROVENANCE_LABEL: Record<SeedProvenance, string> = {
  detected: "Detected",
  probed: "Probed",
  user: "User supplied",
  unknown: "Unknown",
};

/** Dot+word role per docs/DESIGN_LANGCHAIN.md §10 — never color alone. */
const PROVENANCE_TONE: Record<SeedProvenance, string> = {
  detected: "var(--color-success)",
  probed: "var(--color-warning)",
  user: "var(--color-muted-strong)",
  unknown: "var(--color-muted)",
};

interface ProvenanceBadgeProps {
  value: SeedProvenance | undefined;
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
