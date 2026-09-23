/**
 * COCKPIT model — the pure derivation layer behind the AI Lab instrument
 * cluster. Everything here is data-driven: no model name, node count, tok/s or
 * topology is ever hard-coded. Consumes the existing fleet/fabric interfaces.
 *
 * Three jobs only:
 *   1. a Level-1 verdict + one-line summary for the glanceable header,
 *   2. role + ordering for the instruments (PRIMARY first, derived from the
 *      member nodes' config role, else a first-deployment heuristic),
 *   3. per-deployment secondary instrument selection from the runtime's OWN
 *      declared `metrics[]` — never a fixed panel.
 */
import type { SparkSnapshot } from "../../api/types";
import type { DeploymentTelemetry, DeploymentView, RuntimeState } from "./fleetModel";
import type { RuntimeLabelMap } from "./runtimeLabels";
import type { RuntimeOption } from "./runtimeLabels";
import type { FabricHealth, FabricLink } from "./fabricModel";
import { resolveSparkRole } from "../../api/sparkRole";

/**
 * Honest three-level verdict. DEGRADED is reserved for a GENUINELY degraded /
 * offline model or node; a warning-only lab (all nodes online, models ready,
 * a memory warning) is ATTENTION — a warning is NOT a degradation.
 */
export type LabVerdict = "nominal" | "attention" | "degraded";
/**
 * FULL config role, uppercased, plus NONE. A heuristic PRIMARY/WORKER fallback
 * is used ONLY when no config role is set. Role is never inferred from traffic.
 */
export type InstrumentRole = "PRIMARY" | "WORKER" | "SPECIALIST" | "REVIEWER" | "EXPERIMENTAL" | "NONE";
/** Visual tone of a state pill — colour is a secondary cue, never the only cue. */
export type StateTone = "live" | "calm" | "warn" | "alert" | "off";

const STATE_RANK: Record<RuntimeState, number> = {
  online: 0,
  serving: 0,
  busy: 1,
  ready: 2,
  idle: 3,
  reachable: 4,
  loaded: 4,
  starting: 4,
  unknown: 5,
  degraded: 6,
  offline: 7,
};

const STATE_LABEL: Record<RuntimeState, string> = {
  online: "ONLINE",
  serving: "SERVING",
  busy: "BUSY",
  ready: "READY",
  idle: "IDLE",
  reachable: "REACHABLE",
  loaded: "LOADED",
  starting: "STARTING",
  unknown: "UNKNOWN",
  degraded: "DEGRADED",
  offline: "OFFLINE",
};

const STATE_TONE: Record<RuntimeState, StateTone> = {
  online: "live",
  serving: "live",
  busy: "live",
  ready: "calm",
  idle: "calm",
  reachable: "calm",
  loaded: "calm",
  starting: "warn",
  unknown: "off",
  degraded: "warn",
  offline: "alert",
};

export function stateLabel(state: RuntimeState): string {
  return STATE_LABEL[state];
}

export function stateTone(state: RuntimeState): StateTone {
  return STATE_TONE[state];
}

/* ───────────────────────── thermal ───────────────────────── */

/**
 * Thermal level from REAL provider signals plus documented high-temperature
 * bars. Provider throttle flags escalate immediately (hardware's own signal);
 * the numeric bars only ever read warm/critical for a genuinely high temp — a
 * missing temp is NORMAL, never an alarm.
 */
export type ThermalLevel = "normal" | "warm" | "critical";

/** High-temperature bars (°C). A node at/above reads warm, then critical. */
export const THERMAL_WARM_C = 85;
export const THERMAL_CRITICAL_C = 95;

const THERMAL_RANK: Record<ThermalLevel, number> = { normal: 0, warm: 1, critical: 2 };
const isTemp = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function nodeHottestC(node: SparkSnapshot): number | null {
  const gpu = node.metrics?.gpu?.temperature;
  const cpu = node.metrics?.cpu?.temperature;
  const vals = [gpu, cpu].filter(isTemp);
  return vals.length === 0 ? null : Math.max(...vals);
}

/** Measured thermal level. Provider throttle flags are critical; temp bars warm→critical. */
export function nodeThermalLevel(node: SparkSnapshot): ThermalLevel {
  const throttle = node.metrics?.gpu?.throttle ?? null;
  if (throttle?.thermal || throttle?.hwSlowdown) return "critical";
  const hottest = nodeHottestC(node);
  if (hottest != null && hottest >= THERMAL_CRITICAL_C) return "critical";
  if (throttle?.active || (hottest != null && hottest >= THERMAL_WARM_C)) return "warm";
  return "normal";
}

/**
 * GENUINE GPU allocation-failure events: the kernel NV_ERR_NO_MEMORY counter
 * since boot. HISTORICAL — this is the cumulative journal-since-boot figure,
 * not a current-incident claim. Prefer nodeOomEventsRecent to decide whether an
 * incident is happening NOW.
 */
export function nodeOomEvents(node: SparkSnapshot): number {
  const n = node.metrics?.gpu?.nvErrNoMemory;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * NEW GPU allocation-failure events since the previous collector poll — the
 * genuine "active incident" signal. Falls back to the cumulative count only
 * when the collector did not emit `nvErrNoMemoryRecent` (older snapshot shape),
 * so cumulative-since-boot alone never reads as a fresh incident.
 */
export function nodeOomEventsRecent(node: SparkSnapshot): number {
  const recent = node.metrics?.gpu?.nvErrNoMemoryRecent;
  if (typeof recent === "number" && Number.isFinite(recent)) {
    return recent > 0 ? recent : 0;
  }
  return nodeOomEvents(node);
}

export function thermalLabel(level: ThermalLevel): string {
  return level === "critical" ? "CRITICAL" : level === "warm" ? "WARM" : "NORMAL";
}

export function thermalTone(level: ThermalLevel): StateTone {
  return level === "critical" ? "alert" : level === "warm" ? "warn" : "live";
}

export interface ThermalReading {
  level: ThermalLevel;
  /** Hottest GPU/CPU across member nodes, formatted with unit; null when unmeasured. */
  value: string | null;
  unit: string | null;
  /** Node carrying the hottest reading — labelled, never anonymous. */
  nodeName: string | null;
  nodeId: string | null;
  /** Honest MAX aggregation count. */
  reporting: number;
  memberCount: number;
}

/**
 * HOTTEST GPU/CPU across member nodes (MAX aggregation, explicitly labelled).
 * A member with no temp contributes no reading — never a fabricated 0.
 */
export function hottestThermal(
  nodes: readonly SparkSnapshot[],
  temperatureUnit: "celsius" | "fahrenheit" = "celsius"
): ThermalReading {
  let level: ThermalLevel = "normal";
  let bestC: number | null = null;
  let bestNode: SparkSnapshot | null = null;
  let reporting = 0;
  for (const n of nodes) {
    const l = nodeThermalLevel(n);
    if (THERMAL_RANK[l] > THERMAL_RANK[level]) level = l;
    const t = nodeHottestC(n);
    if (t == null) continue;
    reporting++;
    if (bestC == null || t > bestC) {
      bestC = t;
      bestNode = n;
    }
  }
  return {
    level,
    value: bestC == null ? null : fmtTemp(bestC, temperatureUnit),
    unit: bestC == null ? null : tempUnit(temperatureUnit),
    nodeName: bestNode?.name ?? null,
    nodeId: bestNode?.id ?? null,
    reporting,
    memberCount: nodes.length,
  };
}

/** True when the deployment is a genuinely active (running-ish) placement. */
export function isActiveView(v: DeploymentView): boolean {
  return v.deployment.display !== "stopped";
}

/**
 * LAB verdict from fleet health + attention + live deployment states.
 * DEGRADED requires a genuinely degraded/offline MODEL or NODE. A bare warning
 * (alertCount) never degrades — it reads ATTENTION. Nothing => NOMINAL.
 */
export function labVerdict(
  nodesOnline: number,
  nodesTotal: number,
  alertCount: number,
  views: readonly DeploymentView[],
  states: readonly RuntimeState[]
): LabVerdict {
  const offlineNodes = nodesTotal - nodesOnline;
  const modelOrNodeHardFail =
    offlineNodes > 0 ||
    states.some((s) => s === "degraded" || s === "offline") ||
    views.some((v) => v.deployment.display === "degraded");
  if (modelOrNodeHardFail) return "degraded";
  if (alertCount > 0 || views.some((v) => !!v.deployment.lastError)) return "attention";
  return "nominal";
}

export function verdictLabel(v: LabVerdict): string {
  return v === "nominal" ? "NOMINAL" : v === "attention" ? "ATTENTION" : "DEGRADED";
}

/**
 * One-line human headline, worded consistently with the pill (never mixing
 * "ALERT"/"DEGRADED"/"needs attention").
 */
export function verdictHeadline(verdict: LabVerdict, warningCount: number): string {
  if (verdict === "nominal") return "All systems normal";
  const warnings = `${warningCount} warning${warningCount === 1 ? "" : "s"} to review`;
  if (verdict === "attention") return warningCount > 0 ? warnings : "Attention needed";
  return warningCount > 0 ? `Degraded — ${warnings}` : "A model or node is degraded";
}

const ROLE_UPPER: Record<string, InstrumentRole> = {
  primary: "PRIMARY",
  worker: "WORKER",
  edge: "WORKER",
  specialist: "SPECIALIST",
  reviewer: "REVIEWER",
  experimental: "EXPERIMENTAL",
  none: "NONE",
};

/**
 * FULL config role. CONFIG FIRST: an explicit `role` is returned verbatim
 * (uppercased, `edge` folded to WORKER). Only when no role is set does the
 * heuristic apply — a deployment placed on a `head` node is PRIMARY, else the
 * top-ranked active deployment is PRIMARY and the rest WORKER. Never role from
 * traffic, never a hard-coded model id.
 */
export function roleOf(view: DeploymentView, allViews: readonly DeploymentView[]): InstrumentRole {
  const declared = view.deployment.role ?? null;
  if (declared != null && ROLE_UPPER[declared]) return ROLE_UPPER[declared];
  if (view.nodes.some((n) => resolveSparkRole(n) === "head")) return "PRIMARY";
  const ranked = rankViews(allViews);
  return ranked[0]?.key === view.key ? "PRIMARY" : "WORKER";
}

/** A role is PRIMARY strictly from config/heuristic — never from load. */
export function isPrimary(role: InstrumentRole): boolean {
  return role === "PRIMARY";
}

/**
 * The emphasized deployment. CONFIG-driven: the one config role `primary`; if
 * none is declared, the heuristic primary (head-node placement / top rank).
 * Returns null for an empty lab. When the primary is offline it is STILL
 * returned so it stays visible — another is never silently promoted.
 */
export function primaryView(views: readonly DeploymentView[]): DeploymentView | null {
  const declared = views.find((v) => v.deployment.role === "primary");
  if (declared) return declared;
  const heads = views.find((v) => v.nodes.some((n) => resolveSparkRole(n) === "head"));
  if (heads) return heads;
  return rankViews(views)[0] ?? null;
}

/** Active deployments, primary-first: live states first, then throughput desc. */
export function rankViews(views: readonly DeploymentView[], states?: readonly RuntimeState[]): DeploymentView[] {
  const stateOf = (v: DeploymentView, i: number) => states?.[i] ?? stateFromView(v);
  return [...views]
    .map((v, i) => ({ v, rank: STATE_RANK[stateOf(v, i)], tps: v.telemetry?.generationTps ?? 0 }))
    .sort((a, b) => a.rank - b.rank || b.tps - a.tps || a.v.modelName.localeCompare(b.v.modelName))
    .map((x) => x.v);
}

/** Local fallback state read used only for ordering when none is supplied. */
function stateFromView(v: DeploymentView): RuntimeState {
  if (v.deployment.observed === "unhealthy") return "degraded";
  if (v.deployment.display === "stopped") return "offline";
  if ((v.telemetry?.requestsWaiting ?? 0) > 0) return "busy";
  if ((v.telemetry?.requestsRunning ?? 0) > 0 || (v.telemetry?.generationTps ?? 0) > 0) return "serving";
  if (v.deployment.observed === "auth-gated" || v.deployment.display === "running-external") return "ready";
  return v.telemetry ? "idle" : "unknown";
}

export interface SecondaryInstrument {
  key: string;
  label: string;
  value: string;
  unit?: string;
  /** 0–1 fill for a thin micro-bar; omitted for non-ratio metrics. */
  fraction?: number;
  /** Accessible full value when the rendered one is abbreviated. */
  title?: string;
}

const METRIC_LABEL: Record<string, string> = {
  prefillTps: "PREFILL",
  ttftSeconds: "TTFT",
  requestsRunning: "RUNNING",
  requestsWaiting: "QUEUE",
  kvCacheUsage: "KV CACHE",
  prefixCacheHitRate: "CACHE HIT",
  mtpAcceptanceRate: "MTP",
  contextLength: "CONTEXT",
  gpuMemoryUtilization: "VRAM",
  slotsActive: "SLOTS",
  slotsTotal: "SLOTS",
};

/** Generation tok/s is the primary gauge; these are the secondary instruments. */
const SECONDARY_ORDER = [
  "mtpAcceptanceRate",
  "prefixCacheHitRate",
  "kvCacheUsage",
  "requestsWaiting",
  "requestsRunning",
  "ttftSeconds",
  "prefillTps",
  "gpuMemoryUtilization",
  "slotsActive",
  "slotsTotal",
  "contextLength",
] as const;

const asPct = (v: number) => `${Math.round(v * 100)}`;
const asInt = (v: number) => String(Math.round(v));

function formatMetric(key: string, v: number): { value: string; unit?: string } {
  switch (key) {
    case "ttftSeconds":
      return { value: v.toFixed(2), unit: "S" };
    case "prefillTps":
      return { value: asInt(v), unit: "TOK/S" };
    case "contextLength":
      return { value: v >= 1000 ? `${Math.round(v / 1000)}K` : String(Math.round(v)) };
    case "kvCacheUsage":
    case "prefixCacheHitRate":
    case "mtpAcceptanceRate":
    case "gpuMemoryUtilization":
      return { value: asPct(v), unit: "%" };
    default:
      return { value: asInt(v) };
  }
}

/** Ratio metrics rendered as a thin micro-bar. */
const RATIO_KEYS = new Set(["kvCacheUsage", "prefixCacheHitRate", "mtpAcceptanceRate", "gpuMemoryUtilization"]);

/**
 * Secondary instruments chosen from the runtime's DECLARED metrics[]. A declared
 * metric with no value renders `—` (never 0); ratio metrics carry a fill
 * fraction for a thin micro-bar.
 */
export function secondaryInstruments(
  declared: readonly string[] | undefined,
  telemetry: DeploymentTelemetry | null,
  cap = 4
): SecondaryInstrument[] {
  if (!declared || declared.length === 0) return [];
  const set = new Set(declared);
  const out: SecondaryInstrument[] = [];
  for (const key of SECONDARY_ORDER) {
    if (!set.has(key)) continue;
    if (key === "slotsTotal" && set.has("slotsActive")) continue;
    const label = METRIC_LABEL[key];
    if (!label) continue;
    const raw = telemetry ? (telemetry as unknown as Record<string, unknown>)[key] : null;
    const present = typeof raw === "number" && Number.isFinite(raw);
    if (!present) {
      out.push({ key, label, value: EMPTY });
    } else {
      const { value, unit } = formatMetric(key, raw as number);
      out.push({
        key,
        label,
        value,
        unit,
        fraction: RATIO_KEYS.has(key) ? Math.min(1, Math.max(0, raw as number)) : undefined,
      });
    }
    if (out.length >= cap) break;
  }
  return out;
}

/** Runtime label with raw-id fallback. Never invents a friendly name. */
export function runtimeName(runtime: string, labels: RuntimeLabelMap): string {
  return labels[runtime] ?? runtime;
}

/** Declared metrics for this runtime's provider, from the registry. */
export function declaredMetrics(runtime: string, metrics: Record<string, string[]>): string[] {
  return metrics[runtime] ?? [];
}

/** Runtime option label with raw-id fallback (registry-driven pickers). */
export function runtimeOptionLabel(opts: readonly RuntimeOption[], id: string): string {
  return opts.find((o) => o.id === id)?.label ?? id;
}

/** Recent-request recency from the totalOutputTokens change signal. */
export function lastRequestAgo(lastRequestAt: number | null, now: number): string | null {
  if (!lastRequestAt) return null;
  const s = Math.max(0, Math.round((now - lastRequestAt) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/* ───────────────────────── lab header briefing ───────────────────────── */

const FABRIC_RANK: Record<FabricHealth, number> = { error: 0, warn: 1, offline: 2, unknown: 3, ok: 4 };

/**
 * PHYSICAL LINK health aggregate — worst link wins, never a fabricated one.
 * Deliberately NOT node health: a memory-warned node with every link up keeps
 * FABRIC healthy; memory pressure surfaces as its own attention row.
 * No links (wiring undiscovered) => unknown.
 */
export function fabricHealthSummary(links: readonly Pick<FabricLink, "health">[]): FabricHealth {
  if (links.length === 0) return "unknown";
  return [...links].map((l) => l.health).sort((a, b) => FABRIC_RANK[a] - FABRIC_RANK[b])[0];
}

export function fabricStateLabel(h: FabricHealth): string {
  return h === "ok" ? "HEALTHY" : h === "warn" ? "WARN" : h === "error" ? "FAILED" : h === "offline" ? "OFFLINE" : "UNKNOWN";
}

export interface LabBriefing {
  nodesOnline: number;
  nodesTotal: number;
  deploymentsActive: number;
  primaryName: string | null;
  fabric: FabricHealth;
  critical: number;
  warning: number;
}

/**
 * One-line, ALL-CAPS, fully data-driven lab briefing. Never states a number the
 * data does not carry; `—` for an absent primary.
 */
export function labBriefing(b: LabBriefing): string {
  const nodes = `${b.nodesOnline}/${b.nodesTotal} COMPUTE ONLINE`;
  const deps = `${b.deploymentsActive} DEPLOYMENT${b.deploymentsActive === 1 ? "" : "S"} ACTIVE`;
  const primary = `PRIMARY: ${b.primaryName ?? "—"}`;
  const fabric = `FABRIC: ${fabricStateLabel(b.fabric)}`;
  const critical = `${b.critical} CRITICAL`;
  const warnings = `${b.warning} WARNING${b.warning === 1 ? "" : "S"}`;
  return [nodes, deps, primary, fabric, critical, warnings].join(" · ");
}

/**
 * Compact counter line for the status strip — the same facts labBriefing
 * carries MINUS critical/warning (those are their own chips). Never states a
 * number the data does not carry; `—` for an absent primary.
 */
export function labCounters(b: Omit<LabBriefing, "critical" | "warning">): string {
  const nodes = `${b.nodesOnline}/${b.nodesTotal} COMPUTE ONLINE`;
  const deps = `${b.deploymentsActive} DEPLOYMENT${b.deploymentsActive === 1 ? "" : "S"} ACTIVE`;
  const primary = `PRIMARY: ${b.primaryName ?? "—"}`;
  const fabric = `FABRIC: ${fabricStateLabel(b.fabric)}`;
  return [nodes, deps, primary, fabric].join(" · ");
}

/* ───────────────────────── node telemetry ───────────────────────── */

export interface NodeMetric {
  key: string;
  label: string;
  value: string;
  unit?: string;
  /** 0–1 fill for a thin micro-bar (ratio metrics only). */
  fraction?: number;
  title?: string;
}

export interface NodeTelemetryRow {
  id: string;
  name: string;
  online: boolean;
  /** Measured classification: offline when unreachable, warn on provider throttle. */
  tone: "live" | "warn" | "alert" | "off";
  /** Measured thermal level (NORMAL by default, never an alarm from a missing temp). */
  thermal: ThermalLevel;
  metrics: NodeMetric[];
  /** Deployment names this node belongs to (may be empty). */
  deployments: string[];
  /** Config cluster role note (head/worker), else null. */
  roleNote: string | null;
}

const EMPTY = "—";
const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const fmtNum = (v: unknown, digits = 0): string => (isFiniteNum(v) ? v.toFixed(digits) : EMPTY);
const gb = (mb: number): string => `${Math.round(mb / 1024)}`;

function fmtTemp(celsius: unknown, unit: "celsius" | "fahrenheit"): string {
  if (!isFiniteNum(celsius)) return EMPTY;
  const v = unit === "fahrenheit" ? (celsius * 9) / 5 + 32 : celsius;
  return String(Math.round(v));
}

const tempUnit = (unit: "celsius" | "fahrenheit"): string => (unit === "fahrenheit" ? "°F" : "°C");

/** Free pool in MB: unified carries `available`, RAM derives total − used. */
function memFree(pool: { used: number; total: number; available?: number }): string {
  const free = typeof pool.available === "number" ? pool.available : pool.total - pool.used;
  return gb(free);
}

/**
 * One compact node row: online state + measured GPU/CPU temp, memory, util and
 * power, plus deployment membership. A missing metric renders `—` (never 0);
 * ONLY provider throttle marks a reachable node `warn` — no fabricated temp
 * threshold. Unified-memory systems keep unified terminology (fall back to RAM
 * only when the snapshot carries no unified pool).
 */
export function nodeTelemetryRow(
  node: SparkSnapshot,
  deployments: readonly string[],
  temperatureUnit: "celsius" | "fahrenheit" = "celsius"
): NodeTelemetryRow {
  const gpu = node.metrics?.gpu ?? null;
  const cpu = node.metrics?.cpu ?? null;
  // A failed collection leaves only DEFAULTS — render '—', never a default 0 (F6).
  // Absent flag (older fixtures) is treated as OK; only an explicit false gates.
  const gpuOk = gpu != null && node.metricsCollectSuccess?.gpu !== false;
  const cpuOk = cpu != null && node.metricsCollectSuccess?.cpu !== false;
  const metrics: NodeMetric[] = [];

  if (gpu) metrics.push({ key: "gpuTemp", label: "GPU TEMP", value: gpuOk ? fmtTemp(gpu.temperature, temperatureUnit) : "—", unit: tempUnit(temperatureUnit) });
  if (cpu) metrics.push({ key: "cpuTemp", label: "CPU TEMP", value: cpuOk ? fmtTemp(cpu.temperature, temperatureUnit) : "—", unit: tempUnit(temperatureUnit) });

  const unified = node.metrics?.unifiedMemory ?? null;
  const ram = unified ? null : node.metrics?.ram ?? null;
  const mem = unified ?? ram;
  if (mem) {
    metrics.push({
      key: "mem",
      label: unified ? "UNIFIED MEM" : "RAM",
      value: fmtNum(mem.percentage),
      unit: "%",
      fraction: isFiniteNum(mem.percentage) ? Math.min(1, Math.max(0, mem.percentage / 100)) : undefined,
      title: `${gb(mem.used)}/${gb(mem.total)} GB · ${memFree(mem)} GB free — utilisation, not pressure`,
    });
  }

  if (gpu) metrics.push({ key: "util", label: "GPU UTIL", value: gpuOk ? fmtNum(gpu.usage) : "—", unit: "%", fraction: gpuOk && isFiniteNum(gpu.usage) ? Math.min(1, Math.max(0, gpu.usage / 100)) : undefined });
  if (gpu?.power) {
    const limit = isFiniteNum(gpu.power.limit) && gpu.power.limit > 0 ? `${Math.round(gpu.power.limit)} W` : null;
    metrics.push({
      key: "power",
      label: "POWER",
      value: gpuOk ? fmtNum(gpu.power.draw) : "—",
      unit: "W",
      title: limit ? `${Math.round(gpu.power.draw)}/${limit}` : undefined,
    });
  }

  const oomEvents = nodeOomEvents(node);
  if (oomEvents > 0) metrics.push({ key: "nvmem", label: "NV_ERR_NO_MEM", value: fmtNum(oomEvents), title: "GPU allocation-failure events since boot (kernel NV_ERR_NO_MEMORY)" });

  const thermal = nodeThermalLevel(node);
  return {
    id: node.id,
    name: node.name,
    online: node.online,
    tone: !node.online ? "off" : thermal === "critical" ? "alert" : thermal === "warm" ? "warn" : "live",
    thermal,
    metrics,
    deployments: [...deployments],
    roleNote: node.role === "head" ? "head" : node.role === "worker" ? "worker" : null,
  };
}

/**
 * Explicit multi-node aggregation legend — MAX/AVG/SUM per field, never a silent
 * blend. Null for a single-member deployment.
 */
export function aggregationLegend(membersReporting: number, memberTotal: number): string | null {
  if (memberTotal <= 1) return null;
  return `SUM gen/queue · MAX kv/vram · ${membersReporting}/${memberTotal} ranks reporting`;
}

/** Primary (coordinator) member node of a deployment for node-derived cells. */
export function primaryMemberNode(view: DeploymentView): SparkSnapshot | null {
  return view.nodes.find((n) => resolveSparkRole(n) !== "worker") ?? view.nodes[0] ?? null;
}

/**
 * Node-derived secondary instruments (temp / memory / util / power). Included
 * only when the node snapshot carries the metric object; an absent sub-value
 * renders `—`. No fabricated thermal threshold — throttle rides as a title.
 */
export function nodeInstruments(
  node: SparkSnapshot | null,
  temperatureUnit: "celsius" | "fahrenheit" = "celsius",
  cap = 6
): SecondaryInstrument[] {
  if (!node) return [];
  const gpu = node.metrics?.gpu ?? null;
  const cpu = node.metrics?.cpu ?? null;
  const out: SecondaryInstrument[] = [];

  if (cpu) out.push({ key: "cpuTemp", label: "CPU TEMP", value: fmtTemp(cpu.temperature, temperatureUnit), unit: tempUnit(temperatureUnit) });
  const mem = node.metrics?.unifiedMemory ?? null;
  const ram = mem ? null : node.metrics?.ram ?? null;
  const pool = mem ?? ram;
  if (pool) {
    out.push({
      key: "mem",
      label: mem ? "UNIFIED MEM" : "RAM",
      value: fmtNum(pool.percentage),
      unit: "%",
      fraction: isFiniteNum(pool.percentage) ? Math.min(1, Math.max(0, pool.percentage / 100)) : undefined,
      title: `${gb(pool.used)}/${gb(pool.total)} GB · ${memFree(pool)} GB free — utilisation, not pressure`,
    });
  }
  if (gpu) out.push({ key: "gpuTemp", label: "GPU TEMP", value: fmtTemp(gpu.temperature, temperatureUnit), unit: tempUnit(temperatureUnit), title: gpu.throttle?.active ? `throttle: ${gpu.throttle.reason}` : undefined });
  if (gpu) out.push({ key: "util", label: "GPU UTIL", value: fmtNum(gpu.usage), unit: "%", fraction: isFiniteNum(gpu.usage) ? Math.min(1, Math.max(0, gpu.usage / 100)) : undefined });
  if (gpu?.power) {
    const limit = isFiniteNum(gpu.power.limit) && gpu.power.limit > 0 ? `${Math.round(gpu.power.limit)} W` : null;
    out.push({ key: "power", label: "POWER", value: fmtNum(gpu.power.draw), unit: "W", title: limit ? `${Math.round(gpu.power.draw)}/${limit} W` : undefined });
  }
  const oomEvents = nodeOomEvents(node);
  if (oomEvents > 0) out.push({ key: "nvmem", label: "NV_ERR_NO_MEM", value: fmtNum(oomEvents), title: "GPU allocation failures since boot" });
  return out.slice(0, cap);
}
