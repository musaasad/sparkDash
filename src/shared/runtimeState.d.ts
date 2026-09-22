export type RuntimeState =
  | "online"
  | "reachable"
  | "loaded"
  | "ready"
  | "idle"
  | "serving"
  | "busy"
  | "starting"
  | "degraded"
  | "offline"
  | "unknown";

export type TelemetryQuality = "full" | "partial" | "stale" | "absent";

export const RUNTIME_STATE: Record<string, RuntimeState>;
export const TELEMETRY_QUALITY: Record<string, TelemetryQuality>;
export const STALE_SAFE_STATES: RuntimeState[];
export const TELEMETRY_STALE_MS: number;
export const OPTIONAL_TELEMETRY_FIELDS: string[];
export const HARD_TRANSPORT_RE: RegExp;
export const AUTH_RE: RegExp;

export function telemetryQuality(
  telemetry: Record<string, unknown> | null | undefined,
  opts?: { telemetryAgeMs?: number | null; staleMs?: number }
): TelemetryQuality;

export function isReachableFromProbe(outcome?: { status?: number | null; available?: boolean }): boolean;
export function isKeyedWithoutKey(outcome?: { status?: number | null; hasKey?: boolean }): boolean;

export interface ProbeOutcome {
  reachable: boolean;
  keyedWithoutKey: boolean;
  hardTransport: boolean;
  authError: string | null;
}
export function probeOutcome(outcome?: {
  status?: number | null;
  available?: boolean;
  hasKey?: boolean;
  errorCode?: string | null;
  errorName?: string | null;
  error?: string | null;
}): ProbeOutcome;

export function isObservedHealthyExternal(d?: {
  observed?: string | null;
  display?: string | null;
  managedBy?: string | null;
}): boolean;

export function deriveRuntimeState(input?: {
  state?: string | null;
  display?: string | null;
  observed?: string | null;
  managedBy?: string | null;
  telemetry?: Record<string, unknown> | null;
  telemetryAgeMs?: number | null;
  reachable?: boolean;
  keyedWithoutKey?: boolean;
  staleMs?: number;
  externalHealthy?: boolean;
}): RuntimeState;

export function deriveComputeOnline(node?: { online?: boolean | null }): RuntimeState;

export function llmMonitoringEnabled(spark?: {
  role?: string | null;
  workerNode?: boolean | null;
  llmMonitoring?: boolean | null;
}): boolean;
