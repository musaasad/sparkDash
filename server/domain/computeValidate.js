/**
 * computeValidate — pre-SAVE validation for a guided Add Compute draft.
 *
 * CONFIG-ONLY and READ-ONLY: it inspects the registry and, where safe, a single
 * bounded `GET /v1/models` per declared port. It NEVER writes config and NEVER
 * touches the remote machine.
 *
 * Severity is deliberately split so the UI can distinguish a HARD failure from a
 * merely UNVERIFIED/UNKNOWN outcome:
 *   - INVALID      blocks SAVE (identity, duplicates, malformed target)
 *   - UNVERIFIED   is allowed with explicit operator confirmation (reachability,
 *                  provider compatibility, thin capabilities)
 *
 * `ok` means "no INVALID issue" — UNVERIFIED is not failure.
 */
import { isValidSparkId, isValidSshUser, isAllowedTargetHost } from "../validate.js";
import { llmProbeHost } from "../collectors/llmHost.js";
import { probeUrl, probeEndpoint } from "../deployments/deploymentStatus.js";
import { loadSecrets } from "../secretsStore.js";

const PORT_TIMEOUT_MS = 2500;
const MAX_PROBE_PORTS = 3;

const issue = (code, field, severity, message) => ({ code, field, severity, message });

/** Matching against OTHER registered nodes — self is excluded on update. */
function otherNodes(registry, selfId) {
  return (registry?.sparkIds || [])
    .filter((id) => id !== selfId)
    .map((id) => registry.getSpark(id))
    .filter(Boolean);
}

/**
 * @param {{sparkIds?:string[], getSpark?:(id:string)=>object|null}} registry
 * @param {object} draft SparkConfig-shaped payload (id, name, lanIp, ssh, ...)
 * @param {{fetchImpl?: typeof fetch, discovered?: object|null, selfId?: string}} [opts]
 * @returns {Promise<{ok:boolean, invalidCount:number, unverifiedCount:number, issues:object[]}>}
 */
export async function validateComputeDraft(registry, draft = {}, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const discovered = opts.discovered || null;
  const selfId = opts.selfId || null;
  const issues = [];

  const targetHost = String(draft.ssh?.host || draft.lanIp || "").trim();
  const others = otherNodes(registry, selfId);

  // ── Identity ──────────────────────────────────────────
  const id = String(draft.id || "").trim();
  if (!id) issues.push(issue("id-missing", "id", "invalid", "Node id is required."));
  else if (!isValidSparkId(id)) issues.push(issue("id-malformed", "id", "invalid", "Node id must be a-z A-Z 0-9 . _ -, 1–64 chars."));
  else if (registry?.getSpark?.(id) && id !== selfId) issues.push(issue("id-duplicate", "id", "invalid", `Node id “${id}” already exists.`));

  const name = String(draft.name || "").trim();
  if (!name) issues.push(issue("name-missing", "name", "invalid", "Display name is required."));

  // ── Target / duplicates ───────────────────────────────
  if (!targetHost && !draft.isLocal) {
    issues.push(issue("host-missing", "lanIp", "invalid", "A hostname or IP is required (or mark this unit local)."));
  } else if (targetHost && !isAllowedTargetHost(targetHost)) {
    issues.push(issue("host-invalid", "lanIp", "invalid", `Host “${targetHost}” is invalid or disallowed.`));
  }
  if (targetHost) {
    if (others.some((s) => s.lanIp === targetHost || s.ssh?.host === targetHost)) {
      issues.push(issue("host-duplicate", "lanIp", "invalid", `Host “${targetHost}” is already used by another node.`));
    }
  }

  const user = String(draft.ssh?.user || "").trim();
  if (!draft.isLocal) {
    if (!user) issues.push(issue("ssh-user-missing", "ssh.user", "invalid", "SSH user is required for a remote node."));
    else if (!isValidSshUser(user)) issues.push(issue("ssh-user-invalid", "ssh.user", "invalid", `SSH user “${user}” is not allowed.`));
    if (draft.ssh?.auth === "pass" && !draft.ssh?.password && !draft.hasPassword) {
      issues.push(issue("ssh-password-missing", "ssh.password", "invalid", "Password auth selected but no password supplied."));
    }
  }

  // ── Basic capabilities / ports ────────────────────────
  const ports = Array.isArray(draft.llmPorts) ? draft.llmPorts.map(Number) : [];
  if (ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
    issues.push(issue("port-invalid", "llmPorts", "invalid", "LLM ports must be integers 1–65535."));
  }
  if (ports.length === 0) {
    issues.push(issue("ports-empty", "llmPorts", "unverified", "No LLM port declared — runtime endpoints stay UNKNOWN."));
  }

  // ── Provider compatibility from DISCOVERED hardware (never fabricated) ──
  const gpu = discovered?.fields?.gpuChip?.value ?? null;
  const kind = draft.kind === "host" ? "host" : "spark";
  if (gpu) {
    const looksSpark = /\bGB10\b|DGX\s*Spark/i.test(String(gpu));
    if (kind === "host" && looksSpark) {
      issues.push(issue("kind-conflict", "kind", "unverified", `Discovered GPU “${gpu}” looks like a DGX Spark but unit type is “host”.`));
    }
    if (kind === "spark" && !looksSpark) {
      issues.push(issue("kind-unverified", "kind", "unverified", `Discovered GPU “${gpu}” is not an obvious GB10 — confirm the unit type.`));
    }
  } else if (!draft.isLocal) {
    issues.push(issue("gpu-unknown", "kind", "unverified", "No GPU was discovered — capabilities stay UNKNOWN."));
  }
  if (discovered && discovered.sshReachable === false) {
    issues.push(issue("ssh-unreachable", "ssh.host", "unverified", "SSH did not answer — node fields stay UNKNOWN (not invalid; host is never mutated)."));
  }

  // ── Fabric conflicts ──────────────────────────────────
  for (const link of Array.isArray(draft.fabricLinks) ? draft.fabricLinks : []) {
    const to = String(link?.to || "").trim();
    if (!to) continue;
    if (to === id) issues.push(issue("fabric-self", "fabricLinks", "invalid", "A node cannot link to itself."));
    else if (registry?.getSpark && !registry.getSpark(to)) {
      issues.push(issue("fabric-missing-peer", "fabricLinks", "unverified", `Fabric peer “${to}” is not (yet) a registered node.`));
    }
  }

  // ── Reachability where safe: bounded GET /v1/models ──
  if (targetHost && ports.length && !draft.isLocal) {
    const host = llmProbeHost({ lanIp: targetHost });
    const apiKey = apiKeyFor(draft, ports[0]);
    for (const p of ports.slice(0, MAX_PROBE_PORTS)) {
      const url = probeUrl(host, p, "/v1/models");
      const outcome = await probeEndpoint(url, {
        fetchImpl,
        timeoutMs: PORT_TIMEOUT_MS,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : null,
      });
      if (outcome.status == null) {
        issues.push(issue("endpoint-unreachable", "llmPorts", "unverified", `Port ${p} did not answer — NOT-VERIFIED (never mutated to check).`));
      }
    }
  }

  const invalidCount = issues.filter((i) => i.severity === "invalid").length;
  const unverifiedCount = issues.filter((i) => i.severity === "unverified").length;
  return { ok: invalidCount === 0, invalidCount, unverifiedCount, issues };
}

/** Optional API-key hint from the encrypted store (spark: ref) — never echoed. */
function apiKeyFor(draft, port) {
  if (!draft?.id) return null;
  try {
    return loadSecrets().llmApiKeys.get(draft.id)?.[String(port)] || null;
  } catch {
    return null;
  }
}
