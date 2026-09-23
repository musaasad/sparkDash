import type { SparkSnapshot, DeploymentStatus, DeploymentDisplay, RecipePublic, RecipeTopology, RecipeLifecycleState, ModelEntry, ActivityEvent, LlmMetrics } from "../../api/types";
import { isWorkerSpark } from "../../api/sparkRole";
import { fleetInventory, primaryAnchorNode, nodeById, workersOf as inventoryWorkersOf } from "../../shared/inventory.js";
import { deriveRuntimeState as canonicalRuntimeState, telemetryQuality, probeOutcome, RUNTIME_STATE, type RuntimeState as CanonicalRuntimeState } from "../../shared/runtimeState.js";
import { nodeThermalLevel, nodeOomEvents, nodeOomEventsRecent, aggregationLegend, thermalLabel } from "./cockpitModel";

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
  /** Stable row key: deployment binding id, recipe id fallback. */
  key: string;
  recipe: RecipePublic | null;
  modelName: string;
  rawModelId: string;
  nodes: SparkSnapshot[];
  runtime: string;
  /** Recipe-declared topology, or null when the recipe carries none. Node count
   *  NEVER fabricates a degree (a 3-node binding is not automatically TP2). */
  topology: RecipeTopology | null;
  /** Recipe lifecycle badge (Draft/Validated/Proven/Deprecated/Archived). */
  lifecycleState: RecipeLifecycleState | null;
  contextLength: number | null;
  port: number;
  decodeTps: number | null;
  /** Normalized live telemetry from the deployment's primary-node LLM probe. */
  telemetry: DeploymentTelemetry | null;
  /** Primary-node uptime in seconds when the snapshot carries it, else null. */
  uptime: number | null;
}

/**
 * Normalized per-deployment telemetry, read from the deployment's PRIMARY-node
 * `spark.metrics.llm` probe (index-matched by `llmPorts` — the same series
 * `deploymentDecodeTps` reads). Every field is null when the probe does not
 * carry it: nothing is ever fabricated. For multi-node (TP2) deployments
 * `generationTps` is the cross-node sum; coordinator-only fields (ttft,
 * requests, kv, slots) come from the primary node.
 */
export interface DeploymentTelemetry {
  /** Summed decode tok/s across all member nodes (null when none report). */
  generationTps: number | null;
  prefillTps: number | null;
  ttftSeconds: number | null;
  requestsRunning: number | null;
  requestsWaiting: number | null;
  /** KV cache usage fraction (0–1). */
  kvCacheUsage: number | null;
  /** Prefix-cache hit rate (0–1). */
  prefixCacheHitRate: number | null;
  /** Speculative/MTP acceptance rate (0–1). */
  mtpAcceptanceRate: number | null;
  contextLength: number | null;
  gpuMemoryUtilization: number | null;
  slotsActive: number | null;
  slotsTotal: number | null;
  /** Cumulative output tokens — the recent-request signal for idle-vs-ready. */
  totalOutputTokens: number | null;
  backend: LlmMetrics["backend"];
  modelId: string | null;
  /**
   * True when ANY member node reports a readable probe (so the aggregate is
   * real). Coordinator-only fields stay null when the PRIMARY anchor is down —
   * the object is marked partial, never nulled away.
   */
  available: boolean;
  /** True when the PRIMARY anchor itself reported (coordinator fields are real). */
  primaryAvailable?: boolean;
  /**
   * Age of the OLDEST reporting member's llm sample (ms), from the snapshot's
   * per-domain `updatedAt`. Feeds the staleness contract; null when unknown.
   */
  telemetryAgeMs?: number | null;
  /** Probe error string when the backend reported one. */
  error: string | null;
  /**
   * Explicit multi-node aggregation legend (null for single-node). MAX/SUM per
   * field so nothing is silently blended.
   */
  aggregation: string | null;
  /** Member nodes whose probe answered (SUM/MAX coverage). */
  membersReporting: number;
  /** Member node names with NO readable probe — named honestly, never treated as 0. */
  membersMissingTelemetry: string[];
}

/** Coarse operational state a deployment row can render (canonical vocabulary). */
export type RuntimeState = CanonicalRuntimeState;

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
    nodesTotal: fleetNodes(sparks).length,
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

  for (const s of sparks) {
    if (!s.online) {
      alerts.push({ id: `${s.id}-offline`, severity: "error", condition: "offline", resourceId: s.id, message: `${s.name} is offline`, target: { section: "node", nodeId: s.id } });
      continue;
    }
    const gpu = s.metrics?.gpu;
    // Thermal is a REAL measured level (provider throttle / NV_ERR_NO_MEMORY /
    // a genuinely high temp) — actionable, so it belongs in the annunciator.
    // Unified-memory UTILISATION is deliberately NOT here (see below).
    const thermal = nodeThermalLevel(s);
    if (thermal !== "normal") {
      const temp = gpu && isNum(gpu.temperature) ? ` ${Math.round(gpu.temperature)}°C` : "";
      alerts.push({
        id: `${s.id}-thermal`,
        severity: "warn",
        condition: "thermal",
        resourceId: s.id,
        message: `${s.name}: thermal ${thermalLabel(thermal).toLowerCase()}${temp}`,
        target: { section: "node", nodeId: s.id },
      });
    }
    for (const st of s.metrics?.storage || []) {
      if (!st.disabled && st.percentage >= 90) {
        alerts.push({ id: `${s.id}-disk-${st.device}`, severity: "warn", condition: "disk", resourceId: s.id, message: `${s.name}: ${st.label || st.device} at ${Math.round(st.percentage)}% full`, target: { section: "node", nodeId: s.id } });
      }
    }
    // GENUINE NEW oom events (kernel NV_ERR_NO_MEMORY) — a real pressure signal,
    // unlike unified-memory utilisation. The kernel counter is cumulative-since-
    // boot, so only a RECENT increase is an active incident; a standing
    // since-boot count with no delta stays informational (see cockpitModel).
    const recentOom = nodeOomEventsRecent(s);
    if (recentOom > 0) {
      const totalOom = nodeOomEvents(s);
      alerts.push({
        id: `${s.id}-oom`,
        severity: "warn",
        condition: "oom",
        resourceId: s.id,
        message: `${s.name}: GPU memory pressure — ${totalOom} NV_ERR_NO_MEMORY event${totalOom === 1 ? "" : "s"} (${recentOom} new since last poll)`,
        target: { section: "node", nodeId: s.id },
      });
    }
  }

  // NOTE: unified-memory `oomRisk` is a high-water UTILISATION proxy (percentage
  // > 85), not a measured pressure signal (no swap thrash / MemAvailable test).
  // High utilisation on a node actively serving a big model is EXPECTED and NOT
  // actionable — so it is NOT raised here. It stays a neutral informational
  // readout on the node instrument ("UNIFIED MEM"). "Pressure" is reserved for
  // the GENUINE oom signal the collector DOES emit (kernel NV_ERR_NO_MEMORY).

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

/**
 * Canonical inventory: EVERY configured/adopted node, config order, workers
 * included. Fleet/Overview/counters all resolve from this. Role collapsing
 * (primaryNodes) may pick a deployment's telemetry anchor but MUST NOT hide a
 * node from the inventory.
 */
export function fleetNodes(sparks: SparkSnapshot[]): SparkSnapshot[] {
  return fleetInventory(sparks);
}

/**
 * Non-worker nodes (heads + standalone). Kept for anchor picking only — the
 * Fleet table uses `fleetNodes` so a worker never disappears.
 */
export function primaryNodes(sparks: SparkSnapshot[]): SparkSnapshot[] {
  return sparks.filter((s) => !isWorkerSpark(s));
}

/** Every node, config order, workers included (canonical inventory alias). */
export function allNodes(sparks: SparkSnapshot[]): SparkSnapshot[] {
  return fleetNodes(sparks);
}

export function workersOf(sparks: SparkSnapshot[], headId: string): SparkSnapshot[] {
  return inventoryWorkersOf(sparks, headId);
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

/** Primary (coordinator) node for a deployment: stable-id anchor over nodeIds. */
export function primaryNodeOf(sparks: SparkSnapshot[], d: DeploymentStatus): SparkSnapshot | null {
  return primaryAnchorNode(sparks, d);
}

export { nodeById, type CanonicalRuntimeState };

/** LLM probe series for one node + port, index-aligned with `llmPorts` (no fallback match). */
function llmForNode(s: SparkSnapshot | null | undefined, apiPort: number): LlmMetrics | undefined {
  if (!s) return undefined;
  const idx = (s.llmPorts ?? []).indexOf(apiPort);
  return idx >= 0 ? s.metrics?.llm?.[idx] : undefined;
}

const optNum = (v: unknown): number | null => (isNum(v) ? v : null);

/** Per-domain age in ms from a snapshot's `updatedAt`, or null when unknown. */
function ageMsFor(s: SparkSnapshot | undefined, domain: string, now = Date.now()): number | null {
  const at = s?.updatedAt?.[domain];
  return isNum(at) ? Math.max(0, now - at) : null;
}

/**
 * Normalized telemetry for one deployment from its PRIMARY-node probe.
 *
 * MULTI-NODE AGGREGATION IS EXPLICIT — never a silent blend:
 *   SUM  generationTps, requestsRunning, requestsWaiting (per-rank load totals)
 *   MAX  kvCacheUsage, gpuMemoryUtilization (worst rank drives pressure)
 *   PRIMARY-only coordinator fields: ttft, prefill, cache-hit rate, MTP,
 *   context, slots, cumulative tokens, backend, modelId.
 * A member node that exposes NO probe series is NAMED (`membersMissingTelemetry`)
 * and excluded from the aggregation — never folded in as 0.
 */
export function deploymentTelemetry(sparks: SparkSnapshot[], d: DeploymentStatus): DeploymentTelemetry | null {
  const primary = primaryNodeOf(sparks, d);
  const llm = llmForNode(primary, d.apiPort);

  let genTotal = 0;
  let genSeen = false;
  let runTotal = 0;
  let runSeen = false;
  let waitTotal = 0;
  let waitSeen = false;
  let kvMax: number | null = null;
  let gpuMax: number | null = null;
  const missing: string[] = [];
  let reporting = 0;
  let ageMax: number | null = null;

  for (const id of d.nodeIds) {
    const node = sparks.find((s) => s.id === id);
    const series = llmForNode(node, d.apiPort);
    if (!series?.available) {
      if (node) missing.push(node.name || node.id);
      continue;
    }
    reporting++;
    const age = ageMsFor(node, "llm");
    if (age != null) ageMax = ageMax == null ? age : Math.max(ageMax, age);
    if (isNum(series.generationTps)) {
      genTotal += series.generationTps;
      genSeen = true;
    }
    if (isNum(series.requestsRunning)) {
      runTotal += series.requestsRunning;
      runSeen = true;
    }
    if (isNum(series.requestsWaiting)) {
      waitTotal += series.requestsWaiting;
      waitSeen = true;
    }
    if (isNum(series.kvCacheUsage)) kvMax = kvMax == null ? series.kvCacheUsage : Math.max(kvMax, series.kvCacheUsage);
    if (isNum(series.gpuMemoryUtilization)) gpuMax = gpuMax == null ? series.gpuMemoryUtilization : Math.max(gpuMax, series.gpuMemoryUtilization);
  }

  if (reporting === 0 && !llm) return null;

  return {
    generationTps: genSeen ? Math.round(genTotal) : null,
    prefillTps: optNum(llm?.prefillTps),
    ttftSeconds: optNum(llm?.ttftSeconds),
    requestsRunning: runSeen ? runTotal : optNum(llm?.requestsRunning),
    requestsWaiting: waitSeen ? waitTotal : optNum(llm?.requestsWaiting),
    kvCacheUsage: kvMax ?? optNum(llm?.kvCacheUsage),
    prefixCacheHitRate: optNum(llm?.prefixCacheHitRate),
    mtpAcceptanceRate: optNum(llm?.mtpAcceptanceRate),
    contextLength: optNum(llm?.contextLength),
    gpuMemoryUtilization: gpuMax ?? optNum(llm?.gpuMemoryUtilization),
    slotsActive: optNum(llm?.slotsActive),
    slotsTotal: optNum(llm?.slotsTotal),
    totalOutputTokens: optNum(llm?.totalOutputTokens),
    backend: llm?.backend ?? null,
    modelId: llm?.modelId ?? null,
    available: reporting > 0,
    primaryAvailable: Boolean(llm?.available),
    telemetryAgeMs: ageMax,
    error: llm?.error ?? null,
    aggregation: aggregationLegend(reporting, d.nodeIds.length),
    membersReporting: reporting,
    membersMissingTelemetry: missing,
  };
}

/** Hard transport failure signatures — only these may read as degraded. */
const HARD_TRANSPORT = /5\d\d|timeout|timed out|refused|econnrefused|abort/i;

/**
 * A healthy OBSERVED state that proves a live process even though SparkDash may
 * not read its metrics: an auth-gated 401/403 endpoint, an externally-launched
 * runtime, or any running-external display. External runtimes are first-class —
 * never "broken"/"degraded" merely because SparkDash did not launch them.
 */
function isObservedHealthyExternal(d: DeploymentStatus): boolean {
  return (
    d.observed === "auth-gated" ||
    d.display === "running-external" ||
    (d.managedBy === "external" && d.observed === "running")
  );
}

/**
 * Derive a coarse operational state from the CANONICAL shared module — one
 * authoritative implementation consumed by every surface.
 *
 * `degraded` is RESERVED for genuinely unhealthy signals: an observed-degraded
 * display, an explicit unhealthy probe, or a MANAGED deployment whose readable
 * probe hard-fails (5xx / timeout / refused). An auth-gated external runtime
 * with no readable metrics is loaded and serving-capable → `ready`/`reachable`.
 * A reachable endpoint with missing OPTIONAL telemetry is NEVER `offline`.
 */
export function deriveRuntimeState(
  d: DeploymentStatus,
  telemetry: DeploymentTelemetry | null,
  opts: { telemetryAgeMs?: number | null; staleMs?: number; reachable?: boolean } = {}
): RuntimeState {
  const healthyExternal = isObservedHealthyExternal(d);
  const probe = probeOutcome({
    available: telemetry?.available === true,
    hasKey: false,
    error: telemetry?.error ?? null,
  });
  const reachable =
    telemetry?.available === true || healthyExternal || probe.reachable || opts.reachable === true;
  return canonicalRuntimeState({
    state: d.state,
    display: d.display,
    observed: d.observed,
    managedBy: d.managedBy,
    // Feed the canonical shape so it can read active/loaded signals itself.
    telemetry: telemetry as unknown as Record<string, unknown> | null,
    telemetryAgeMs: opts.telemetryAgeMs ?? null,
    staleMs: opts.staleMs,
    reachable,
    keyedWithoutKey: probe.keyedWithoutKey,
  });
}

/** Canonical telemetry quality for a deployment's telemetry (FULL/PARTIAL/STALE/ABSENT). */
export function deploymentTelemetryQuality(
  telemetry: DeploymentTelemetry | null,
  telemetryAgeMs: number | null = null
): ReturnType<typeof telemetryQuality> {
  return telemetryQuality(telemetry as unknown as Record<string, unknown> | null, { telemetryAgeMs });
}

export { RUNTIME_STATE };

/** Deployment rows joined with recipe, friendly name and member nodes. */
export function deploymentViews(
  sparks: SparkSnapshot[],
  deployments: readonly DeploymentStatus[],
  recipes: readonly RecipePublic[],
  models: readonly ModelEntry[] = []
): DeploymentView[] {
  return deployments.map((deployment) => {
    const recipe = recipes.find((r) => r.id === deployment.recipeId) ?? null;
    const primary = primaryNodeOf(sparks, deployment);
    return {
      deployment,
      key: deployment.deploymentId ?? deployment.recipeId,
      recipe,
      modelName: friendlyName(deployment.modelId, models),
      rawModelId: deployment.modelId,
      nodes: deployment.nodeIds.map((id) => sparks.find((s) => s.id === id)).filter((s): s is SparkSnapshot => !!s),
      runtime: recipe?.runtime ?? "—",
      // Topology is ONLY what the recipe declares — node count never decides.
      topology: recipe?.topology ?? null,
      lifecycleState: recipe?.lifecycleState ?? null,
      contextLength: recipe?.serving?.contextLength ?? recipe?.contextLength ?? null,
      port: deployment.apiPort,
      decodeTps: deploymentDecodeTps(sparks, deployment),
      telemetry: deploymentTelemetry(sparks, deployment),
      uptime: primary?.uptime ?? null,
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
    if (nodeThermalLevel(s) !== "normal" || nodeOomEventsRecent(s) > 0) {
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
  /** Masked prefix…suffix of the stored secret key, when the API exposes one. */
  keyHint?: string | null;
  keyName?: string | null;
  nodeNames: string[];
  note: string;
}

/** Human runtime name from registry labels (custom → its launcher, unknown → raw id). */
export function runtimeLabel(
  runtime: string | null | undefined,
  labels?: Record<string, string> | null
): string {
  if (!runtime || runtime === "custom") return "its launcher";
  return labels?.[runtime] ?? runtime;
}

/**
 * Read-only connection details for an externally launched runtime (e.g. the
 * never-touch Qwen/TabbyAPI process). Lifecycle stays disabled.
 */
export function externalConnectView(
  d: DeploymentStatus,
  recipe: RecipePublic | null,
  sparks: SparkSnapshot[],
  labels?: Record<string, string> | null
): ExternalConnect | null {
  if (d.managedBy !== "external") return null;
  const node = primaryAnchorNode(sparks, d);
  const host = node?.lanIp ?? d.nodeIds[0] ?? "localhost";
  const secretEnv = recipe?.env.find((e) => e.secret && (e.hasValue ?? !!e.value)) ?? null;
  return {
    endpoint: `http://${host}:${d.apiPort}/v1`,
    hasKey: !!secretEnv,
    keyHint: secretEnv?.hint ?? null,
    keyName: secretEnv?.name ?? null,
    nodeNames: d.nodeIds.map((id) => sparks.find((s) => s.id === id)?.name ?? id),
    note: `Launched outside SparkDash — manage via ${runtimeLabel(recipe?.runtime, labels)}`,
  };
}

