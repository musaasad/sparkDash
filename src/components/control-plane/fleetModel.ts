import type { SparkSnapshot, DeploymentStatus, RecipePublic, ModelEntry } from "../../api/types";
import { isWorkerSpark } from "../../api/sparkRole";

export interface FleetHealth {
  nodesOnline: number;
  nodesTotal: number;
  modelsRunning: number;
  modelsStopped: number;
  modelsError: number;
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

/** One deployment joined with its recipe + friendly model name + member nodes. */
export interface DeploymentView {
  deployment: DeploymentStatus;
  recipe: RecipePublic | null;
  modelName: string;
  rawModelId: string;
  nodes: SparkSnapshot[];
  runtime: string;
  topology: "single" | "tp2" | "tp3";
  contextLength: number | null;
  port: number;
  decodeTps: number | null;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Friendly registry name for a model id; falls back to the raw id. */
export function friendlyName(modelId: string, models: readonly ModelEntry[] = []): string {
  return models.find((m) => m.id === modelId)?.name ?? modelId;
}

/** Fleet-wide health rollup for the Overview strip. */
export function computeFleetHealth(
  sparks: SparkSnapshot[],
  deployments: readonly DeploymentStatus[]
): FleetHealth {
  const nodesOnline = sparks.filter((s) => s.online).length;
  let modelsRunning = 0;
  let modelsStopped = 0;
  let modelsError = 0;
  let modelsLoading = 0;
  for (const d of deployments) {
    if (d.state === "running") modelsRunning++;
    else if (d.state === "starting" || d.state === "loading") modelsLoading++;
    else if (d.state === "error") modelsError++;
    else if (d.state === "stopped") modelsStopped++;
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
    modelsStopped,
    modelsError,
    modelsLoading,
    activeAlerts: alerts.length,
    fleetDecodeTps: Math.round(fleetDecodeTps),
  };
}

/**
 * Exceptions-first alert list. Node-level conditions are aggregated by kind so a
 * condition shared by several nodes (e.g. memory pressure across a TP2 pair)
 * produces ONE row naming every affected node and targeting the deployment that
 * serves them.
 */
export function computeFleetAlerts(
  sparks: SparkSnapshot[],
  deployments: readonly DeploymentStatus[],
  models: readonly ModelEntry[] = []
): FleetAlert[] {
  const alerts: FleetAlert[] = [];
  const byId = new Map(sparks.map((s) => [s.id, s]));

  /** Route to the deployment serving any of these nodes, else the lone node. */
  const routeFor = (nodeIds: string[]): FleetAlert["target"] => {
    const dep = deployments.find((d) => d.nodeIds.some((id) => nodeIds.includes(id)));
    if (dep) return { section: "model", modelId: dep.modelId };
    if (nodeIds.length === 1) return { section: "node", nodeId: nodeIds[0] };
    return undefined;
  };

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
    for (const st of s.metrics?.storage || []) {
      if (!st.disabled && st.percentage >= 90) {
        alerts.push({ id: `${s.id}-disk-${st.device}`, severity: "warn", message: `${s.name}: ${st.label || st.device} at ${Math.round(st.percentage)}% full`, target: { section: "node", nodeId: s.id } });
      }
    }
  }

  // Aggregate unified-memory pressure across nodes into one condition.
  const pressure = sparks.filter((s) => s.online && s.metrics?.unifiedMemory?.oomRisk === "high");
  if (pressure.length > 0) {
    const names = pressure.map((s) => byId.get(s.id)?.name ?? s.id).join(", ");
    alerts.push({
      id: "oom-pressure",
      severity: "warn",
      message: `Unified memory pressure high — ${names}`,
      target: routeFor(pressure.map((s) => s.id)),
    });
  }

  for (const d of deployments) {
    const name = friendlyName(d.modelId, models);
    if (d.state === "error") {
      alerts.push({ id: `${d.recipeId}-err`, severity: "error", message: `${name} deployment is in error`, target: { section: "model", modelId: d.modelId } });
    } else if (d.state === "stopped") {
      const intent = d.managedBy === "sparkdash" || !!d.lastError;
      alerts.push({
        id: `${d.recipeId}-stopped`,
        severity: intent ? "warn" : "info",
        message: d.lastError ? `${name} stopped — ${d.lastError}` : `${name} is stopped`,
        target: { section: "model", modelId: d.modelId },
      });
    }
  }
  return alerts;
}

/** Non-worker nodes (heads + standalone) for fleet drill-down tables. */
export function primaryNodes(sparks: SparkSnapshot[]): SparkSnapshot[] {
  return sparks.filter((s) => !isWorkerSpark(s));
}

/** Every node, config order, workers included (Overview telemetry table). */
export function allNodes(sparks: SparkSnapshot[]): SparkSnapshot[] {
  return [...sparks];
}

export function workersOf(sparks: SparkSnapshot[], headId: string): SparkSnapshot[] {
  return sparks.filter((s) => isWorkerSpark(s) && (s.workerHeadId === headId || !s.workerHeadId));
}

/** Recipes deployed on a given node. */
export function recipesOnNode(recipes: readonly RecipePublic[], nodeId: string): RecipePublic[] {
  return recipes.filter((r) => (r.nodeIds || []).includes(nodeId) && !r.archived);
}

/** Deployments whose node set includes the given node. */
export function deploymentsForNode(deployments: readonly DeploymentStatus[], nodeId: string): DeploymentStatus[] {
  return deployments.filter((d) => d.nodeIds.includes(nodeId));
}

/** Live generation tok/s for one deployment, matched per-node by apiPort. */
export function deploymentDecodeTps(sparks: SparkSnapshot[], d: DeploymentStatus): number | null {
  let total = 0;
  for (const id of d.nodeIds) {
    const s = sparks.find((x) => x.id === id);
    if (!s) continue;
    const ports = s.llmPorts ?? [];
    const idx = ports.indexOf(d.apiPort);
    // Index-aligned with snapshot.llmPorts (LlmMetrics carries no port field);
    // no fallback match — a wrong-port series would silently misattribute load.
    const llm = idx >= 0 ? s.metrics?.llm?.[idx] : undefined;
    if (llm?.available && isNum(llm.generationTps)) total += llm.generationTps;
  }
  return total > 0 ? Math.round(total) : null;
}

/** Deployment rows joined with recipe, friendly name and member nodes. */
export function deploymentViews(
  sparks: SparkSnapshot[],
  deployments: readonly DeploymentStatus[],
  recipes: readonly RecipePublic[],
  models: readonly ModelEntry[] = []
): DeploymentView[] {
  return deployments.map((deployment) => {
    const recipe = recipes.find((r) => r.id === deployment.recipeId) ?? null;
    return {
      deployment,
      recipe,
      modelName: friendlyName(deployment.modelId, models),
      rawModelId: deployment.modelId,
      nodes: deployment.nodeIds.map((id) => sparks.find((s) => s.id === id)).filter((s): s is SparkSnapshot => !!s),
      runtime: recipe?.runtime ?? "—",
      topology: recipe?.topology ?? (deployment.nodeIds.length > 1 ? "tp2" : "single"),
      contextLength: recipe?.contextLength ?? null,
      port: deployment.apiPort,
      decodeTps: deploymentDecodeTps(sparks, deployment),
    };
  });
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
