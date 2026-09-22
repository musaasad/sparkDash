import type { SparkSnapshot, DeploymentStatus, RecipePublic } from "../../api/types";
import { isWorkerSpark } from "../../api/sparkRole";

export interface FleetHealth {
  nodesOnline: number;
  nodesTotal: number;
  modelsRunning: number;
  modelsLoading: number;
  activeAlerts: number;
  fleetDecodeTps: number;
}

export interface FleetAlert {
  id: string;
  severity: "error" | "warn" | "info";
  message: string;
  target?: { section: "node"; nodeId: string } | { section: "model"; modelId: string };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Fleet-wide health rollup for the Overview strip. */
export function computeFleetHealth(
  sparks: SparkSnapshot[],
  deployments: readonly DeploymentStatus[]
): FleetHealth {
  const nodesOnline = sparks.filter((s) => s.online).length;
  let modelsRunning = 0;
  let modelsLoading = 0;
  for (const d of deployments) {
    if (d.state === "running") modelsRunning++;
    else if (d.state === "starting" || d.state === "loading") modelsLoading++;
  }
  let fleetDecodeTps = 0;
  for (const s of sparks) {
    for (const llm of s.metrics?.llm || []) {
      if (llm.available && isNum(llm.generationTps)) fleetDecodeTps += llm.generationTps;
    }
  }
  const alerts = computeFleetAlerts(sparks, deployments);
  return {
    nodesOnline,
    nodesTotal: sparks.length,
    modelsRunning,
    modelsLoading,
    activeAlerts: alerts.length,
    fleetDecodeTps: Math.round(fleetDecodeTps),
  };
}

/** Exceptions-first alert list: offline nodes, thermal, disk, model errors. */
export function computeFleetAlerts(
  sparks: SparkSnapshot[],
  deployments: readonly DeploymentStatus[]
): FleetAlert[] {
  const alerts: FleetAlert[] = [];
  for (const s of sparks) {
    if (!s.online) {
      alerts.push({ id: `${s.id}-offline`, severity: "error", message: `${s.name} is offline`, target: { section: "node", nodeId: s.id } });
      continue;
    }
    const gpu = s.metrics?.gpu;
    if (gpu?.throttle?.active) {
      alerts.push({ id: `${s.id}-throttle`, severity: "warn", message: `${s.name}: GPU throttling (${gpu.throttle.reason})`, target: { section: "node", nodeId: s.id } });
    }
    if (gpu && isNum(gpu.temperature) && gpu.temperature >= 90) {
      alerts.push({ id: `${s.id}-temp`, severity: "warn", message: `${s.name}: GPU ${Math.round(gpu.temperature)}°C`, target: { section: "node", nodeId: s.id } });
    }
    const um = s.metrics?.unifiedMemory;
    if (um?.oomRisk === "high") {
      alerts.push({ id: `${s.id}-oom`, severity: "warn", message: `${s.name}: unified memory pressure high`, target: { section: "node", nodeId: s.id } });
    }
    for (const st of s.metrics?.storage || []) {
      if (!st.disabled && st.percentage >= 90) {
        alerts.push({ id: `${s.id}-disk-${st.device}`, severity: "warn", message: `${s.name}: ${st.label || st.device} at ${Math.round(st.percentage)}% full`, target: { section: "node", nodeId: s.id } });
      }
    }
  }
  for (const d of deployments) {
    if (d.state === "error") {
      alerts.push({ id: `${d.recipeId}-err`, severity: "error", message: `Deployment ${d.recipeId} is in error`, target: { section: "model", modelId: d.modelId } });
    }
  }
  return alerts;
}

/** Non-worker nodes (heads + standalone) for the primary fleet table. */
export function primaryNodes(sparks: SparkSnapshot[]): SparkSnapshot[] {
  return sparks.filter((s) => !isWorkerSpark(s));
}

export function workersOf(sparks: SparkSnapshot[], headId: string): SparkSnapshot[] {
  return sparks.filter((s) => isWorkerSpark(s) && (s.workerHeadId === headId || !s.workerHeadId));
}

/** Recipes deployed on a given node. */
export function recipesOnNode(recipes: readonly RecipePublic[], nodeId: string): RecipePublic[] {
  return recipes.filter((r) => (r.nodeIds || []).includes(nodeId) && !r.archived);
}

export function fmtUptime(seconds: number | null): string {
  if (seconds == null) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}