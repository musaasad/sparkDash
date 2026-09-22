import type { SparkSnapshot, DeploymentStatus, DeploymentDisplay, RecipePublic, ModelEntry, ActivityEvent } from "../../api/types";
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
  /** Condition kind (`offline`, `temp`, `disk`, `degraded`, …) — digest key. */
  condition?: string;
  /** Affected resource (node id / deployment recipe id) — digest key. */
  resourceId?: string;
  target?: { section: "node"; nodeId: string } | { section: "model"; modelId: string };
}

/** One collapsed attention row: same condition + resource, with an ×N badge. */
export interface AttentionItem {
  id: string;
  severity: "error" | "warn" | "info";
  message: string;
  count: number;
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
    if (d.display === "running" || d.display === "running-external") modelsRunning++;
    else if (d.display === "starting" || d.display === "loading") modelsLoading++;
    else if (d.display === "degraded") modelsError++;
    else if (d.display === "stopped") modelsStopped++;
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
      alerts.push({ id: `${s.id}-offline`, severity: "error", condition: "offline", resourceId: s.id, message: `${s.name} is offline`, target: { section: "node", nodeId: s.id } });
      continue;
    }
    const gpu = s.metrics?.gpu;
    if (gpu?.throttle?.active) {
      alerts.push({ id: `${s.id}-throttle`, severity: "warn", condition: "throttle", resourceId: s.id, message: `${s.name}: GPU throttling (${gpu.throttle.reason})`, target: { section: "node", nodeId: s.id } });
    }
    if (gpu && isNum(gpu.temperature) && gpu.temperature >= 90) {
      alerts.push({ id: `${s.id}-temp`, severity: "warn", condition: "temp", resourceId: s.id, message: `${s.name}: GPU ${Math.round(gpu.temperature)}°C`, target: { section: "node", nodeId: s.id } });
    }
    for (const st of s.metrics?.storage || []) {
      if (!st.disabled && st.percentage >= 90) {
        alerts.push({ id: `${s.id}-disk-${st.device}`, severity: "warn", condition: "disk", resourceId: s.id, message: `${s.name}: ${st.label || st.device} at ${Math.round(st.percentage)}% full`, target: { section: "node", nodeId: s.id } });
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
      condition: "oom",
      resourceId: "fleet",
      message: `Unified memory pressure high — ${names}`,
      target: routeFor(pressure.map((s) => s.id)),
    });
  }

  for (const d of deployments) {
    const name = friendlyName(d.modelId, models);
    if (d.display === "degraded") {
      alerts.push({ id: `${d.recipeId}-degraded`, severity: "error", condition: "degraded", resourceId: d.recipeId, message: `${name} deployment is degraded`, target: { section: "model", modelId: d.modelId } });
    } else if (d.display === "expected-not-detected") {
      alerts.push({
        id: `${d.recipeId}-expected`,
        severity: "warn",
        condition: "expected",
        resourceId: d.recipeId,
        message: `${name} is expected but not detected`,
        target: { section: "model", modelId: d.modelId },
      });
    } else if (d.display === "stopped") {
      const intent = d.managedBy === "sparkdash" || !!d.lastError;
      alerts.push({
        id: `${d.recipeId}-stopped`,
        severity: intent ? "warn" : "info",
        condition: "stopped",
        resourceId: d.recipeId,
        message: d.lastError ? `${name} stopped — ${d.lastError}` : `${name} is stopped`,
        target: { section: "model", modelId: d.modelId },
      });
    }
  }
  return alerts;
}

/**
 * Attention digest: collapse alerts sharing a condition + resource into ONE row
 * with an ×N badge, destructive-severity-first. Keeps the Overview queue terse
 * when one node has several disks or one model raises several conditions.
 */
export function attentionDigest(
  sparks: SparkSnapshot[],
  deployments: readonly DeploymentStatus[],
  models: readonly ModelEntry[] = []
): AttentionItem[] {
  const order = { error: 0, warn: 1, info: 2 } as const;
  const groups = new Map<string, AttentionItem>();
  for (const a of computeFleetAlerts(sparks, deployments, models)) {
    const key = `${a.condition ?? "general"}:${a.resourceId ?? a.id}`;
    const hit = groups.get(key);
    if (hit) {
      hit.count++;
      continue;
    }
    groups.set(key, { id: key, severity: a.severity, message: a.message, count: 1, target: a.target });
  }
  return [...groups.values()].sort((a, b) => order[a.severity] - order[b.severity]);
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

// ─── Counted status tabs + filters (commercial polish) ────

export interface StatusTab {
  key: string;
  label: string;
  /** Deployment display states this tab counts/keeps. */
  displays: DeploymentDisplay[];
}

/** Fixed counted-tab grammar for the deployment list (no repeated status column). */
export const DEPLOYMENT_TABS: StatusTab[] = [
  { key: "all", label: "All", displays: [] },
  { key: "running", label: "Running", displays: ["running", "running-external"] },
  { key: "starting", label: "Starting", displays: ["starting", "loading", "stopping"] },
  { key: "attention", label: "Degraded", displays: ["degraded", "expected-not-detected"] },
  { key: "stopped", label: "Stopped", displays: ["stopped", "available"] },
];

export function deploymentTabCounts(deployments: readonly DeploymentStatus[]): { key: string; label: string; count: number }[] {
  return DEPLOYMENT_TABS.map((t) => ({
    key: t.key,
    label: t.label,
    count: t.key === "all" ? deployments.length : deployments.filter((d) => t.displays.includes(d.display)).length,
  }));
}

export function deploymentMatchesTab(d: DeploymentStatus, key: string): boolean {
  if (key === "all") return true;
  const t = DEPLOYMENT_TABS.find((x) => x.key === key);
  return t ? t.displays.includes(d.display) : true;
}

/** True for rows that must expand inline with logs + a remediation link. */
export function isErrorRow(d: DeploymentStatus): boolean {
  return d.display === "degraded" || d.display === "expected-not-detected" || !!d.lastError;
}

/** Relative age for list rows ("12m ago"). */
export function relativeAge(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function fmtAgeFromISO(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? relativeAge(at, now) : "—";
}

/** Last log lines for an error row from client-side activity, filtered to a recipe/model. */
export function errorLogLines(
  activity: readonly ActivityEvent[],
  needles: readonly string[],
  limit = 10
): ActivityEvent[] {
  const set = needles.filter(Boolean);
  return activity.filter((e) => set.some((n) => (e.subject || "").includes(n) || (e.meta ? JSON.stringify(e.meta).includes(n) : false))).slice(0, limit);
}

// ─── Fleet aggregate rail ─────────────────────────────────

export interface NodeRailItem {
  key: string;
  label: string;
  count: number;
  tone: "ok" | "warn" | "muted";
}

/**
 * Nodes that belong in the "attention" bucket: offline, or throttling /
 * over-temperature / near-full disk, or hosting a degraded / expected-but-missing
 * deployment. One source shared by the rail count AND the row filter so they
 * can never disagree.
 */
export function attentionNodeIds(
  sparks: SparkSnapshot[],
  deployments: readonly DeploymentStatus[],
  models: readonly ModelEntry[] = []
): Set<string> {
  const out = new Set<string>();
  for (const s of sparks) {
    if (!s.online) {
      out.add(s.id);
      continue;
    }
    const gpu = s.metrics?.gpu;
    if (gpu?.throttle?.active || (gpu && isNum(gpu.temperature) && gpu.temperature >= 90)) {
      out.add(s.id);
      continue;
    }
    if ((s.metrics?.storage || []).some((st) => !st.disabled && st.percentage >= 90)) out.add(s.id);
  }
  const depConditions = new Set(
    computeFleetAlerts([], deployments, models)
      .filter((a) => a.condition === "degraded" || a.condition === "expected")
      .map((a) => a.resourceId)
  );
  for (const d of deployments) {
    if (depConditions.has(d.recipeId)) for (const id of d.nodeIds) out.add(id);
  }
  return out;
}

/** Clickable health rail buckets beside the fleet table. */
export function nodeHealthRail(
  sparks: SparkSnapshot[],
  deployments: readonly DeploymentStatus[],
  models: readonly ModelEntry[] = []
): NodeRailItem[] {
  const online = sparks.filter((s) => s.online).length;
  const offline = sparks.length - online;
  const running = deployments.filter((d) => d.display === "running" || d.display === "running-external").length;
  const attention = attentionNodeIds(sparks, deployments, models).size;
  const items: NodeRailItem[] = [
    { key: "all", label: "Nodes", count: sparks.length, tone: "muted" },
    { key: "online", label: "Online", count: online, tone: "ok" },
    { key: "offline", label: "Offline", count: offline, tone: offline > 0 ? "warn" : "muted" },
    { key: "running", label: "Running deployments", count: running, tone: "ok" },
  ];
  // Hide the attention bucket when empty (the toolbar does the same).
  if (attention > 0) items.push({ key: "attention", label: "Open alerts", count: attention, tone: "warn" });
  return items;
}

export function nodeMatchesRail(
  s: SparkSnapshot,
  key: string,
  deployments: readonly DeploymentStatus[] = [],
  models: readonly ModelEntry[] = []
): boolean {
  if (key === "all") return true;
  if (key === "online") return s.online;
  if (key === "offline") return !s.online;
  if (key === "running") return s.metrics?.llm?.some((l) => l.available) ?? false;
  if (key === "attention") return attentionNodeIds([s], deployments, models).has(s.id);
  return true;
}

// ─── Model catalog grouping ───────────────────────────────

/** Deterministic two-letter monogram for a model name. */
export function modelGlyph(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export interface FamilyGroup {
  family: string;
  models: ModelEntry[];
  variantCount: number;
  deployedCount: number;
}

/** Catalog grouped by family; unknown family falls into a muted bucket last. */
export function familyGroups(models: readonly ModelEntry[], deployments: readonly DeploymentStatus[]): FamilyGroup[] {
  const groups = new Map<string, ModelEntry[]>();
  for (const m of models) {
    const fam = (m.family || "").trim() || "Other";
    const bucket = groups.get(fam) ?? [];
    bucket.push(m);
    groups.set(fam, bucket);
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] === "Other" ? 1 : b[0] === "Other" ? -1 : a[0].localeCompare(b[0])))
    .map(([family, list]) => ({
      family,
      models: list,
      variantCount: list.length,
      deployedCount: list.filter((m) => deployments.some((d) => d.modelId === m.id)).length,
    }));
}

// ─── External runtime read-only connect ───────────────────

export interface ExternalConnect {
  endpoint: string;
  hasKey: boolean;
  nodeNames: string[];
  note: string;
}

/** Human runtime name for externally-managed copy (custom → its launcher). */
const RUNTIME_LABELS: Record<string, string> = {
  vllm: "vLLM",
  "tabbyapi-exl3": "TabbyAPI",
  sglang: "SGLang",
  "llama.cpp": "llama.cpp",
};

export function runtimeLabel(runtime: string | null | undefined): string {
  if (!runtime || runtime === "custom") return "its launcher";
  return RUNTIME_LABELS[runtime] ?? runtime;
}

/**
 * Read-only connection details for an externally launched runtime (e.g. the
 * never-touch Qwen/TabbyAPI process). Lifecycle stays disabled.
 */
export function externalConnectView(
  d: DeploymentStatus,
  recipe: RecipePublic | null,
  sparks: SparkSnapshot[]
): ExternalConnect | null {
  if (d.managedBy !== "external") return null;
  const node = sparks.find((s) => d.nodeIds.includes(s.id));
  const host = node?.lanIp ?? d.nodeIds[0] ?? "localhost";
  return {
    endpoint: `http://${host}:${d.apiPort}/v1`,
    hasKey: !!recipe?.env.some((e) => e.secret && (e.hasValue ?? !!e.value)),
    nodeNames: d.nodeIds.map((id) => sparks.find((s) => s.id === id)?.name ?? id),
    note: `Launched outside SparkDash — manage via ${runtimeLabel(recipe?.runtime)}`,
  };
}

