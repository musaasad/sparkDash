import type {
  DecodeBenchJob,
  DecodeBenchListResponse,
  FleetEnergy,
  HermesBatchUpdateResponse,
  HermesUpdatesResponse,
  LlmMetrics,
  LlmDailyResponse,
  Settings,
  ShowcaseListResponse,
  ShowcaseSessionState,
  ShowcaseStartRequest,
  ShowcaseStartResponse,
  SparkConfig,
  SparkTestResponse,
  StartDecodeBenchRequest,
  PrefillBenchJob,
  PrefillBenchListResponse,
  StartPrefillBenchRequest,
} from "./types";

const BASE = "";
const TOKEN = (typeof localStorage !== "undefined" && localStorage.getItem("sparkdashToken")) || "";

function authHeaders(): Record<string, string> {
  return TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
}

// ─── Generic fetch wrapper ────────────────────────────────
async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  // Only set Content-Type for requests that actually carry a body. Setting it
  // on GET/DELETE was a no-op but could trigger an unnecessary CORS preflight
  // (OPTIONS) in some proxy setups.
  const headers: Record<string, string> = {};
  if (opts?.body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { ...headers, ...authHeaders(), ...(opts?.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── Sparks CRUD ─────────────────────────────────────────
export function fetchSparks(): Promise<{ sparks: SparkConfig[] }> {
  return apiFetch("/api/sparks");
}

export function fetchFleetEnergy(): Promise<FleetEnergy> {
  return apiFetch("/api/fleet-energy");
}

/** Latest metrics snapshot for one Spark (includes per-port LLM modelId). */
export function fetchSparkMetrics(id: string): Promise<{
  metrics?: { llm?: LlmMetrics[] };
}> {
  return apiFetch(`/api/sparks/${id}/metrics`);
}

/** Daily busy tok/s rollups for one Spark LLM port. */
export function fetchLlmDaily(
  id: string,
  port: number,
  days = 14
): Promise<LlmDailyResponse> {
  const q = new URLSearchParams({ port: String(port), days: String(days) });
  return apiFetch(`/api/sparks/${encodeURIComponent(id)}/llm/daily?${q.toString()}`);
}

export function addSpark(config: SparkConfig): Promise<{ success: boolean; spark: SparkConfig }> {
  return apiFetch("/api/sparks", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

export function updateSpark(
  id: string,
  patch: Partial<SparkConfig>
): Promise<{ success: boolean; spark: SparkConfig }> {
  return apiFetch(`/api/sparks/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteSpark(id: string): Promise<{ success: boolean; removed: SparkConfig }> {
  return apiFetch(`/api/sparks/${id}`, { method: "DELETE" });
}

/** Persist tab bar order (array of spark ids). */
export function reorderSparks(
  order: string[]
): Promise<{ success: boolean; sparks: SparkConfig[] }> {
  return apiFetch("/api/sparks/order", {
    method: "PUT",
    body: JSON.stringify({ order }),
  });
}

/** Save SSH password only (works while the host is offline). */
export function setSparkPassword(
  id: string,
  password: string
): Promise<{ success: boolean; spark: SparkConfig; hasPassword: boolean }> {
  return apiFetch(`/api/sparks/${id}/password`, {
    method: "PUT",
    body: JSON.stringify({ password }),
  });
}

// ─── Test connectivity ────────────────────────────────────
/** Test a registered Spark by id */
export function testSpark(id: string): Promise<SparkTestResponse> {
  return apiFetch(`/api/sparks/${id}/test`, { method: "POST" });
}

/** Ephemeral test — does not persist a Spark or start a monitor */
export function testSparkConfig(config: Omit<SparkConfig, "id"> & { id?: string }): Promise<SparkTestResponse> {
  return apiFetch("/api/sparks/test", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

/** Cancel a ComfyUI job (interrupt running and/or remove from queue). */
export function cancelComfyJob(
  sparkId: string,
  promptId: string
): Promise<{ success: boolean; ok?: boolean; method?: string; message?: string }> {
  return apiFetch(`/api/sparks/${encodeURIComponent(sparkId)}/comfy/cancel`, {
    method: "POST",
    body: JSON.stringify({ promptId }),
  });
}

// ─── Disabled storage devices ─────────────────────────────
export function updateDisabledDevices(
  id: string,
  disabledDevices: string[]
): Promise<{ success: boolean; disabledDevices: string[] }> {
  return apiFetch(`/api/sparks/${id}/disabled-devices`, {
    method: "PUT",
    body: JSON.stringify({ disabledDevices }),
  });
}

// ─── Disabled network interfaces ──────────────────────────
export function updateDisabledInterfaces(
  id: string,
  disabledInterfaces: string[]
): Promise<{ success: boolean; disabledInterfaces: string[] }> {
  return apiFetch(`/api/sparks/${id}/disabled-interfaces`, {
    method: "PUT",
    body: JSON.stringify({ disabledInterfaces }),
  });
}

// ─── Manual metric refresh ────────────────────────────────
export function refreshSparkMetric(
  id: string,
  domain: string
): Promise<{ success: boolean; domain: string }> {
  return apiFetch(`/api/sparks/${id}/refresh/${domain}`, { method: "POST" });
}

// ─── LLM decode benchmark ─────────────────────────────
/** Start an async decode bench (returns 202 job). */
export function startDecodeBench(
  id: string,
  body: StartDecodeBenchRequest
): Promise<DecodeBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/bench`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getDecodeBench(
  id: string,
  benchId: string
): Promise<DecodeBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/bench/${benchId}`);
}

export function listDecodeBench(
  id: string,
  port?: number
): Promise<DecodeBenchListResponse> {
  const q =
    port != null && Number.isInteger(port) ? `?port=${encodeURIComponent(port)}` : "";
  return apiFetch(`/api/sparks/${id}/llm/bench${q}`);
}

export function cancelDecodeBench(
  id: string,
  benchId: string
): Promise<DecodeBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/bench/${benchId}`, {
    method: "DELETE",
  });
}

/** Clear finished benchmark history for a Spark (optionally one LLM port). */
export function clearDecodeBenchHistory(
  id: string,
  port?: number
): Promise<{ success: boolean }> {
  const q =
    port != null && Number.isInteger(port) ? `?port=${encodeURIComponent(port)}` : "";
  return apiFetch(`/api/sparks/${id}/llm/bench${q}`, { method: "DELETE" });
}

// ─── LLM prefill benchmark ────────────────────────────
export function startPrefillBench(
  id: string,
  body: StartPrefillBenchRequest
): Promise<PrefillBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/prefill-bench`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getPrefillBench(
  id: string,
  benchId: string
): Promise<PrefillBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/prefill-bench/${benchId}`);
}

export function listPrefillBench(
  id: string,
  port?: number
): Promise<PrefillBenchListResponse> {
  const q =
    port != null && Number.isInteger(port) ? `?port=${encodeURIComponent(port)}` : "";
  return apiFetch(`/api/sparks/${id}/llm/prefill-bench${q}`);
}

export function cancelPrefillBench(
  id: string,
  benchId: string
): Promise<PrefillBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/prefill-bench/${benchId}`, {
    method: "DELETE",
  });
}

export function clearPrefillBenchHistory(
  id: string,
  port?: number
): Promise<{ success: boolean }> {
  const q =
    port != null && Number.isInteger(port) ? `?port=${encodeURIComponent(port)}` : "";
  return apiFetch(`/api/sparks/${id}/llm/prefill-bench${q}`, { method: "DELETE" });
}

// ─── LLM Prompt Showcase ──────────────────────────────
/** Start a concurrent prompt showcase (returns 202 session). */
export function startShowcase(
  id: string,
  body: ShowcaseStartRequest
): Promise<ShowcaseStartResponse> {
  return apiFetch(`/api/sparks/${id}/llm/showcase`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Active session + finished history summaries. */
export function listShowcase(id: string): Promise<ShowcaseListResponse> {
  return apiFetch(`/api/sparks/${id}/llm/showcase`);
}

export function getShowcase(
  id: string,
  sessionId: string,
  opts?: { since?: number }
): Promise<ShowcaseSessionState> {
  const q =
    opts?.since != null && Number.isFinite(opts.since)
      ? `?since=${encodeURIComponent(String(opts.since))}`
      : "";
  return apiFetch(`/api/sparks/${id}/llm/showcase/${sessionId}${q}`);
}

export function cancelShowcase(
  id: string,
  sessionId: string
): Promise<ShowcaseSessionState> {
  return apiFetch(`/api/sparks/${id}/llm/showcase/${sessionId}`, {
    method: "DELETE",
  });
}

/** Clear finished showcase history for a Spark. */
export function clearShowcaseHistory(
  id: string
): Promise<{ success: boolean }> {
  return apiFetch(`/api/sparks/${id}/llm/showcase`, { method: "DELETE" });
}

// ─── LLM probe ports (per Spark) ─────────────────────────
/** Replace all LLM ports for a Spark (hot update). */
export function updateLlmPorts(
  id: string,
  llmPorts: number[]
): Promise<{ success: boolean; llmPorts: number[] }> {
  return apiFetch(`/api/sparks/${id}/llm-ports`, {
    method: "PUT",
    body: JSON.stringify({ llmPorts }),
  });
}

/** Add a single LLM port to a Spark (hot update). */
export function addLlmPort(
  id: string,
  port: number
): Promise<{ success: boolean; llmPorts: number[] }> {
  return apiFetch(`/api/sparks/${id}/llm-ports`, {
    method: "POST",
    body: JSON.stringify({ port }),
  });
}

/** Remove an LLM port from a Spark (hot update). */
export function removeLlmPort(
  id: string,
  port: number
): Promise<{ success: boolean; llmPorts: number[] }> {
  return apiFetch(`/api/sparks/${id}/llm-ports/${port}`, {
    method: "DELETE",
  });
}

/** Backward-compat: replace all ports via the legacy single-port endpoint. */
export function updateLlmPort(
  id: string,
  llmPort: number
): Promise<{ success: boolean; llmPort: number; llmPorts: number[] }> {
  return apiFetch(`/api/sparks/${id}/llm-port`, {
    method: "PUT",
    body: JSON.stringify({ llmPort }),
  });
}

/**
 * Set or clear an optional LLM API key for one port.
 * Pass apiKey "" to clear. Key is stored encrypted server-side and never returned.
 */
export function setLlmApiKey(
  id: string,
  port: number,
  apiKey: string
): Promise<{
  success: boolean;
  hasApiKey: boolean;
  llmApiKeyPorts: number[];
}> {
  return apiFetch(`/api/sparks/${id}/llm-ports/${port}/api-key`, {
    method: "PUT",
    body: JSON.stringify({ apiKey }),
  });
}

// ─── Hermes Agent ────────────────────────────────────
/** One-click `hermes update` via SSH on the Spark (background job; 202 when started). */
export function updateHermes(id: string): Promise<{ success: boolean; reason?: string }> {
  return apiFetch(`/api/sparks/${id}/hermes/update`, { method: "POST" });
}

/** Run `hermes update` on every Spark with Hermes Agent monitoring enabled. */
export function updateAllHermes(): Promise<HermesBatchUpdateResponse> {
  return apiFetch("/api/sparks/hermes/update-all", { method: "POST" });
}

/** Force an immediate `hermes update --check` on the Spark. */
export function checkHermes(id: string): Promise<{ success: boolean }> {
  return apiFetch(`/api/sparks/${id}/hermes/check`, { method: "POST" });
}

// ─── Power management ────────────────────────────────────
export interface PowerResult {
  success: boolean;
  message?: string;
  output?: string;
  mac?: string;
  broadcast?: string;
  error?: string;
}

export interface BatchPowerResult {
  success: boolean;
  results: {
    id: string;
    ok: boolean;
    error?: string;
    skipped?: boolean;
    mac?: string;
    broadcast?: string;
  }[];
}

/** Gracefully shut down a single Spark (host script: spark-shutdown). */
export function shutdownSpark(id: string): Promise<PowerResult> {
  return apiFetch(`/api/sparks/${id}/shutdown`, { method: "POST" });
}

/** Send a Wake-on-LAN magic packet to a single Spark. */
export function wakeSpark(id: string): Promise<PowerResult> {
  return apiFetch(`/api/sparks/${id}/wake`, { method: "POST" });
}

/** Shut down Sparks that are currently online. */
export function shutdownAllSparks(): Promise<BatchPowerResult> {
  return apiFetch("/api/sparks/shutdown-all", { method: "POST" });
}

/** Send WoL to all registered Sparks that have a MAC configured. */
export function wakeAllSparks(): Promise<BatchPowerResult> {
  return apiFetch("/api/sparks/wake-all", { method: "POST" });
}

// ─── Hermes update preview ───────────────────────────────
/** Per-Spark update preview (release + pending commits + resolved view). */
export function fetchHermesUpdates(id: string): Promise<HermesUpdatesResponse> {
  return apiFetch(`/api/sparks/${encodeURIComponent(id)}/hermes/updates`);
}

// ─── Global settings ──────────────────────────────────────
export function fetchSettings(): Promise<Settings> {
  return apiFetch("/api/settings");
}

export function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  return apiFetch("/api/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

// ─── Control plane: runtime provider catalog (read-only, WS-3) ─
export function fetchRuntimes(): Promise<{ runtimes: RuntimeProviderInfo[] }> {
  return apiFetch("/api/runtimes");
}

// ─── Control plane: Model Registry ────────────────────────
import type {
  ModelEntry,
  RecipePublic,
  RecipeValidateResponse,
  RecipeLifecycleState,
  DeploymentStatus,
  DeploymentBinding,
  DeploymentDesired,
  DeploymentRole,
  ActivityEvent,
  AuditEntry,
  DiscoveryResponse,
  AdoptDiscoveryRequest,
  AdoptDiscoveryResult,
  DiscoveryProbeRequest,
  DiscoveryProbeResult,
  ProbeCapabilitiesRequest,
  ProbeCapabilitiesResult,
  RuntimeProviderInfo,
  ComputeDiscoveryRequest,
  ComputeDiscoveryResult,
  ComputeValidateResult,
  WeightsScanRequest,
  WeightsScanResult,
} from "./types";

export function fetchModels(includeArchived = false): Promise<{ models: ModelEntry[] }> {
  return apiFetch(`/api/models${includeArchived ? "?includeArchived=1" : ""}`);
}

export function upsertModel(body: Partial<ModelEntry> & { id: string; name: string }): Promise<{ model: ModelEntry }> {
  return apiFetch("/api/models", { method: "POST", body: JSON.stringify(body) });
}

export function fetchModel(id: string): Promise<{
  model: ModelEntry;
  recipes: RecipePublic[];
  deployments: DeploymentStatus[];
}> {
  return apiFetch(`/api/models/${encodeURIComponent(id)}`);
}

export function archiveModel(id: string, hard = false): Promise<{ archived?: boolean; deleted?: boolean }> {
  return apiFetch(`/api/models/${encodeURIComponent(id)}${hard ? "?hard=1" : ""}`, { method: "DELETE" });
}

export function restoreModel(id: string): Promise<{ model: ModelEntry }> {
  return apiFetch(`/api/models/${encodeURIComponent(id)}/restore`, { method: "POST" });
}

// ─── Control plane: Recipes ───────────────────────────────
export function fetchRecipes(includeArchived = false): Promise<{ recipes: RecipePublic[] }> {
  return apiFetch(`/api/recipes${includeArchived ? "?includeArchived=1" : ""}`);
}

export function upsertRecipe(body: unknown): Promise<{ recipe: RecipePublic }> {
  return apiFetch("/api/recipes", { method: "POST", body: JSON.stringify(body) });
}

export function archiveRecipe(id: string, hard = false): Promise<{ archived?: boolean; deleted?: boolean }> {
  return apiFetch(`/api/recipes/${encodeURIComponent(id)}${hard ? "?hard=1" : ""}`, { method: "DELETE" });
}

export function restoreRecipe(id: string): Promise<{ recipe: RecipePublic }> {
  return apiFetch(`/api/recipes/${encodeURIComponent(id)}/restore`, { method: "POST" });
}

export function cloneRecipe(id: string, newId: string, overrides?: Record<string, unknown>): Promise<{ recipe: RecipePublic }> {
  return apiFetch(`/api/recipes/${encodeURIComponent(id)}/clone`, {
    method: "POST",
    body: JSON.stringify({ id: newId, overrides }),
  });
}

/** Deep-copy a recipe as a new draft (provenance reset + sourceRecipeId). */
export function duplicateRecipe(id: string, newId?: string, overrides?: Record<string, unknown>): Promise<{ recipe: RecipePublic }> {
  return apiFetch(`/api/recipes/${encodeURIComponent(id)}/duplicate`, {
    method: "POST",
    body: JSON.stringify({ id: newId, overrides }),
  });
}

/** Dry-run feasibility validation — never executes commands. */
export function validateRecipe(id: string, nodeIds?: string[]): Promise<RecipeValidateResponse> {
  return apiFetch(`/api/recipes/${encodeURIComponent(id)}/validate`, {
    method: "POST",
    body: JSON.stringify({ nodeIds }),
  });
}

/** Validate an UNSAVED recipe body — no entity is persisted. */
export function validateDraftRecipe(body: unknown, nodeIds?: string[]): Promise<RecipeValidateResponse> {
  const payload = body && typeof body === "object" ? { ...(body as Record<string, unknown>), nodeIds } : { nodeIds };
  return apiFetch("/api/recipes/validate", { method: "POST", body: JSON.stringify(payload) });
}

export function recipeLifecycle(id: string, to: RecipeLifecycleState, note?: string): Promise<{ recipe: RecipePublic }> {
  return apiFetch(`/api/recipes/${encodeURIComponent(id)}/lifecycle`, {
    method: "POST",
    body: JSON.stringify({ to, note }),
  });
}

// ─── Control plane: Deployments (bindings + DRY-RUN lifecycle) ─
export function fetchDeployments(): Promise<{ deployments: DeploymentStatus[]; dryRun: boolean }> {
  return apiFetch("/api/deployments");
}

export function createDeployment(body: {
  modelId: string;
  recipeId: string;
  nodeIds: string[];
  desiredState?: DeploymentDesired;
  metadata?: Record<string, unknown>;
  /** OPTIONAL placement role (pure config data — never a lifecycle action). */
  role?: DeploymentRole | null;
}): Promise<{ deployment: DeploymentBinding; runtime: DeploymentStatus }> {
  return apiFetch("/api/deployments", { method: "POST", body: JSON.stringify(body) });
}

/**
 * CONFIG-ONLY role change on an existing binding: PATCH writes `role` only.
 * Never recreates the model/recipe/weights and never touches the runtime.
 */
export function patchDeploymentRole(
  id: string,
  role: DeploymentRole | null
): Promise<{ deployment: DeploymentBinding; runtime: DeploymentStatus; configOnly: boolean }> {
  return apiFetch(`/api/deployments/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

/** Remove only the deployment binding — never the recipe/model/weights. */
export function deleteDeployment(id: string): Promise<{ deleted: boolean; id: string }> {
  return apiFetch(`/api/deployments/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function deploymentAction(
  deploymentId: string,
  action: "start" | "stop" | "restart"
): Promise<{ deployment: DeploymentStatus; dryRun: boolean }> {
  return apiFetch(`/api/deployments/${encodeURIComponent(deploymentId)}/${action}`, { method: "POST" });
}

// ─── Control plane: Activity + audit ──────────────────────
export function fetchActivity(limit = 100, kinds?: string[]): Promise<{ events: ActivityEvent[] }> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (kinds?.length) q.set("kinds", kinds.join(","));
  return apiFetch(`/api/activity?${q.toString()}`);
}

export function fetchAudit(limit = 100): Promise<{ entries: AuditEntry[] }> {
  return apiFetch(`/api/audit?limit=${limit}`);
}

export function fetchConsoleStatus(recipeId: string): Promise<{
  recipeId: string;
  logDir: string | null;
  streaming: boolean;
  error: string | null;
  bufferedLines: number;
  startedAt: number | null;
}> {
  return apiFetch(`/api/console/${encodeURIComponent(recipeId)}/status`);
}

// ─── Control plane: discovery + adoption (read-only scan, config-only adopt) ─
/** Discovered externally-launched runtimes (alreadyAdopted included). */
export function fetchDiscovery(includeAdopted = true): Promise<DiscoveryResponse> {
  return apiFetch(`/api/discovery${includeAdopted ? "" : "?includeAdopted=0"}`);
}

/** Adopt a discovered runtime — writes config only; the process is untouched. */
export function adoptDiscovered(id: string, body: AdoptDiscoveryRequest): Promise<AdoptDiscoveryResult> {
  return apiFetch(`/api/discovery/${encodeURIComponent(id)}/adopt`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Read-only probe of ONE operator-typed endpoint (GET /v1/models). Automatic and
 * free; bounded to that single endpoint — never a LAN sweep.
 */
export function probeDiscoveryEndpoint(body: DiscoveryProbeRequest): Promise<DiscoveryProbeResult> {
  return apiFetch("/api/discovery/probe", { method: "POST", body: JSON.stringify(body) });
}

/**
 * SEPARATE explicit opt-in TINY capability probe (max_tokens 1). Never a
 * benchmark; never echoes a credential value.
 */
export function probeDiscoveryCapabilities(body: ProbeCapabilitiesRequest): Promise<ProbeCapabilitiesResult> {
  return apiFetch("/api/discovery/probe-capabilities", { method: "POST", body: JSON.stringify(body) });
}

/**
 * Read-only scan of CONFIGURED weight directories (bounded, no sweep). Returns
 * weight artifacts only; nothing is moved or copied.
 */
export function scanLocalWeights(body: WeightsScanRequest = {}): Promise<WeightsScanResult> {
  return apiFetch("/api/models/scan-weights", { method: "POST", body: JSON.stringify(body) });
}

// ─── Guided Add Compute (read-only discover + config-only validate) ─────────
/**
 * Bounded, read-only discovery of ONE operator-supplied host. Nothing is
 * written, no remote is mutated, no LAN/port sweep is performed.
 */
export function discoverCompute(body: ComputeDiscoveryRequest): Promise<ComputeDiscoveryResult> {
  return apiFetch("/api/compute/discover", { method: "POST", body: JSON.stringify(body) });
}

/**
 * Config-only pre-SAVE validation. Inspects the registry and, where safe, one
 * bounded GET per port. Distinguishes INVALID from NOT-VERIFIED.
 */
export function validateCompute(body: {
  draft: Record<string, unknown>;
  discovered?: ComputeDiscoveryResult | null;
  selfId?: string | null;
}): Promise<ComputeValidateResult> {
  return apiFetch("/api/compute/validate", { method: "POST", body: JSON.stringify(body) });
}
