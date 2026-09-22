/**
 * DeploymentStatus — desired vs observed classification + derived display state.
 *
 * Correctness contract: a health probe that fails AUTH (HTTP 401/403) PROVES the
 * process is up and serving; it must never be read as "stopped". So probe
 * outcomes are classified into an explicit `observed` vocabulary, kept separate
 * from the operator `desired` intent, and only then collapsed into the fixed
 * DISPLAY vocabulary from docs/DESIGN_BRIEF.md global rule 10.
 *
 * Pure + synchronous so it is unit-testable without network. `probeEndpoint`
 * performs the single read-only HTTP GET and feeds `classifyProbe`.
 */

export const DESIRED_STATES = Object.freeze(["running", "stopped", "unknown"]);
export const OBSERVED_STATES = Object.freeze([
  "running",
  "auth-gated",
  "unhealthy",
  "not-detected",
]);
export const DISPLAY_STATES = Object.freeze([
  "running",
  "running-external",
  "expected-not-detected",
  "degraded",
  "stopped",
]);

export const DISPLAY_LABELS = Object.freeze({
  running: "Running",
  "running-external": "Running external",
  "expected-not-detected": "Expected · not detected",
  degraded: "Degraded",
  stopped: "Stopped",
});

/** Socket-level failures that mean "nothing is listening" (not a bad backend). */
const NOT_DETECTED_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Classify one probe outcome into the observed vocabulary.
 * @param {{ status?: number|null, errorCode?: string|null, errorName?: string|null }} outcome
 * @returns {"running"|"auth-gated"|"unhealthy"|"not-detected"}
 */
export function classifyProbe({ status = null, errorCode = null, errorName = null } = {}) {
  if (Number.isInteger(status)) {
    if (status >= 200 && status < 300) return "running";
    // 401/403 is the headline fix: auth gate answered, so the process is up.
    if (status === 401 || status === 403) return "auth-gated";
    return "unhealthy"; // 5xx and other 4xx
  }
  if (errorCode && NOT_DETECTED_CODES.has(errorCode)) return "not-detected";
  if (errorName === "TimeoutError" || errorName === "AbortError") return "unhealthy";
  if (errorCode || errorName) return "not-detected";
  return "not-detected";
}

/**
 * Collapse desired + observed into the fixed display vocabulary.
 * `discovered` is read-only SSH corroboration (pgrep) evidence: a live process
 * with no answering endpoint is treated as external rather than absent.
 * @param {{ desired?: string, observed?: string, discovered?: boolean }} input
 * @returns {"running"|"running-external"|"expected-not-detected"|"degraded"|"stopped"}
 */
export function deriveDisplay({ desired = "unknown", observed = "not-detected", discovered = false } = {}) {
  if (observed === "unhealthy") return "degraded";
  if (observed === "running" || observed === "auth-gated") {
    return desired === "running" ? "running" : "running-external";
  }
  if (discovered && desired !== "running") return "running-external";
  if (desired === "running") return "expected-not-detected";
  return "stopped";
}

/** Build the probe URL from a host/port/healthPath (no scheme, no auth header). */
export function probeUrl(host, port, healthPath) {
  if (!host || !port) return null;
  const path = typeof healthPath === "string" && healthPath.startsWith("/") ? healthPath : "/v1/models";
  return `http://${host}:${port}${path}`;
}

/**
 * Read-only HTTP probe classification. Defaults to a bare GET with NO
 * Authorization header so an auth-gated endpoint yields 401/403 (proof of a
 * live process). Optional `headers` attach a caller-resolved cred reference;
 * optional `method`/`json` allow the tiny capability POSTs — nothing else is
 * ever sent and nothing is written.
 * @param {string|null} url
 * @param {{
 *   fetchImpl?: typeof fetch, timeoutMs?: number, headers?: Record<string,string>|null,
 *   method?: string, json?: unknown, parseBody?: boolean,
 * }} [opts]
 */
export async function probeEndpoint(
  url,
  { fetchImpl = fetch, timeoutMs = 3000, headers = null, method = "GET", json = null, parseBody = false } = {}
) {
  if (!url) return { status: null, errorCode: "ENOTFOUND", errorName: null, body: null };
  const init = {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { ...(headers || {}), ...(json != null ? { "content-type": "application/json" } : {}) },
  };
  if (json != null) init.body = JSON.stringify(json);
  try {
    const res = await fetchImpl(url, init);
    let body = null;
    if (parseBody && res.ok) {
      try {
        body = await res.json();
      } catch {
        body = null;
      }
    }
    return { status: res.status, errorCode: null, errorName: null, body };
  } catch (err) {
    return {
      status: null,
      errorCode: err?.cause?.code ?? err?.code ?? null,
      errorName: err?.name ?? null,
      body: null,
    };
  }
}
