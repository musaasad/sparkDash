/**
 * DiscoveryService — READ-ONLY scan for externally-launched serving runtimes.
 *
 * Scope: for each fleet node, GET `/v1/models` (or the provider's modelsPath) on
 * the node's inference ports (sparks.json llmPorts + any port an existing recipe
 * uses). When an endpoint answers, capture {nodeId, port, servedModelIds,
 * runtime, health, processEvidence}. Anything already covered by a deployment is
 * not "new". Uncovered endpoints become DISCOVERED RUNTIMES.
 *
 * SAFETY (non-negotiable):
 *  - HTTP GET only (`/v1/models`, provider modelsPath). No writes, no auth header
 *    so an auth-gated endpoint correctly reports 401/403 = up.
 *  - processEvidence via READ-ONLY `pgrep` only — no signals, no process control,
 *    no remote writes.
 *  - Discovery NEVER auto-writes models/recipes/deployments. It persists only the
 *    gitignored config/discovered.json runtime-state file.
 *  - Degrades gracefully offline: a failed probe skips the endpoint, never
 *    crashes and never fabricates an entry.
 *
 * Adoption is CONFIG-ONLY + dry-run: it creates/associates model/recipe and a
 * deployment binding, sets desiredState 'unknown', and records provenance. It
 * NEVER starts, stops, signals or reconfigures the discovered process.
 */
import fs from "fs";
import path from "path";
import { atomicWrite } from "../util/atomicWrite.js";
import { DISCOVERED_JSON_PATH } from "../config.js";
import { llmProbeHost } from "../collectors/llmHost.js";
import { probeUrl, probeEndpoint } from "../deployments/deploymentStatus.js";
import { loadSecrets, loadRecipeEnv } from "../secretsStore.js";
import {
  detectRuntime,
  healthClassify,
  modelsPath,
  servedModelIds,
  renderLaunchCommand,
  processEvidenceCmd,
  probePaths,
} from "./providers/registry.js";

const PGREP_CMD = processEvidenceCmd();
const DEFAULT_TTL_MS = 60_000;
/** Ad-hoc operator probes stay SHORT — a single endpoint, never a sweep. */
const ADHOC_TIMEOUT_MS = 2500;
const CAPABILITY_TIMEOUT_MS = 4000;

/** Resolve a `credRef` to a plaintext value ONLY here; the value is never echoed. */
function defaultCredResolver(ref) {
  const s = String(ref || "").trim();
  if (!s) return null;
  if (s.startsWith("spark:")) {
    const [, id, port] = s.split(":");
    if (!id || !port) return null;
    try {
      return loadSecrets().llmApiKeys.get(id)?.[String(port)] || null;
    } catch {
      return null;
    }
  }
  if (s.startsWith("recipe:")) {
    try {
      return loadRecipeEnv().get(s) || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Bearer header for a resolved cred. NEVER carries the literal in the output. */
function authHeaders(cred) {
  return cred ? { Authorization: `Bearer ${cred}` } : null;
}

/** Metadata fields worth surfacing from a `/v1/models` entry, if exposed. */
function metadataHints(body) {
  const first = Array.isArray(body?.data) ? body.data[0] : Array.isArray(body) ? body[0] : null;
  if (!first || typeof first !== "object") return {};
  const contextLength =
    first.context_length ?? first.max_model_len ?? first.max_context_length ?? first.context_window ?? null;
  const quantization = first.quantization ?? first.quant ?? null;
  return {
    contextLength: contextLength != null ? Number(contextLength) || null : null,
    quantization: quantization != null ? String(quantization).toLowerCase() : null,
    apiProtocol: Array.isArray(body?.data) ? "openai" : Array.isArray(body) ? "native" : "unknown",
  };
}

/**
 * SUGGESTION only — the operator can always override. Low confidence whenever
 * the runtime identity is uncertain, so the UI never pretends to be sure.
 * @param {{runtime?:string|null, apiProtocol?:string|null, quantization?:string|null}} input
 * @returns {{templateId:string, confidence:"high"|"medium"|"low"}}
 */
export function suggestTemplate({ runtime = null, apiProtocol = null, quantization = null } = {}) {
  if (runtime === "tabbyapi-exl3" || quantization === "exl3") {
    return { templateId: "tabbyapi-exl3", confidence: "high" };
  }
  if (runtime === "vllm") {
    return apiProtocol === "openai"
      ? { templateId: "vllm-openai", confidence: "high" }
      : { templateId: "vllm-openai", confidence: "medium" };
  }
  if (apiProtocol === "openai") return { templateId: "external-observed", confidence: "low" };
  return { templateId: "scratch", confidence: "low" };
}

/** Trivial capability detection from the model id — never a benchmark. */
function idHints(ids = []) {
  const s = ids.join(" ").toLowerCase();
  return {
    vision: /\b(vl|vision|llava|pixtral|multimodal)\b/.test(s) ? "yes" : "unknown",
    tools: /\b(tools?|function|hermes)\b/.test(s) ? "yes" : "unknown",
    reasoning: /\b(r1|reasoning|thinking|reasoner)\b/.test(s) ? "yes" : "unknown",
  };
}

const slug = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "discovered";

export class DiscoveryService {
  /**
   * @param {{
   *   sparkRegistry: {sparkIds:string[], getSpark:(id:string)=>object|null},
   *   recipeRegistry: {list:()=>object[]},
   *   deploymentRegistry: {list:()=>object[]},
   *   modelRegistry?: object,
   *   fetchImpl?: typeof fetch,
   *   sshExecFn?: Function,
   *   path?: string,
   *   ttlMs?: number,
   * }} opts
   */
  constructor(opts) {
    this.sparkRegistry = opts.sparkRegistry;
    this.recipeRegistry = opts.recipeRegistry;
    this.deploymentRegistry = opts.deploymentRegistry;
    this.modelRegistry = opts.modelRegistry || null;
    this.fetchImpl = opts.fetchImpl || fetch;
    this.sshExecFn = opts.sshExecFn || null;
    this.credResolver = opts.credResolver || defaultCredResolver;
    this.path = opts.path || DISCOVERED_JSON_PATH;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    /** @type {Map<string, object>} id -> record */
    this._records = new Map();
    this._inFlight = new Set();
    /** host -> Set<port> recently observed (ad-hoc + scanned), for bounded re-scan. */
    this._observedPorts = new Map();
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.path)) return;
      const raw = JSON.parse(fs.readFileSync(this.path, "utf8"));
      for (const r of Array.isArray(raw?.discovered) ? raw.discovered : []) {
        if (r?.id) this._records.set(r.id, r);
      }
    } catch (err) {
      console.warn("[discovery] load skipped:", err.message);
    }
  }

  _save() {
    try {
      atomicWrite(
        this.path,
        JSON.stringify({ schemaVersion: 1, discovered: [...this._records.values()] }, null, 2),
        0o600
      );
    } catch (err) {
      console.warn("[discovery] persist skipped:", err.message);
    }
  }

  /**
   * Remember an observed host:port so a later scan re-covers it. Bounded: only
   * known fleet hosts or explicitly probed endpoints ever enter the set.
   */
  _rememberEndpoint(host, port) {
    if (!host || !port) return;
    const set = this._observedPorts.get(host) || new Set();
    set.add(Number(port));
    this._observedPorts.set(host, set);
  }

  /**
   * Inference ports worth scanning: declared llmPorts + ports any recipe uses +
   * ports recently observed on this node's host. NO blind LAN sweep — only these.
   */
  portsForNode(nodeId) {
    const spark = this.sparkRegistry.getSpark(nodeId);
    const ports = new Set((spark?.llmPorts || []).map(Number).filter(Boolean));
    for (const r of this.recipeRegistry.list()) {
      if ((r.nodeIds || []).includes(nodeId) && r.endpoint?.port) ports.add(Number(r.endpoint.port));
    }
    const host = llmProbeHost(spark);
    for (const p of this._observedPorts.get(host) || []) ports.add(Number(p));
    for (const rec of this._records.values()) {
      if (rec.nodeId === nodeId && rec.port) ports.add(Number(rec.port));
    }
    return [...ports].filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  }

  /**
   * Pure correlation: is (nodeId, port, servedId) already covered by a
   * deployment/recipe? Returns {alreadyAdopted, matchedModelId, matchedRecipeId}.
   */
  correlate(rec) {
    for (const dep of this.deploymentRegistry.list()) {
      if (!(dep.nodeIds || []).includes(rec.nodeId)) continue;
      const recipe = this.recipeRegistry.get(dep.recipeId);
      const depPort = Number(dep.apiPort ?? recipe?.endpoint?.port);
      const portMatches = depPort === Number(rec.port);
      const servedMatches =
        rec.servedModelIds.length === 0 ||
        rec.servedModelIds.some(
          (id) => id === dep.servedModelId || id === recipe?.metadata?.servedModelId
        );
      // A binding is adopted if the served model matches on the node even when
      // the recorded port drifted from the discovered port.
      if (!servedMatches) continue;
      if (!portMatches && !rec.servedModelIds.length) continue;
      return {
        alreadyAdopted: true,
        matchedModelId: dep.modelId ?? recipe?.modelRef?.modelId ?? null,
        matchedRecipeId: dep.recipeId ?? null,
        portDrift: !portMatches,
      };
    }
    return { alreadyAdopted: false, matchedModelId: null, matchedRecipeId: null, portDrift: false };
  }

  /** Public view: discovered runtimes with live correlation + adoption state. */
  list({ includeAdopted = true } = {}) {
    return [...this._records.values()]
      .map((rec) => ({
        id: rec.id,
        nodeId: rec.nodeId,
        port: rec.port,
        servedModelIds: rec.servedModelIds,
        runtime: rec.runtime,
        health: rec.health,
        processEvidence: rec.processEvidence,
        endpoint: rec.endpoint,
        detectedAt: rec.detectedAt,
        adoptedAt: rec.adoptedAt ?? null,
        adoptionMode: rec.adoptionMode ?? null,
        ...this.correlate(rec),
      }))
      .filter((rec) => includeAdopted || !rec.alreadyAdopted)
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.port - b.port);
  }

  get(id) {
    return this._records.get(id) || null;
  }

  /** One read-only probe of a node:port. Returns null when nothing answers. */
  async _probe(nodeId, port) {
    const spark = this.sparkRegistry.getSpark(nodeId);
    if (!spark) return null;
    const host = llmProbeHost(spark);
    if (!host) return null;

    const paths = probePaths();
    let res = null;
    let usedPath = paths[0];
    for (const p of paths) {
      let attempt = null;
      try {
        attempt = await this.fetchImpl(`http://${host}:${port}${p}`, {
          signal: AbortSignal.timeout(3000),
        });
      } catch {
        attempt = null; // offline / refused — try the next provider path
      }
      if (!attempt) continue;
      res = attempt;
      usedPath = p;
      if (attempt.ok) break; // first answering path that lists models wins
    }
    if (!res) return null; // nothing answered anywhere — degrade gracefully

    let body = null;
    if (res.ok) {
      try {
        body = await res.json();
      } catch {
        body = null;
      }
    }

    const owned = body?.data?.[0]?.owned_by ?? null;
    const signals = {
      backendType: null,
      ownedBy: owned,
      serverIsOpenAI: res.ok ? true : null,
      shape: body,
      port,
    };
    const runtime = detectRuntime(signals);
    const health = healthClassify(runtime, { status: res.status });
    const ids = servedModelIds(runtime, body);
    const modelsPathUsed = modelsPath(runtime, { backendType: runtime });

    let processEvidence = null;
    if (this.sshExecFn) {
      try {
        const out = await this.sshExecFn(spark, PGREP_CMD, { timeoutMs: 6000 });
        processEvidence = /\bup\b/.test(out);
      } catch {
        processEvidence = null;
      }
    }

    return {
      nodeId,
      port: Number(port),
      servedModelIds: ids,
      runtime,
      health,
      processEvidence,
      endpoint: `http://${host}:${port}${modelsPathUsed}`,
      detectedAt: Date.now(),
    };
  }

  /**
   * Scan every node/port, or a single node when `{nodeId}` is passed. Idempotent,
   * TTL-guarded, offline-safe. Bounded targets only — never a blind LAN sweep.
   */
  async scan({ nodeId = null } = {}) {
    const now = Date.now();
    const nodeIds = nodeId ? [nodeId] : this.sparkRegistry.sparkIds || [];
    for (const id_ of nodeIds) {
      for (const port of this.portsForNode(id_)) {
        const id = `disc-${slug(id_)}-${port}`;
        if (this._inFlight.has(id)) continue;
        const prev = this._records.get(id);
        if (prev && now - (prev.detectedAt || 0) < this.ttlMs) continue;
        this._inFlight.add(id);
        void this._probe(id_, port)
          .then((rec) => {
            if (!rec) {
              // Endpoint stopped answering: keep the record but mark not-detected.
              if (prev) this._records.set(id, { ...prev, health: "not-detected", detectedAt: Date.now() });
              return;
            }
            const existing = this._records.get(id) || {};
            this._records.set(id, {
              ...existing,
              ...rec,
              id,
              adoptionMode: existing.adoptionMode ?? null,
              adoptedAt: existing.adoptedAt ?? null,
            });
          })
          .catch(() => {})
          .finally(() => {
            this._inFlight.delete(id);
            this._save();
          });
      }
    }
  }

  /**
   * Ad-hoc discovery of ONE operator-supplied endpoint. READ-ONLY GET /v1/models
   * via the shared probeUrl/probeEndpoint, short timeout, bounded (no sweep).
   * A cred is attached ONLY as a reference — its value is never returned.
   *
   * @param {{host:string, port:number|string, scheme?:string, credRef?:string}} input
   */
  async discoverEndpoint({ host, port, scheme = "http", credRef = null } = {}) {
    const p = Number(port);
    const provenance = {};
    if (!host || !Number.isInteger(p) || p < 1 || p > 65535) {
      const err = new Error("host and port (1–65535) are required");
      err.status = 400;
      throw err;
    }
    const schemeUsed = scheme === "https" ? "https" : "http";
    const base = `${schemeUsed}://${String(host).trim()}:${p}`;
    const url = probeUrl(String(host).trim(), p, "/v1/models").replace(/^http:/, `${schemeUsed}:`);

    provenance.host = "user";
    provenance.port = "user";
    provenance.scheme = "user";

    let cred = null;
    if (credRef) {
      try {
        cred = this.credResolver(credRef);
      } catch {
        cred = null;
      }
    }

    const outcome = await probeEndpoint(url, {
      fetchImpl: this.fetchImpl,
      timeoutMs: ADHOC_TIMEOUT_MS,
      headers: authHeaders(cred),
      parseBody: true,
    });

    provenance.reachable = outcome.status != null ? "probed" : "unknown";
    const body = outcome.body;
    const owned = body?.data?.[0]?.owned_by ?? null;
    const signals = { backendType: null, ownedBy: owned, serverIsOpenAI: outcome.status ? true : null, shape: body, port: p };
    const runtime = detectRuntime(signals);
    const health = healthClassify(runtime, { status: outcome.status, errorCode: outcome.errorCode, errorName: outcome.errorName });

    const hints = metadataHints(body);
    const ids = body ? servedModelIds(runtime, body) : [];

    provenance.runtime = runtime !== "custom" ? "detected" : "unknown";
    provenance.runtimeConfidence = runtime !== "custom" ? (body ? "medium" : "low") : "low";
    provenance.servedModelIds = ids.length ? "detected" : "unknown";
    provenance.modelId = ids.length ? "detected" : "unknown";
    provenance.health = "probed";
    provenance.contextLength = hints.contextLength != null ? "detected" : "unknown";
    provenance.apiProtocol = hints.apiProtocol && hints.apiProtocol !== "unknown" ? "detected" : "unknown";
    provenance.quantization = hints.quantization != null ? "detected" : "unknown";
    provenance.credRef = credRef ? "user" : "unknown";
    provenance.credApplied = credRef && cred ? "probed" : credRef ? "unknown" : "unknown";

    this._rememberEndpoint(String(host).trim(), p);

    const detected = {
      reachable: outcome.status != null ? health !== "not-detected" : false,
      runtime,
      runtimeConfidence: provenance.runtimeConfidence,
      servedModelIds: ids,
      modelId: ids[0] ?? null,
      health,
      contextLength: hints.contextLength,
      apiProtocol: hints.apiProtocol,
      quantization: hints.quantization,
      endpoint: `${base}/v1/models`,
      credAttached: Boolean(cred),
      provenance,
    };
    detected.suggestedTemplate = suggestTemplate({
      runtime,
      apiProtocol: hints.apiProtocol === "unknown" ? null : hints.apiProtocol,
      quantization: hints.quantization,
    });
    return detected;
  }

  /**
   * SEPARATE explicit opt-in capability probe. TINY + bounded: max_tokens 1,
   * one-char prompt, short timeout. Never a benchmark, never a huge context.
   * @param {{host:string, port:number|string, scheme?:string, credRef?:string, modelId?:string}} input
   */
  async probeCapabilities({ host, port, scheme = "http", credRef = null, modelId = null } = {}) {
    const p = Number(port);
    if (!host || !Number.isInteger(p) || p < 1 || p > 65535) {
      const err = new Error("host and port (1–65535) are required");
      err.status = 400;
      throw err;
    }
    const schemeUsed = scheme === "https" ? "https" : "http";
    const base = `${schemeUsed}://${String(host).trim()}:${p}`;

    let cred = null;
    if (credRef) {
      try {
        cred = this.credResolver(credRef);
      } catch {
        cred = null;
      }
    }
    const headers = authHeaders(cred);
    const model = modelId || "default";

    // Discover the served model id when the operator did not supply one (tiny GET).
    if (!modelId) {
      const listed = await probeEndpoint(`${base}/v1/models`, {
        fetchImpl: this.fetchImpl, timeoutMs: ADHOC_TIMEOUT_MS, headers, parseBody: true,
      });
      const ids = listed.body ? servedModelIds("custom", listed.body) : [];
      if (ids[0]) modelId = ids[0];
    }

    const hints = idHints(modelId ? [modelId] : []);
    const provenance = { text: "unknown", streaming: "unknown", vision: hints.vision === "yes" ? "detected" : "unknown", tools: hints.tools === "yes" ? "detected" : "unknown", reasoning: hints.reasoning === "yes" ? "detected" : "unknown" };
    const result = { text: "unknown", streaming: "unknown", vision: hints.vision, tools: hints.tools, reasoning: hints.reasoning, modelId: modelId ?? null, provenance, credAttached: Boolean(cred) };

    // Tiny text completion: 1 token, one char.
    const textOut = await probeEndpoint(`${base}/v1/chat/completions`, {
      fetchImpl: this.fetchImpl,
      timeoutMs: CAPABILITY_TIMEOUT_MS,
      headers,
      method: "POST",
      json: { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false },
    });
    if (textOut.status != null) {
      result.text = textOut.status >= 200 && textOut.status < 300 ? "yes" : textOut.status === 400 || textOut.status === 404 ? "no" : "unknown";
      provenance.text = textOut.status != null ? "probed" : "unknown";
    }

    // Tiny stream: 1 token, ask for streaming; unsupported → 4xx = "no".
    const streamOut = await probeEndpoint(`${base}/v1/chat/completions`, {
      fetchImpl: this.fetchImpl,
      timeoutMs: CAPABILITY_TIMEOUT_MS,
      headers,
      method: "POST",
      json: { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: true },
    });
    if (streamOut.status != null) {
      result.streaming = streamOut.status >= 200 && streamOut.status < 300 ? "yes" : streamOut.status === 400 || streamOut.status === 404 ? "no" : "unknown";
      provenance.streaming = streamOut.status != null ? "probed" : "unknown";
    }

    this._rememberEndpoint(String(host).trim(), p);
    return result;
  }

  /**
   * Adopt one discovered runtime. CONFIG-ONLY, dry-run.
   * @param {string} id
   * @param {{mode:"associate", modelId:string, recipeId:string, nodeIds?:string[]}
   *        |{mode:"create", modelName:string, recipeDraft?:object, nodeIds?:string[]}} body
   */
  adopt(id, body = {}) {
    const rec = this._records.get(id);
    if (!rec) {
      const err = new Error("discovered runtime not found");
      err.status = 404;
      throw err;
    }
    if (!this.modelRegistry) {
      const err = new Error("model registry unavailable");
      err.status = 500;
      throw err;
    }
    const mode = body.mode === "create" ? "create" : "associate";
    const nodeIds = (Array.isArray(body.nodeIds) ? body.nodeIds : []).length
      ? [...new Set(body.nodeIds)]
      : [rec.nodeId];
    const servedId = rec.servedModelIds[0] ?? null;
    const provenance = {
      source: "discovery",
      discoveryId: id,
      nodeId: rec.nodeId,
      port: rec.port,
      servedModelId: servedId,
      runtime: rec.runtime,
      adoptedAt: Date.now(),
    };

    let model;
    let recipe;

    if (mode === "associate") {
      const { modelId, recipeId } = body;
      model = this.modelRegistry.get(modelId);
      if (!model) {
        const err = new Error("model not found");
        err.status = 404;
        throw err;
      }
      recipe = this.recipeRegistry.get(recipeId);
      if (!recipe) {
        const err = new Error("recipe not found");
        err.status = 404;
        throw err;
      }
      if (recipe.modelRef?.modelId !== modelId) {
        const err = new Error("recipe does not reference this model");
        err.status = 400;
        throw err;
      }
      // Reconcile the recipe onto the DISCOVERED endpoint: sync the port when it
      // has drifted and attach the node binding hint only when topology allows,
      // so the runtime stops re-surfacing as un-adopted.
      const maxNodes = recipe.topology?.maxNodes ?? 1;
      const addNode =
        !(recipe.nodeIds || []).includes(rec.nodeId) &&
        (recipe.nodeIds || []).length < maxNodes;
      const portDrift = Number(recipe.endpoint?.port) !== Number(rec.port);
      if (portDrift || addNode) {
        if (portDrift) recipe.endpoint = { ...recipe.endpoint, port: rec.port };
        if (addNode) recipe.nodeIds = [...(recipe.nodeIds || []), rec.nodeId];
        this.recipeRegistry.upsert(recipe, { skipNodeCheck: true });
      }
    } else {
      const modelName = String(body.modelName || servedId || rec.runtime).trim();
      const draft = body.recipeDraft && typeof body.recipeDraft === "object" ? body.recipeDraft : {};
      const modelId = slug(draft.modelId || modelName);
      const modelPath = draft.modelPath || `/${slug(servedId || modelId)}`;
      const runtime = rec.runtime;
      const recipeId = slug(draft.id || `${modelName}-${runtime}`);
      // Validate port availability BEFORE creating the model, else a recipe 409
      // would leave an orphan model behind.
      this.recipeRegistry._assertNoPortConflict({
        id: recipeId,
        endpoint: { port: rec.port },
        nodeIds,
        archived: false,
      });

      model = this.modelRegistry.upsert({
        id: modelId,
        name: modelName,
        family: draft.family ?? null,
        weightPaths: { default: modelPath },
        tags: ["adopted-from-discovery"],
      });
      try {
        recipe = this.recipeRegistry.upsert({
          id: recipeId,
          modelId,
          name: draft.name || `${modelName} (${rec.runtime})`,
          runtime,
          topology: draft.topology || "single",
          nodeIds,
          modelPath,
          workdir: draft.workdir || "/models",
          logDir: draft.logDir ?? null,
          apiPort: rec.port,
          healthPath: draft.healthPath || "/v1/models",
          contextLength: draft.contextLength ?? null,
          launcher:
            draft.launcher ||
            renderLaunchCommand({ engine: { runtime }, modelPath, endpoint: { port: rec.port } }),
          launchMechanism: "external",
          logSource: draft.logSource ?? null,
          metadata: { managedBy: "external", servedModelId: servedId, adoptedFrom: provenance },
          provenance,
          lifecycleState: "draft",
        });
      } catch (err) {
        // Roll the model back so a recipe failure never orphans it.
        this.modelRegistry.remove(modelId);
        throw err;
      }
      // Record adoption provenance on the model (in-memory + persisted on save).
      model.provenance = provenance;
      model.metadata = { ...(model.metadata || {}), adoptedFrom: provenance };
    }

    const dep = this.deploymentRegistry.create({
      modelId: model.id,
      recipeId: recipe.id,
      nodeIds,
      // External process: SparkDash did not launch it → desired stays 'unknown'.
      desiredState: "unknown",
      metadata: { managedBy: "external", servedModelId: servedId, adoptedFrom: provenance },
    });

    this._records.set(id, {
      ...rec,
      adoptionMode: mode,
      adoptedAt: Date.now(),
      matchedModelId: model.id,
      matchedRecipeId: recipe.id,
      adoptedDeploymentId: dep.id,
      provenance,
    });
    this._save();

    return {
      mode,
      ok: true,
      dryRun: true,
      model,
      // Redacted public view: secret env entries never leak the plaintext value.
      recipe: this.recipeRegistry.toPublic(recipe),
      deployment: dep,
      provenance,
      note: "config-only — the discovered process is untouched (never started/stopped/signalled)",
    };
  }
}
