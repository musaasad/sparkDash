import type { DeploymentView } from "./fleetModel";
import type { RecipeTopologyBlock } from "../../api/types";

export interface TopologySummaryProps {
  view: DeploymentView;
  className?: string;
}

const DEGREE_ORDER = ["tp", "pp", "dp", "ep"] as const;

function configuredDegrees(topo: RecipeTopologyBlock | null | undefined): string[] {
  if (!topo) return [];
  return DEGREE_ORDER.filter((k) => {
    const v = topo[k];
    return typeof v === "number" && v > 0;
  }).map((k) => `${k.toUpperCase()}${topo[k]}`);
}

/**
 * Compact one-line topology read from the deployment view:
 *   "TP2 · DGX 1+2" | "Single · DGX 3" | "2 nodes · topology unknown".
 * Degrees are explicit only — node count NEVER becomes a degree.
 */
export function topologySummaryLine(view: DeploymentView): string {
  const degs = configuredDegrees(view.recipe?.topologyBlock);
  const nodeCount = view.deployment.nodeIds.length;
  const names = view.nodes.map((n) => n.name || n.id);
  const nodeLabel = names.join("+") || `${nodeCount} node${nodeCount === 1 ? "" : "s"}`;

  if (degs.length === 0) {
    const unknown = nodeCount > 1 || view.recipe?.topologyBlock?.unknown === true;
    return unknown ? `${nodeCount} nodes · topology unknown` : `Single · ${nodeLabel}`;
  }
  return `${degs.join(" · ")} · ${nodeLabel}`;
}

/**
 * Compact topology chip for cockpit rows, wizard review and deployment detail.
 * Physical fabric stays elsewhere; this renders the DEPLOYMENT topology only.
 */
export function TopologySummary({ view, className = "" }: TopologySummaryProps) {
  const line = topologySummaryLine(view);
  const unknown = line.includes("topology unknown");
  return (
    <span
      className={`cp-chip mono cp-topo-summary ${unknown ? "is-unknown" : ""} ${className}`.trim()}
      style={{ color: unknown ? "var(--color-warning)" : "var(--color-muted)" }}
      title={line}
    >
      {line}
    </span>
  );
}
