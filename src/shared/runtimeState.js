/**
 * CANONICAL RUNTIME-STATE VOCABULARY + DERIVATION.
 *
 * ONE authoritative module. Every surface (fleet, overview, cockpit, node
 * telemetry, server deployment classification) consumes THIS module and never
 * invents its own meanings. Shared by the React app and the Node server.
 *
 * GOLDEN RULE: SparkDash must never lie. UNKNOWN > wrong. Never invent
 * telemetry/topology/state. Never OFFLINE for missing OPTIONAL telemetry on a
 * reachable endpoint.
 *
 * Semantics (canonical, non-negotiable):
 *  - COMPUTE ONLINE / OFFLINE — node reachability only.
 *  - RUNTIME REACHABLE — the process answered (even a 401/403 proves liveness).
 *  - MODEL LOADED — a model id / slot pool is observed.
 *  - SERVING — observed ACTIVE generation (requestsRunning > 0 OR generationTps
 *    > 0 while a request is in flight).
 *  - READY — reachable + loaded + no active request.
 *  - IDLE — has served before, currently no request.
 *  - STARTING — display starting/loading.
 *  - DEGRADED — genuinely unhealthy (observed unhealthy / hard transport on a
 *    managed deployment).
 *  - REACHABLE — reachable but load could not be confirmed (e.g. auth-gated
 *    with no key). Honest substitute for a fabricated READY.
 *  - UNKNOWN — no evidence.
 *  - TELEMETRY PARTIAL — some optional metrics present, some not.
 *  - TELEMETRY STALE — snapshot age exceeds the staleness threshold.
 */

/** Canonical runtime state vocabulary. */
export const RUNTIME_STATE = Object.freeze({
  ONLINE: "online",
  REACHABLE: "reachable",
  LOADED: "loaded",
  READY: "ready",
  IDLE: "idle",
  SERVING: "serving",
  BUSY: "busy",
  STARTING: "starting",
  DEGRADED: "degraded",
  OFFLINE: "offline",
  UNKNOWN: "unknown",
});

/** Canonical telemetry-quality vocabulary. */
export const TELEMETRY_QUALITY = Object.freeze({
  FULL: "full",
  PARTIAL: "partial",
  STALE: "stale",
  ABSENT: "absent",
});

/** States usable when telemetry is stale — never a live-active claim. */
export const STALE_SAFE_STATES = Object.freeze([
  RUNTIME_STATE.READY,
  RUNTIME_STATE.REACHABLE,
  RUNTIME_STATE.DEGRADED,
  RUNTIME_STATE.UNKNOWN,
]);

/** Default staleness threshold (ms). Older snapshots read STALE, never current. */
export const TELEMETRY_STALE_MS = 30_000;

/** Optional telemetry fields; PARTIAL = some present, some missing. */
export const OPTIONAL_TELEMETRY_FIELDS = Object.freeze([
  "generationTps",
  "prefillTps",
  "ttftSeconds",
  "requestsRunning",
  "requestsWaiting",
  "kvCacheUsage",
  "prefixCacheHitRate",
  "mtpAcceptanceRate",
  "contextLength",
  "gpuMemoryUtilization",
  "slotsActive",
  "slotsTotal",
  "totalOutputTokens",
]);

/** Hard transport failure signatures — only these may read as degraded (managed). */
export const HARD_TRANSPORT_RE = /5\d\d|timeout|timed out|refused|econnrefused|abort|ehostunreach|enetunreach/i;
/** Auth signatures — a reachable, gated endpoint. */
export const AUTH_RE = /401|403|auth|unauthor|forbidden|api key/i;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Telemetry quality from presence + age. Never PRESUMES currentness.
 * @param {Record<string, unknown> | null | undefined} telemetry
 * @param {{ telemetryAgeMs?: number | null, staleMs?: number }} [opts]
 * @returns {"full"|"partial"|"stale"|"absent"}
 */
export function telemetryQuality(telemetry, opts = {}) {
  const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : TELEMETRY_STALE_MS;
  const age = opts.telemetryAgeMs;
  if (!telemetry || telemetry.available !== true) return TELEMETRY_QUALITY.ABSENT;
  if (isNum(age) && age > staleMs) return TELEMETRY_QUALITY.STALE;
  let present = 0;
  let missing = 0;
  for (const f of OPTIONAL_TELEMETRY_FIELDS) {
    if (isNum(telemetry[f])) present++;
    else missing++;
  }
  return missing > 0 && present > 0 ? TELEMETRY_QUALITY.PARTIAL : TELEMETRY_QUALITY.FULL;
}

/** True when the endpoint answered at all (2xx / 401 / 403). */
export function isReachableFromProbe({ status = null, available = false } = {}) {
  if (available === true) return true;
  return Number.isInteger(status) && status >= 200 && status < 500;
}

/** True for an auth-gated endpoint probed WITHOUT a key (honestly unavailable). */
export function isKeyedWithoutKey({ status = null, hasKey = false } = {}) {
  if (hasKey) return false;
  return status === 401 || status === 403;
}

/**
 * Honest probe outcome. Reachability is proven by 401/403 too; a keyed endpoint
 * without a key stays UNAVAILABLE (never offline, never invented).
 * @param {{ status?: number|null, available?: boolean, hasKey?: boolean, errorCode?: string|null, errorName?: string|null, backend?: string|null }} outcome
 * @returns {{ reachable: boolean, keyedWithoutKey: boolean, hardTransport: boolean, authError: string|null }}
 */
export function probeOutcome(outcome = {}) {
  const status = Number.isInteger(outcome.status) ? outcome.status : null;
  const reachable = isReachableFromProbe({ status, available: outcome.available === true });
  const keyedWithoutKey = isKeyedWithoutKey({ status, hasKey: outcome.hasKey === true });
  const hardTransport = !reachable && !!(outcome.errorCode || outcome.errorName);
  let authError = null;
  if (status === 401 || status === 403) {
    authError = outcome.hasKey
      ? `API key rejected (${status})`
      : `API key required (${status})`;
  } else if (typeof outcome.error === "string" && AUTH_RE.test(outcome.error)) {
    authError = outcome.error;
  }
  return { reachable, keyedWithoutKey, hardTransport, authError };
}

/** True when a healthy OBSERVED state proves a live process without readable metrics. */
export function isObservedHealthyExternal(d = {}) {
  return (
    d.observed === "auth-gated" ||
    d.display === "running-external" ||
    (d.managedBy === "external" && d.observed === "running")
  );
}

/**
 * Canonical runtime state derivation. ONE implementation, consumed everywhere.
 *
 * @param {{
 *   state?: string|null, display?: string|null, observed?: string|null,
 *   managedBy?: string|null,
 *   telemetry?: Record<string, unknown>|null,
 *   telemetryAgeMs?: number|null,
 *   reachable?: boolean,
 *   keyedWithoutKey?: boolean,
 *   staleMs?: number,
 *   externalHealthy?: boolean,
 * }} input
 * @returns {string} one of RUNTIME_STATE
 */
export function deriveRuntimeState(input = {}) {
  const {
    state = null,
    display = null,
    observed = null,
    managedBy = null,
    telemetry = null,
    telemetryAgeMs = null,
    staleMs = TELEMETRY_STALE_MS,
  } = input;

  // 1. Explicit absence — the ONLY offline signals.
  if (state === "stopped" || display === "stopped" || observed === "not-detected") {
    return RUNTIME_STATE.OFFLINE;
  }

  // 2. Starting / loading.
  if (display === "starting" || display === "loading") return RUNTIME_STATE.STARTING;

  // 3. Genuinely unhealthy.
  if (display === "degraded" || observed === "unhealthy") return RUNTIME_STATE.DEGRADED;

  const quality = telemetryQuality(telemetry, { telemetryAgeMs, staleMs });
  const stale = quality === TELEMETRY_QUALITY.STALE;

  // 4. Managed deployment whose readable probe hard-fails.
  if (
    managedBy !== "external" &&
    telemetry &&
    telemetry.available !== true &&
    typeof telemetry.error === "string" &&
    HARD_TRANSPORT_RE.test(telemetry.error)
  ) {
    return RUNTIME_STATE.DEGRADED;
  }

  // 5. Reachable signals — explicit flag, or observed-healthy external runtime.
  const reachable = input.reachable === true || isObservedHealthyExternal(input);
  const keyedWithoutKey = input.keyedWithoutKey === true;

  // 6. Keyed/gated reachable with no load confirmation → REACHABLE (never OFFLINE).
  if (keyedWithoutKey) return RUNTIME_STATE.REACHABLE;

  if (!telemetry || telemetry.available !== true) {
    if (reachable) return RUNTIME_STATE.READY;
    return RUNTIME_STATE.UNKNOWN;
  }

  // 7. Live-active signals — suppressed to a calm state when the snapshot is STALE.
  const active = (isNum(telemetry.requestsRunning) && telemetry.requestsRunning > 0)
    || (isNum(telemetry.generationTps) && telemetry.generationTps > 0);
  const waiting = isNum(telemetry.requestsWaiting) && telemetry.requestsWaiting > 0;

  if (!stale) {
    if (waiting) return RUNTIME_STATE.BUSY;
  }

  const loaded =
    (isNum(telemetry.slotsTotal) && telemetry.slotsTotal > 0) || !!telemetry.modelId;

  if (!stale) {
    if (active) return RUNTIME_STATE.SERVING;
  }
  if (!loaded) return reachable ? RUNTIME_STATE.READY : RUNTIME_STATE.UNKNOWN;

  // IDLE is stale-safe: served before, no active claim.
  if (isNum(telemetry.totalOutputTokens) && telemetry.totalOutputTokens > 0) {
    return RUNTIME_STATE.IDLE;
  }
  return reachable ? RUNTIME_STATE.READY : RUNTIME_STATE.UNKNOWN;
}

/**
 * Canonical COMPUTE ONLINE derivation for a node snapshot.
 * @param {{ online?: boolean|null }} node
 * @returns {string} ONLINE | OFFLINE | UNKNOWN
 */
export function deriveComputeOnline(node = {}) {
  if (node.online === true) return RUNTIME_STATE.ONLINE;
  if (node.online === false) return RUNTIME_STATE.OFFLINE;
  return RUNTIME_STATE.UNKNOWN;
}

/**
 * Whether this Spark should probe its local LLM API.
 * Workers default OFF but honour an EXPLICIT opt-in so a worker-hosted endpoint
 * is never silently unobserved. Head always. Standalone defaults on.
 * @param {{ role?: string|null, workerNode?: boolean|null, llmMonitoring?: boolean|null }} spark
 * @returns {boolean}
 */
export function llmMonitoringEnabled(spark = {}) {
  if (spark.llmMonitoring === true) return true;
  if (spark.llmMonitoring === false) return false;
  const role = spark.role || (spark.workerNode ? "worker" : "standalone");
  if (role === "worker") return false;
  if (role === "head") return true;
  return true;
}
