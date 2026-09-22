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
import type { DeploymentTelemetry, DeploymentView, RuntimeState } from "./fleetModel";
import type { RuntimeLabelMap } from "./runtimeLabels";
import type { RuntimeOption } from "./runtimeLabels";
import { resolveSparkRole } from "../../api/sparkRole";

export type LabVerdict = "nominal" | "degraded" | "alert";
export type InstrumentRole = "PRIMARY" | "WORKER";
/** Visual tone of a state pill — colour is a secondary cue, never the only cue. */
export type StateTone = "live" | "calm" | "warn" | "alert" | "off";

const STATE_RANK: Record<RuntimeState, number> = {
  serving: 0,
  busy: 1,
  ready: 2,
  idle: 3,
  unknown: 4,
  degraded: 5,
  offline: 6,
};

const STATE_LABEL: Record<RuntimeState, string> = {
  serving: "SERVING",
  busy: "BUSY",
  ready: "READY",
  idle: "IDLE",
  unknown: "UNKNOWN",
  degraded: "DEGRADED",
  offline: "OFFLINE",
};

const STATE_TONE: Record<RuntimeState, StateTone> = {
  serving: "live",
  busy: "live",
  ready: "calm",
  idle: "calm",
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

/** True when the deployment is a genuinely active (running-ish) placement. */
export function isActiveView(v: DeploymentView): boolean {
  return v.deployment.display !== "stopped";
}

/** LAB verdict from fleet health + attention + live deployment states. */
export function labVerdict(
  nodesOnline: number,
  nodesTotal: number,
  alertCount: number,
  views: readonly DeploymentView[],
  states: readonly RuntimeState[]
): LabVerdict {
  const offlineNodes = nodesTotal - nodesOnline;
  const hardFail = states.some((s) => s === "degraded" || s === "offline") || offlineNodes > 0;
  const alertSeverity = views.some((v) => v.deployment.display === "degraded" || !!v.deployment.lastError);
  if (hardFail || alertSeverity) return "alert";
  if (alertCount > 0) return "degraded";
  return "nominal";
}

export function verdictLabel(v: LabVerdict): string {
  return v === "nominal" ? "NOMINAL" : v === "degraded" ? "DEGRADED" : "ALERT";
}

/**
 * One-line, ALL-CAPS, fully data-driven summary. Never states a number the
 * data does not carry.
 */
export function labSummary(nodesOnline: number, nodesTotal: number, modelsActive: number, alertCount: number): string {
  const nodes = `${nodesOnline} OF ${nodesTotal} NODE${nodesTotal === 1 ? "" : "S"} ONLINE`;
  const models = `${modelsActive} MODEL${modelsActive === 1 ? "" : "S"} ACTIVE`;
  const alerts = alertCount === 0 ? "NO ALERTS" : `${alertCount} ALERT${alertCount === 1 ? "" : "S"}`;
  return `${nodes} · ${models} · ${alerts}`;
}

/**
 * PRIMARY / WORKER role. CONFIG FIRST: an explicit deployment `role` wins
 * (`primary` => PRIMARY, `worker`/`edge` => WORKER). Only when no role is set
 * do we fall back to the heuristic: a deployment placed on a `head` node is
 * PRIMARY, else the top-ranked active deployment. Never a hard-coded model id.
 */
export function roleOf(view: DeploymentView, allViews: readonly DeploymentView[]): InstrumentRole {
  const declared = view.deployment.role ?? null;
  if (declared === "primary") return "PRIMARY";
  if (declared === "worker" || declared === "edge") return "WORKER";
  if (view.nodes.some((n) => resolveSparkRole(n) === "head")) return "PRIMARY";
  const ranked = rankViews(allViews);
  return ranked[0]?.key === view.key ? "PRIMARY" : "WORKER";
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

/**
 * Secondary instruments chosen from the runtime's DECLARED metrics[] and only
 * where telemetry actually carries a value. Unavailable => omitted, never faked.
 */
export function secondaryInstruments(
  declared: readonly string[] | undefined,
  telemetry: DeploymentTelemetry | null,
  cap = 4
): SecondaryInstrument[] {
  if (!declared || declared.length === 0 || !telemetry) return [];
  const set = new Set(declared);
  const out: SecondaryInstrument[] = [];
  for (const key of SECONDARY_ORDER) {
    if (!set.has(key)) continue;
    const raw = (telemetry as unknown as Record<string, unknown>)[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    if (key === "slotsTotal" && set.has("slotsActive")) continue;
    const label = METRIC_LABEL[key];
    if (!label) continue;
    const { value, unit } = formatMetric(key, raw);
    out.push({ key, label, value, unit });
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
