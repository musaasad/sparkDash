/**
 * Domain v2 schema — normalizers + validators for MODEL / RECIPE / DEPLOYMENT.
 *
 * The five concepts are deliberately separated:
 *   MODEL      who/what it is, weights identity
 *   RECIPE     how it CAN run (declarative, reusable, no node binding)
 *   DEPLOYMENT where it SHOULD run (model + recipe + nodes + desired)
 *   RUNTIME    what IS actually running (see DeploymentService / deploymentStatus)
 *   COMPUTE    the fleet (SparkRegistry)
 *
 * Normalizers accept BOTH the v1 flat body (backward compat for the current FE
 * and older tests) and the v2 structured body, always emitting a v2 entity.
 */
import {
  isValidSlug,
  isValidPosixPath,
  isValidEnvName,
  isValidEnvValue,
  isValidPort,
  isValidHealthPath,
  isValidNoteText,
  isValidCpuAffinity,
  RECIPE_RUNTIMES,
} from "../validate.js";
import { loadRecipeEnv } from "../secretsStore.js";

const quoteClamp = (s) => String(s).slice(0, 64);

export const TOPOLOGY_MODES = Object.freeze(["single", "tp", "pp", "dp", "ep"]);
export const LAUNCH_MECHANISMS = Object.freeze(["command", "systemd", "docker", "external"]);
export const DEPLOYMENT_ROLES = Object.freeze([
  "primary",
  "worker",
  "specialist",
  "reviewer",
  "experimental",
  "none",
]);
/** Legacy role spellings folded onto the current set (v2 back-compat). */
const LEGACY_ROLE_MAP = Object.freeze({ edge: "worker" });

/**
 * Canonicalise a deployment role: legacy aliases map onto the current set.
 * Returns null for absent/unknown — role stays OPTIONAL (absent => FE heuristic).
 * @param {unknown} role
 * @returns {string|null}
 */
export function normalizeDeploymentRole(role) {
  if (role == null) return null;
  const key = String(role).trim();
  const mapped = LEGACY_ROLE_MAP[key] ?? key;
  return DEPLOYMENT_ROLES.includes(mapped) ? mapped : null;
}
export const API_PROTOCOLS = Object.freeze(["openai", "custom"]);
export const PROBE_KINDS = Object.freeze(["http", "tcp", "process"]);
export const DISCOVERY_STRATEGIES = Object.freeze(["openai-models", "process", "manual"]);
export const LOG_KINDS = Object.freeze(["file", "docker", "journal"]);
export const LIFECYCLE_STATES = Object.freeze([
  "draft",
  "validated",
  "proven",
  "deprecated",
  "archived",
]);
export const WEIGHT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

const V1_TOPOLOGY = { single: 1, tp2: 2, tp3: 3 };

/** Explicit parallelism degree kinds, dominant-first tie-break order. */
export const TOPOLOGY_DEGREE_KEYS = Object.freeze(["tp", "pp", "dp", "ep"]);

const degreeOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : null;
};

/**
 * Map a legacy topology string ("tp2") or a v2 object to the v2 block.
 *
 * Degrees are EXPLICIT, never inferred from node count:
 *  - explicit `tp`/`pp`/`dp`/`ep` supplied → set them verbatim; derive legacy
 *    `mode` from the DOMINANT degree (tie-break tp→pp→dp→ep) and `parallelism`
 *    as the PRODUCT of the degrees (the replica count `topologySlug` reuses);
 *    default minNodes/maxNodes follow that product.
 *  - only legacy `mode` + `parallelism` → map that mode onto its own degree
 *    (mode "pp", parallelism 3 ⇒ pp=3); all other degrees stay null.
 *  - nothing configured → all degrees stay null and, once the topology spans
 *    >1 node, `unknown` is true (2 nodes ≠ TP2, 3 nodes ≠ TP3).
 *
 * @param {object} body
 * @param {number|null} nodeCount explicit node count (falls back to body.nodeIds)
 */
export function normalizeTopology(body = {}, nodeCount = null) {
  const t = body.topology;
  const src = t && typeof t === "object" && !Array.isArray(t) ? t : null;
  let mode = src?.mode ?? (typeof t === "string" && V1_TOPOLOGY[t] ? (V1_TOPOLOGY[t] > 1 ? "tp" : "single") : t);
  if (!TOPOLOGY_MODES.includes(mode)) mode = "single";
  const legacyParallelism = src
    ? Number(src.parallelism) || V1_TOPOLOGY[t] || 1
    : typeof t === "string" && V1_TOPOLOGY[t]
      ? V1_TOPOLOGY[t]
      : 1;
  let parallelism = Number.isFinite(legacyParallelism) && legacyParallelism >= 1 ? Math.round(legacyParallelism) : 1;

  const explicit = {
    tp: degreeOrNull(src?.tp),
    pp: degreeOrNull(src?.pp),
    dp: degreeOrNull(src?.dp),
    ep: degreeOrNull(src?.ep),
  };
  const explicitConfigured = TOPOLOGY_DEGREE_KEYS.some((k) => explicit[k] != null);
  const degrees = explicitConfigured ? explicit : { tp: null, pp: null, dp: null, ep: null };
  if (!explicitConfigured && mode !== "single") degrees[mode] = parallelism;

  if (explicitConfigured) {
    const present = TOPOLOGY_DEGREE_KEYS.filter((k) => degrees[k] != null);
    mode = present.reduce((best, k) => (degrees[k] > (degrees[best] ?? 0) ? k : best), present[0]);
    parallelism = present.reduce((product, k) => product * degrees[k], 1);
  }

  const minNodes = Math.max(1, degreeOrNull(src?.minNodes) ?? parallelism);
  const maxNodes = Math.max(minNodes, degreeOrNull(src?.maxNodes) ?? minNodes);

  const rawCount = nodeCount ?? (Array.isArray(body.nodeIds) ? body.nodeIds.length : 0);
  const count = Number.isFinite(Number(rawCount)) && Number(rawCount) > 0 ? Math.round(Number(rawCount)) : 0;
  const unknown = !explicitConfigured && TOPOLOGY_DEGREE_KEYS.every((k) => degrees[k] == null) && count > 1;

  return {
    mode,
    parallelism,
    tp: degrees.tp,
    pp: degrees.pp,
    dp: degrees.dp,
    ep: degrees.ep,
    coordinator: src?.coordinator != null ? String(src.coordinator).trim() || null : null,
    workers: degreeOrNull(src?.workers),
    minNodes,
    maxNodes,
    nodeConstraints: src?.nodeConstraints && typeof src.nodeConstraints === "object" ? src.nodeConstraints : {},
    unknown,
  };
}

/** Legacy topology slug ("single"|"tp2"|"tp3") derived from a v2 topology block. */
export function topologySlug(topo) {
  if (!topo || topo.mode === "single") return "single";
  return `${topo.mode}${Number(topo.parallelism) || 1}`;
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Derive executable/args from a rendered command string (legacy launcher). */
function splitCommand(command) {
  const parts = String(command || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { executable: null, args: [] };
  return { executable: parts[0], args: parts.slice(1) };
}

/**
 * Normalize a recipe body (v1 flat or v2 structured) into a v2 recipe.
 * @param {object} body
 * @param {object|null} prev existing stored recipe for secret/createdAt carry-over
 */
export function normalizeRecipe(body = {}, prev = null) {
  const id = body.id ?? prev?.id;
  const modelRefSrc = body.modelRef && typeof body.modelRef === "object" ? body.modelRef : null;
  const modelId = modelRefSrc?.modelId ?? body.modelId ?? prev?.modelRef?.modelId;

  const engineSrc = body.engine && typeof body.engine === "object" ? body.engine : null;
  const runtime = engineSrc?.runtime ?? body.runtime ?? prev?.engine?.runtime ?? "custom";
  const quantization = engineSrc?.quantization ?? body.quantization ?? prev?.engine?.quantization ?? null;
  const apiProtocol = engineSrc?.apiProtocol ?? body.apiProtocol ?? prev?.engine?.apiProtocol ?? "openai";

  const servingSrc = body.serving && typeof body.serving === "object" ? body.serving : null;
  const contextLength = numOrNull(servingSrc?.contextLength ?? body.contextLength ?? prev?.serving?.contextLength);
  const maxParallel = numOrNull(servingSrc?.maxParallel ?? body.maxParallel ?? prev?.serving?.maxParallel);
  let flags = Array.isArray(servingSrc?.flags) ? servingSrc.flags : Array.isArray(body.flags) ? body.flags : null;
  if (!flags && body.cpuAffinity) flags = [{ name: "cpuAffinity", value: String(body.cpuAffinity) }];
  flags = (flags || prev?.serving?.flags || []).map((f) => ({
    name: String(f?.name ?? "").trim(),
    value: f?.value == null ? null : String(f.value),
  }));

  const launchSrc = body.launch && typeof body.launch === "object" ? body.launch : null;
  let command = launchSrc?.command ?? body.launcher ?? prev?.launch?.command ?? null;
  let executable = launchSrc?.executable ?? null;
  let args = Array.isArray(launchSrc?.args) ? launchSrc.args.map(String) : null;
  if (!executable && command) {
    const split = splitCommand(command);
    executable = split.executable;
    if (args === null) args = split.args;
  }
  const mechanism = LAUNCH_MECHANISMS.includes(launchSrc?.mechanism)
    ? launchSrc.mechanism
    : LAUNCH_MECHANISMS.includes(body.launchMechanism)
      ? body.launchMechanism
      : prev?.launch?.mechanism ?? "command";

  // Env: secret entries keep secretRef (never the value).
  const prevEnv = new Map((prev?.launch?.env || []).map((e) => [e.name, e]));
  const rawEnv = Array.isArray(launchSrc?.env) ? launchSrc.env : Array.isArray(body.env) ? body.env : prev?.launch?.env || [];
  const env = rawEnv.map((e) => {
    const stored = prevEnv.get(e?.name);
    const isSecret = Boolean(e?.secret) || Boolean(e?.secretRef);
    const ref = e?.secretRef || stored?.secretRef || (isSecret ? `recipe:${id}:${quoteClamp(e?.name)}` : null);
    if (isSecret) {
      // Value lives in the encrypted secrets store; in-memory only for hasValue.
      const storedVal = loadRecipeEnv().get(ref);
      const value =
        e?.value != null && e.value !== "" ? String(e.value) : stored?.value ?? storedVal ?? null;
      return { name: String(e?.name ?? "").trim(), secretRef: ref, value };
    }
    const value = e?.value != null ? String(e.value) : stored?.value ?? "";
    return { name: String(e?.name ?? "").trim(), value, secretRef: null };
  });

  const endpointSrc = body.endpoint && typeof body.endpoint === "object" ? body.endpoint : null;
  const endpoint = {
    scheme: endpointSrc?.scheme === "https" ? "https" : "http",
    hostTemplate: endpointSrc?.hostTemplate || "{nodeIp}",
    port: numOrNull(endpointSrc?.port ?? body.apiPort ?? prev?.endpoint?.port),
    path: endpointSrc?.path || body.endpointPath || prev?.endpoint?.path || "/v1",
  };

  const probeSrc = body.healthProbe && typeof body.healthProbe === "object" ? body.healthProbe : null;
  const healthProbe = {
    kind: PROBE_KINDS.includes(probeSrc?.kind) ? probeSrc.kind : prev?.healthProbe?.kind ?? "http",
    path: probeSrc?.path ?? body.healthPath ?? prev?.healthProbe?.path ?? "/v1/models",
    expectUp: Array.isArray(probeSrc?.expectUp) ? probeSrc.expectUp : [200, 401, 403],
  };

  const discoverySrc = body.discovery && typeof body.discovery === "object" ? body.discovery : null;
  const discovery = {
    strategy: DISCOVERY_STRATEGIES.includes(discoverySrc?.strategy)
      ? discoverySrc.strategy
      : prev?.discovery?.strategy ?? "process",
  };

  const logSrc = body.logSource && typeof body.logSource === "object" ? body.logSource : null;
  const logSource = {
    kind: LOG_KINDS.includes(logSrc?.kind) ? logSrc.kind : prev?.logSource?.kind ?? "file",
    path: logSrc?.path ?? body.logDir ?? prev?.logSource?.path ?? null,
  };

  const lcSrc = body.lifecycleCommands && typeof body.lifecycleCommands === "object" ? body.lifecycleCommands : null;
  const lifecycleCommands = {
    start: lcSrc?.start ?? prev?.lifecycleCommands?.start ?? null,
    stop: lcSrc?.stop ?? prev?.lifecycleCommands?.stop ?? null,
    status: lcSrc?.status ?? prev?.lifecycleCommands?.status ?? null,
  };
  // Guard: an EXTERNAL runtime is launched outside SparkDash, so any inherited
  // lifecycle command must be dropped — else it looks controllable.
  if (mechanism === "external") {
    lifecycleCommands.start = null;
    lifecycleCommands.stop = null;
    lifecycleCommands.status = null;
  }

  const topology = normalizeTopology(body);

  const recipe = {
    id,
    schemaVersion: 2,
    modelRef: modelId ? { modelId, weightId: modelRefSrc?.weightId ?? body.weightId ?? null } : null,
    name: String(body.name ?? prev?.name ?? "").trim(),
    engine: { runtime, quantization, apiProtocol },
    serving: { contextLength, maxParallel, flags },
    launch: {
      mechanism,
      executable,
      args: args ?? [],
      command,
      workdir: body.workdir ?? launchSrc?.workdir ?? prev?.launch?.workdir ?? null,
      affinity: body.cpuAffinity ?? launchSrc?.affinity ?? prev?.launch?.affinity ?? null,
      env,
    },
    endpoint,
    topology,
    healthProbe,
    discovery,
    logSource,
    lifecycleCommands,
    // Legacy convenience: node binding hint. Canonical binding lives in deployments.
    nodeIds: Array.isArray(body.nodeIds) ? [...new Set(body.nodeIds)] : [...(prev?.nodeIds || [])],
    tags: Array.isArray(body.tags) ? body.tags.map(String) : prev?.tags ?? [],
    metadata: body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) ? body.metadata : prev?.metadata ?? {},
    lifecycleState: body.lifecycleState ?? prev?.lifecycleState ?? "draft",
    provenance: body.provenance ?? prev?.provenance ?? {},
    notes: body.notes ?? prev?.notes ?? "",
    archived:
      body.archived != null
        ? Boolean(body.archived)
        : prev?.archived != null
          ? Boolean(prev.archived)
          : (body.lifecycleState ?? prev?.lifecycleState) === "archived",
    createdAt: body.createdAt ?? prev?.createdAt ?? Date.now(),
    updatedAt: body.updatedAt ?? Date.now(),
  };
  // Legacy top-level alias so older consumers/tests keep reading `env`.
  recipe.env = recipe.launch.env;
  return recipe;
}

/** Normalize a model body (v1 flat or v2). */
export function normalizeModel(body = {}, prev = null) {
  const weightPathsSrc = body.weightPaths && typeof body.weightPaths === "object" ? body.weightPaths : null;
  const weightPaths = weightPathsSrc
    ? { ...weightPathsSrc }
    : { ...(prev?.weightPaths || {}) };
  // Legacy single modelPath lands on the default variant.
  if (body.modelPath) weightPaths.default = body.modelPath;
  if (!weightPaths.default && prev?.weightPaths?.default) weightPaths.default = prev.weightPaths.default;

  const archived = Boolean(body.archived ?? prev?.archived ?? false);
  return {
    id: body.id ?? prev?.id,
    schemaVersion: 2,
    name: String(body.name ?? prev?.name ?? "").trim(),
    family: body.family != null ? String(body.family).trim() : prev?.family ?? null,
    weightPaths,
    archived,
    archivedAt: archived ? prev?.archivedAt ?? (body.archivedAt ?? Date.now()) : null,
    tags: Array.isArray(body.tags) ? body.tags.map(String) : prev?.tags ?? [],
    notes: body.notes != null ? String(body.notes) : prev?.notes ?? "",
    createdAt: body.createdAt ?? prev?.createdAt ?? Date.now(),
    updatedAt: body.updatedAt ?? Date.now(),
  };
}

/** Normalize a deployment binding body. */
export function normalizeDeployment(body = {}, prev = null) {
  const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) ? body.metadata : prev?.metadata ?? {};
  const managedBy = metadata.managedBy === "external" ? "external" : metadata.managedBy ?? null;
  let desiredState = ["running", "stopped", "unknown"].includes(body.desiredState)
    ? body.desiredState
    : prev?.desiredState ?? "unknown";
  // An external runtime has no SparkDash intent → desired must stay 'unknown'.
  if (managedBy === "external") desiredState = "unknown";
  // OPTIONAL explicit role (owner's mental model). Absent => FE heuristic.
  // Legacy "edge" folds onto "worker" (back-compat, config-only normalisation).
  const role = normalizeDeploymentRole(body.role) ?? normalizeDeploymentRole(prev?.role);
  return {
    id: body.id ?? prev?.id,
    schemaVersion: 2,
    modelId: body.modelId ?? prev?.modelId,
    recipeId: body.recipeId ?? prev?.recipeId,
    nodeIds: Array.isArray(body.nodeIds) ? [...new Set(body.nodeIds)] : [...(prev?.nodeIds || [])],
    desiredState,
    role,
    metadata,
    createdAt: body.createdAt ?? prev?.createdAt ?? Date.now(),
    updatedAt: body.updatedAt ?? Date.now(),
  };
}

// ─── Validators (pure) ────────────────────────────────────

/** @returns {{ok: boolean, errors: string[]}} */
export function validateModel(recipe) {
  const errors = [];
  if (!isValidSlug(recipe?.id)) errors.push("model id must be a lowercase slug (a-z0-9._-)");
  if (!isValidNoteText(recipe?.name || "") || !recipe?.name?.trim())
    errors.push("model name is required (≤4096 chars)");
  if (recipe?.family != null && !isValidNoteText(String(recipe.family))) errors.push("family must be plain text");
  if (recipe?.notes != null && !isValidNoteText(recipe.notes)) errors.push("notes must be plain text ≤4096 chars");
  const wp = recipe?.weightPaths;
  if (!wp || typeof wp !== "object" || Array.isArray(wp)) {
    errors.push("weightPaths must be an object of variantId -> absolute path");
  } else {
    for (const [variant, p] of Object.entries(wp)) {
      if (variant !== "default" && !WEIGHT_ID_RE.test(variant)) errors.push(`invalid weight variant id: ${variant}`);
      if (p != null && !isValidPosixPath(p)) errors.push(`weightPaths.${variant} must be an absolute POSIX path`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** @returns {{ok: boolean, errors: string[]}} */
export function validateRecipeV2(recipe) {
  const errors = [];
  if (!isValidSlug(recipe?.id)) errors.push("recipe id must be a lowercase slug (a-z0-9._-)");
  if (!recipe?.modelRef?.modelId || !isValidSlug(recipe.modelRef.modelId))
    errors.push("modelRef.modelId must be a lowercase slug");
  if (recipe?.modelRef?.weightId && !WEIGHT_ID_RE.test(recipe.modelRef.weightId))
    errors.push("modelRef.weightId must be a variant slug");
  if (!isValidNoteText(recipe?.name || "") || !recipe?.name?.trim())
    errors.push("recipe name is required (≤4096 chars, no control characters)");
  if (!RECIPE_RUNTIMES.includes(recipe?.engine?.runtime))
    errors.push(`engine.runtime must be one of: ${RECIPE_RUNTIMES.join(", ")}`);
  if (recipe?.engine?.apiProtocol && !API_PROTOCOLS.includes(recipe.engine.apiProtocol))
    errors.push(`engine.apiProtocol must be one of: ${API_PROTOCOLS.join(", ")}`);
  if (!TOPOLOGY_MODES.includes(recipe?.topology?.mode))
    errors.push(`topology.mode must be one of: ${TOPOLOGY_MODES.join(", ")}`);
  const topo = recipe?.topology || {};
  if (!Number.isInteger(topo.minNodes) || topo.minNodes < 1) errors.push("topology.minNodes must be ≥1");
  if (!Number.isInteger(topo.maxNodes) || topo.maxNodes < topo.minNodes) errors.push("topology.maxNodes must be ≥ minNodes");
  const nodes = Array.isArray(recipe?.nodeIds) ? recipe.nodeIds : [];
  if (new Set(nodes).size !== nodes.length) errors.push("nodeIds must be unique");
  if (nodes.length > 0 && (nodes.length < topo.minNodes || nodes.length > topo.maxNodes))
    errors.push(
      topo.minNodes === topo.maxNodes
        ? `topology ${topo.mode}${topo.parallelism} requires exactly ${topo.minNodes} node(s)`
        : `topology ${topo.mode}${topo.parallelism} requires ${topo.minNodes}–${topo.maxNodes} node(s)`
    );
  if (!LAUNCH_MECHANISMS.includes(recipe?.launch?.mechanism))
    errors.push(`launch.mechanism must be one of: ${LAUNCH_MECHANISMS.join(", ")}`);
  if (recipe?.launch?.mechanism === "external") {
    const lc = recipe?.lifecycleCommands || {};
    if (lc.start || lc.stop || lc.status)
      errors.push("external mechanism must not carry lifecycleCommands (normalizer nulls them)");
  }
  if (recipe?.launch?.workdir != null && recipe.launch.workdir !== "" && !isValidPosixPath(recipe.launch.workdir))
    errors.push("launch.workdir must be an absolute POSIX path without .. or shell metacharacters");
  if (recipe?.launch?.executable != null && !isValidNoteText(String(recipe.launch.executable)))
    errors.push("launch.executable must be plain text");
  if (recipe?.launch?.affinity != null && recipe.launch.affinity !== "" && !isValidCpuAffinity(recipe.launch.affinity))
    errors.push('launch.affinity (cpuAffinity) must be a taskset list like "5-9,15-19"');
  if (recipe?.launch?.command != null && recipe.launch.command !== "") {
    if (!isValidNoteText(recipe.launch.command)) errors.push("launch.command must be plain text ≤4096 chars");
    if (/(`|\$\(|rm\s+-rf|mkfs|dd\s+if=|:\(\)\s*\{)/.test(recipe.launch.command))
      errors.push("launch.command contains forbidden shell constructs");
  }
  const env = Array.isArray(recipe?.launch?.env) ? recipe.launch.env : [];
  if (env.length > 64) errors.push("too many env vars (max 64)");
  const seenEnv = new Set();
  for (const e of env) {
    if (!isValidEnvName(e?.name)) {
      errors.push(`invalid env var name: ${String(e?.name).slice(0, 64)}`);
      continue;
    }
    if (seenEnv.has(e.name)) errors.push(`duplicate env var: ${e.name}`);
    seenEnv.add(e.name);
    const isSecret = Boolean(e.secretRef);
    if (isSecret) {
      if (!/^recipe:[a-z0-9._-]+:[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(e.secretRef))
        errors.push(`invalid secretRef for ${e.name}`);
    } else if (!isValidEnvValue(e?.value == null ? "" : String(e.value))) {
      errors.push(`invalid env var value for ${e.name}`);
    }
  }
  if (!isValidPort(recipe?.endpoint?.port)) errors.push("endpoint.port (apiPort) must be an integer 1–65535");
  if (!isValidHealthPath(recipe?.healthProbe?.path)) errors.push('healthProbe.path must look like "/v1/models"');
  if (!PROBE_KINDS.includes(recipe?.healthProbe?.kind)) errors.push(`healthProbe.kind must be one of: ${PROBE_KINDS.join(", ")}`);
  if (!DISCOVERY_STRATEGIES.includes(recipe?.discovery?.strategy))
    errors.push(`discovery.strategy must be one of: ${DISCOVERY_STRATEGIES.join(", ")}`);
  if (!LOG_KINDS.includes(recipe?.logSource?.kind)) errors.push(`logSource.kind must be one of: ${LOG_KINDS.join(", ")}`);
  if (recipe?.logSource?.path != null && recipe.logSource.path !== "" && !isValidPosixPath(recipe.logSource.path))
    errors.push("logSource.path must be an absolute POSIX path");
  if (recipe?.serving?.contextLength != null) {
    const c = Number(recipe.serving.contextLength);
    if (!Number.isInteger(c) || c < 1 || c > 10_000_000) errors.push("serving.contextLength must be 1–10000000");
  }
  if (recipe?.notes != null && !isValidNoteText(recipe.notes)) errors.push("notes must be plain text ≤4096 chars");
  if (!LIFECYCLE_STATES.includes(recipe?.lifecycleState)) errors.push("invalid lifecycleState");
  return { ok: errors.length === 0, errors };
}

/** @returns {{ok: boolean, errors: string[]}} */
export function validateDeployment(dep) {
  const errors = [];
  if (!isValidSlug(dep?.id)) errors.push("deployment id must be a lowercase slug");
  if (!isValidSlug(dep?.modelId)) errors.push("modelId must be a lowercase slug");
  if (!isValidSlug(dep?.recipeId)) errors.push("recipeId must be a lowercase slug");
  if (!Array.isArray(dep?.nodeIds) || dep.nodeIds.length === 0) errors.push("at least one node is required");
  if (new Set(dep?.nodeIds || []).size !== (dep?.nodeIds || []).length) errors.push("nodeIds must be unique");
  for (const n of dep?.nodeIds || []) if (!isValidSlug(n)) errors.push(`invalid node id: ${n}`);
  if (!["running", "stopped", "unknown"].includes(dep?.desiredState)) errors.push("desiredState must be running|stopped|unknown");
  if (dep?.role != null && !normalizeDeploymentRole(dep.role))
    errors.push(`role must be one of: ${DEPLOYMENT_ROLES.join(", ")}`);
  return { ok: errors.length === 0, errors };
}

export { numOrNull };
