/**
 * Control-plane wiring: MODEL registry, RECIPE registry, DEPLOYMENT bindings,
 * DRY-RUN lifecycle, Live Console streaming, Activity feed, and their API.
 *
 * Concept separation (config-first domain core):
 *   MODEL      what it is / weights identity
 *   RECIPE     how it CAN run (declarative, reusable, protected)
 *   DEPLOYMENT where it SHOULD run (model + recipe + nodes + desired)
 *   RUNTIME    what IS running (observed; DeploymentService)
 *   COMPUTE    the fleet (SparkRegistry)
 *
 * All model/recipe-specific seed data lives in committed server/seeds/*.json.
 * Kept out of index.js so the monitoring server stays readable.
 */
import fs from "fs";
import path from "path";
import { isLoopbackBind } from "./auth.js";
import { configuredToken, extractBearer, authenticate } from "./auth.js";
import { modelRegistry } from "./models/ModelRegistry.js";
import { recipeRegistry } from "./recipes/RecipeRegistry.js";
import { deploymentRegistry } from "./domain/deploymentRegistry.js";
import { normalizeRecipe } from "./domain/schema.js";
import { runMigrations } from "./domain/migrate.js";
import { DeploymentService } from "./deployments/DeploymentService.js";
import { LiveConsoleManager } from "./collectors/LiveConsole.js";
import { ActivityLog } from "./activity/ActivityLog.js";
import { createRateLimiter } from "./validate.js";
import { probeEndpoint, probeUrl } from "./deployments/deploymentStatus.js";
import { detectRuntime, healthClassify, providerFor, RUNTIME_TYPES, processEvidenceCmd, metricsFor } from "./domain/providers/registry.js";
import { DiscoveryService } from "./domain/discovery.js";
import { sshExec } from "./collectors/ssh.js";
import { llmProbeHost } from "./collectors/llmHost.js";
import {
  MODELS_JSON_PATH,
  RECIPES_JSON_PATH,
  DEPLOYMENTS_JSON_PATH,
  SEEDS_DIR,
} from "./config.js";

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function copyFile(src, dest) {
  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, dest);
}

/** First-run seed loader: copy committed v2 seed files when config is empty. */
function seedFromFiles() {
  const emptyModels = !readJson(MODELS_JSON_PATH)?.models?.length;
  const emptyRecipes = !readJson(RECIPES_JSON_PATH)?.recipes?.length;
  const emptyDeps = !readJson(DEPLOYMENTS_JSON_PATH)?.deployments?.length;
  if (!emptyModels && !emptyRecipes && !emptyDeps) return false;
  try {
    if (emptyModels) copyFile(path.join(SEEDS_DIR, "models.json"), MODELS_JSON_PATH);
    if (emptyRecipes) copyFile(path.join(SEEDS_DIR, "recipes.json"), RECIPES_JSON_PATH);
    if (emptyDeps) copyFile(path.join(SEEDS_DIR, "deployments.json"), DEPLOYMENTS_JSON_PATH);
    console.log("[control-plane] seeded v2 registries from server/seeds");
    return true;
  } catch (err) {
    console.warn("[control-plane] seed skipped:", err.message);
    return false;
  }
}

/** Ensure a deployment binding mirrors a recipe's legacy nodeIds. */
function syncDeploymentBinding(recipe) {
  if (!recipe?.nodeIds?.length) return null;
  const existing = deploymentRegistry.listForRecipe(recipe.id)[0] || null;
  if (existing) {
    if (existing.nodeIds.join(",") !== recipe.nodeIds.join(",")) {
      existing.nodeIds = [...recipe.nodeIds];
      existing.updatedAt = Date.now();
      // persist via create-like replacement
      deploymentRegistry.remove(existing.id);
      return deploymentRegistry.create(existing);
    }
    return existing;
  }
  return deploymentRegistry.ensureForRecipe(recipe);
}

export function createControlPlane(deps) {
  const { app, sparkRegistry, monitors, decodeBenchManager, prefillBenchManager, showcaseManager } =
    deps;

  // ─── Migration + seeds (before registries diverge from disk) ──
  try {
    runMigrations({
      modelsPath: MODELS_JSON_PATH,
      recipesPath: RECIPES_JSON_PATH,
      deploymentsPath: DEPLOYMENTS_JSON_PATH,
    });
  } catch (err) {
    console.warn("[control-plane] migration skipped:", err.message);
  }
  if (seedFromFiles()) {
    modelRegistry.reload();
    recipeRegistry.reload();
    deploymentRegistry.reload();
  }

  // ─── Registries ────────────────────────────────────────
  recipeRegistry.getKnownNodeIds = () => sparkRegistry.sparkIds;
  recipeRegistry.modelRegistry = modelRegistry;
  recipeRegistry.deploymentRegistry = deploymentRegistry;
  recipeRegistry.getModelWeightPath = (recipe) => {
    if (!recipe?.modelRef?.modelId) return null;
    const model = modelRegistry.get(recipe.modelRef.modelId);
    return model?.weightPaths?.[recipe.modelRef.weightId || "default"] ?? null;
  };

  const activity = new ActivityLog();

  // ─── Deployment runtime / observed layer ───────────────
  const deployments = new DeploymentService({
    recipeRegistry,
    deploymentRegistry,
    onStateChange: (state) => {
      deps.broadcastLifecycle({ type: "lifecycle", state });
      if (state.lastOp) {
        activity.push({
          kind: "lifecycle",
          subject: state.recipeId,
          summary: `${state.lastOp} → ${state.state} (dry-run)`,
          attribution: null,
          meta: { managedBy: state.managedBy, dryRun: true, deploymentId: state.deploymentId },
        });
      }
    },
  });

  // ─── Discovery (read-only) + adoption (config-only) ────
  const discovery = new DiscoveryService({
    sparkRegistry,
    recipeRegistry,
    deploymentRegistry,
    modelRegistry,
    fetchImpl: deps.fetchImpl || fetch,
    sshExecFn: sshExec,
  });

  // ─── Live Console ──────────────────────────────────────
  /** recipeId -> Map<ws, {lines: object[], rows: object[]}> */
  const consoleClients = new Map();
  const consoleFlushTimers = new Map();

  function flushConsole(recipeId) {
    consoleFlushTimers.delete(recipeId);
    const clients = consoleClients.get(recipeId);
    if (!clients || clients.size === 0) return;
    for (const [ws, pending] of clients) {
      if (ws.readyState !== 1 || (pending.lines.length === 0 && pending.rows.length === 0)) continue;
      try {
        ws.send(
          JSON.stringify({
            type: "console",
            recipeId,
            lines: pending.lines.slice(-400),
            telemetry: pending.rows,
          })
        );
      } catch {
        /* per-client failures handled by close */
      }
      pending.lines.length = 0;
      pending.rows.length = 0;
    }
  }

  const liveConsole = new LiveConsoleManager({
    recipeRegistry,
    sparkResolver: (nodeId) => sparkRegistry.getSpark(nodeId),
    onLine: (recipeId, line, row) => {
      const clients = consoleClients.get(recipeId);
      if (!clients || clients.size === 0) return;
      for (const [, pending] of clients) {
        pending.lines.push(line);
        if (row && row.state === "done") pending.rows.push(row);
      }
      if (!consoleFlushTimers.has(recipeId)) {
        consoleFlushTimers.set(recipeId, setTimeout(() => flushConsole(recipeId), 80));
      }
    },
  });

  /** Handle one parsed WS control message from a client. */
  function handleWsMessage(ws, msg) {
    if (msg?.type === "console:subscribe" && typeof msg.recipeId === "string") {
      const recipeId = msg.recipeId;
      const pending = { lines: [], rows: [] };
      let clients = consoleClients.get(recipeId);
      if (!clients) {
        clients = new Map();
        consoleClients.set(recipeId, clients);
      }
      clients.set(ws, pending);
      const result = liveConsole.subscribe(recipeId, (line, row) => {
        pending.lines.push(line);
        if (row && row.state === "done") pending.rows.push(row);
        if (!consoleFlushTimers.has(recipeId)) {
          consoleFlushTimers.set(recipeId, setTimeout(() => flushConsole(recipeId), 80));
        }
      });
      try {
        ws.send(
          JSON.stringify({
            type: "console:init",
            recipeId,
            ok: result.ok,
            reason: result.reason || null,
            status: liveConsole.status(recipeId),
            buffered: result.buffered.slice(-800),
            telemetry: result.telemetry,
          })
        );
      } catch {
        /* client vanished */
      }
      return true;
    }
    if (msg?.type === "console:unsubscribe" && typeof msg.recipeId === "string") {
      const clients = consoleClients.get(msg.recipeId);
      if (clients) {
        clients.delete(ws);
        liveConsole.unsubscribe(msg.recipeId, () => {});
      }
      return true;
    }
    return false;
  }

  function detachClient(ws) {
    for (const [recipeId, clients] of consoleClients) {
      if (clients.has(ws)) {
        clients.delete(ws);
        const s = liveConsole.status(recipeId);
        if (clients.size === 0) {
          liveConsole.unsubscribe(recipeId, () => {});
          void s;
        }
      }
    }
  }

  // ─── Endpoint → recipe join (bench attribution) ────────
  function recipeForEndpoint(nodeId, port) {
    const p = Number(port);
    return (
      recipeRegistry
        .list()
        .find((r) => Number(r.endpoint?.port) === p && (r.nodeIds || []).includes(nodeId)) || null
    );
  }

  // ─── Lifecycle auth ────────────────────────────────────
  const lifecycleLimit = createRateLimiter(20, 60_000, "lifecycle");
  function requireLifecycleAuth(req, res, next) {
    if (!lifecycleLimit(req.ip)) {
      return res.status(429).json({ error: "Too many lifecycle operations; wait a minute" });
    }
    const token = configuredToken();
    if (token) {
      const result = authenticate(req);
      if (!result.ok) return res.status(result.status).json({ error: result.error });
      return next();
    }
    const remote = !isLoopbackBind(process.env.BIND_HOST || "127.0.0.1");
    const socketLoopback = /^(127\.|::1)/.test(req.socket?.remoteAddress || "");
    if (!remote && socketLoopback && process.env.SPARKDASH_ALLOW_DRYRUN_LOOPBACK === "1") {
      return next();
    }
    return res.status(403).json({
      error:
        "lifecycle operations require SPARKDASH_TOKEN (or SPARKDASH_ALLOW_DRYRUN_LOOPBACK=1 for development dry-runs)",
    });
  }

  function actorOf(req) {
    const bearer = extractBearer(req);
    return bearer ? "token-client" : req.socket?.remoteAddress || "unknown";
  }

  // ─── Routes: runtime provider catalog (read-only, WS-3) ─
  // Describes the runtime types the provider registry knows so the client
  // chip-picker is driven by the registry, never a duplicated literal.
  app.get("/api/runtimes", (_req, res) => {
    res.json({
      runtimes: RUNTIME_TYPES.map((id) => {
        const p = providerFor(id);
        return { id, label: p.label, launchable: Boolean(p.launchable), metrics: metricsFor(id) };
      }),
    });
  });

  // ─── Routes: models ────────────────────────────────────
  app.get("/api/models", (req, res) => {
    const includeArchived = req.query.includeArchived === "1";
    res.json({ models: includeArchived ? modelRegistry.list() : modelRegistry.listActive() });
  });

  app.post("/api/models", (req, res) => {
    try {
      const model = modelRegistry.upsert(req.body || {});
      activity.push({
        kind: "lifecycle",
        subject: model.id,
        summary: `model registered: ${model.name}`,
        meta: null,
      });
      res.json({ model });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.get("/api/models/:id", (req, res) => {
    const model = modelRegistry.get(req.params.id);
    if (!model) return res.status(404).json({ error: "model not found" });
    const recipes = recipeRegistry.listForModel(model.id, { includeArchived: true });
    res.json({
      model,
      recipes: recipes.map((r) => recipeRegistry.toPublic(r)),
      deployments: deployments.listStates().filter((s) => s.modelId === model.id),
    });
  });

  app.delete("/api/models/:id", (req, res) => {
    const hard = req.query.hard === "1";
    try {
      const result = modelRegistry.remove(req.params.id, {
        archive: !hard,
        hasRecipes: recipeRegistry.hasRecipesForModel(req.params.id),
        hasDeployments: deploymentRegistry.hasForModel(req.params.id),
      });
      if (!result) return res.status(404).json({ error: "model not found" });
      res.json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.post("/api/models/:id/restore", (req, res) => {
    const model = modelRegistry.restore(req.params.id);
    if (!model) return res.status(404).json({ error: "model not found" });
    res.json({ model });
  });

  // ─── Routes: recipes ───────────────────────────────────
  app.get("/api/recipes", (req, res) => {
    const includeArchived = req.query.includeArchived === "1";
    res.json({ recipes: recipeRegistry.listPublic({ includeArchived }) });
  });

  app.post("/api/recipes", (req, res) => {
    try {
      const body = req.body || {};
      // Legacy convenience: a supplied modelPath updates the model's weight variant.
      if (body.modelPath && body.id) {
        const modelId = body.modelRef?.modelId || body.modelId;
        if (modelRegistry.get(modelId) && !modelRegistry.get(modelId).weightPaths?.[body.weightId || "default"]) {
          modelRegistry.setWeightPath(modelId, body.weightId, body.modelPath);
        }
      }
      const recipe = recipeRegistry.upsert(body);
      const dep = syncDeploymentBinding(recipe);
      activity.push({
        kind: "lifecycle",
        subject: recipe.id,
        summary: `recipe saved: ${recipe.name}`,
        meta: { modelId: recipe.modelRef?.modelId, nodes: recipe.nodeIds, deploymentId: dep?.id ?? null },
      });
      res.json({ recipe: recipeRegistry.toPublic(recipe), deployment: dep });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.get("/api/recipes/:id", (req, res) => {
    const recipe = recipeRegistry.get(req.params.id);
    if (!recipe) return res.status(404).json({ error: "recipe not found" });
    res.json({ recipe: recipeRegistry.toPublic(recipe) });
  });

  // Validate an UNSAVED recipe body (draft) — lets the wizard dry-run before
  // any entity is persisted, so cancelling leaves no orphan draft.
  app.post("/api/recipes/validate", (req, res) => {
    try {
      const body = req.body || {};
      const recipe = normalizeRecipe(body);
      const result = recipeRegistry.validate(recipe, { nodeIds: body.nodeIds });
      res.json({ ok: result.ok, errors: result.errors, warnings: result.warnings });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.post("/api/recipes/:id/validate", (req, res) => {
    const result = recipeRegistry.validate(req.params.id, { nodeIds: req.body?.nodeIds });
    if (!result) return res.status(404).json({ error: "recipe not found" });
    res.json({ ok: result.ok, errors: result.errors, warnings: result.warnings });
  });

  app.post("/api/recipes/:id/duplicate", (req, res) => {
    try {
      const newId = req.body?.id || `${req.params.id}-copy`;
      const recipe = recipeRegistry.duplicate(req.params.id, newId, req.body?.overrides || {});
      if (!recipe) return res.status(404).json({ error: "source recipe not found" });
      res.json({ recipe: recipeRegistry.toPublic(recipe) });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.post("/api/recipes/:id/clone", (req, res) => {
    try {
      const newId = req.body?.id;
      const recipe = recipeRegistry.clone(req.params.id, newId, req.body?.overrides || {});
      if (!recipe) return res.status(404).json({ error: "source recipe not found" });
      res.json({ recipe: recipeRegistry.toPublic(recipe) });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.post("/api/recipes/:id/lifecycle", (req, res) => {
    try {
      const to = req.body?.to;
      const recipe = recipeRegistry.transition(req.params.id, to, { note: req.body?.note });
      activity.push({
        kind: "lifecycle",
        subject: recipe.id,
        summary: `recipe lifecycle: ${recipe.lifecycleState}`,
        meta: { to },
      });
      res.json({ recipe: recipeRegistry.toPublic(recipe) });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.delete("/api/recipes/:id", (req, res) => {
    const result = recipeRegistry.remove(req.params.id, { archive: req.query.hard !== "1" });
    if (!result) return res.status(404).json({ error: "recipe not found" });
    res.json(result);
  });

  app.post("/api/recipes/:id/restore", (req, res) => {
    const recipe = recipeRegistry.restore(req.params.id);
    if (!recipe) return res.status(404).json({ error: "recipe not found" });
    res.json({ recipe: recipeRegistry.toPublic(recipe) });
  });

  // ─── Routes: deployments (bindings + DRY-RUN lifecycle) ─
  app.get("/api/deployments", (_req, res) => {
    res.json({ deployments: deployments.listStates(), dryRun: true });
  });

  app.post("/api/deployments", (req, res) => {
    try {
      const { modelId, recipeId, nodeIds, desiredState } = req.body || {};
      const recipe = recipeRegistry.get(recipeId);
      if (!recipe) return res.status(404).json({ error: "recipe not found" });
      if (recipe.lifecycleState === "archived" || recipe.archived)
        return res.status(409).json({ error: "recipe is archived — cannot back a new deployment" });
      const model = modelRegistry.get(modelId);
      if (!model) return res.status(404).json({ error: "model not found" });
      if (model.archived) return res.status(409).json({ error: "model is archived" });
      if (recipe.modelRef?.modelId !== modelId)
        return res.status(400).json({ error: "recipe does not reference this model" });
      const nodes = Array.isArray(nodeIds) ? nodeIds : [];
      if (nodes.length < recipe.topology.minNodes || nodes.length > recipe.topology.maxNodes)
        return res.status(400).json({
          error: `topology ${recipe.topology.mode}${recipe.topology.parallelism} requires ${recipe.topology.minNodes}–${recipe.topology.maxNodes} node(s)`,
        });
      const known = new Set(sparkRegistry.sparkIds);
      for (const n of nodes) if (!known.has(n)) return res.status(400).json({ error: `unknown node id: ${n}` });
      const managedBy =
        recipe.launch?.mechanism === "external" || recipe.metadata?.managedBy === "external"
          ? "external"
          : "sparkdash";
      const dep = deploymentRegistry.create({
        modelId,
        recipeId,
        nodeIds: nodes,
        desiredState: managedBy === "external" ? "unknown" : desiredState,
        metadata: { managedBy },
      });
      activity.push({
        kind: "lifecycle",
        subject: dep.id,
        summary: `deployment bound: ${recipe.name} on ${nodes.join(", ")}`,
        meta: { modelId, recipeId },
      });
      res.json({ deployment: dep, runtime: deployments.getState(dep.id) });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.delete("/api/deployments/:id", (req, res) => {
    const result = deploymentRegistry.remove(req.params.id);
    if (!result) return res.status(404).json({ error: "deployment not found" });
    res.json(result);
  });

  /**
   * CONFIG-ONLY role change. Writes the role to the deployment binding: no
   * model/recipe/weights recreation, no lifecycle, no runtime touch. Legacy
   * "edge" folds onto "worker"; `role: null` clears it (FE heuristic resumes).
   */
  app.patch("/api/deployments/:id", (req, res) => {
    try {
      const body = req.body || {};
      if (!Object.prototype.hasOwnProperty.call(body, "role"))
        return res.status(400).json({ error: "only a role change is supported (body: {role})" });
      const before = deploymentRegistry.get(req.params.id);
      if (!before) return res.status(404).json({ error: "deployment not found" });
      const dep = deploymentRegistry.setRole(req.params.id, body.role);
      activity.push({
        kind: "lifecycle",
        subject: dep.id,
        summary: `deployment role ${before.role ?? "(none)"} → ${dep.role ?? "(none)"} (config-only)`,
        meta: { modelId: dep.modelId, recipeId: dep.recipeId, configOnly: true, dryRun: true },
      });
      res.json({ deployment: dep, runtime: deployments.getState(dep.id), configOnly: true });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  // ─── Routes: discovery + adoption (read-only scan, config-only adopt) ─
  app.get("/api/discovery", (req, res) => {
    const includeAdopted = req.query.includeAdopted !== "0";
    res.json({ discovered: discovery.list({ includeAdopted }), readOnly: true });
  });

  app.post("/api/discovery/:id/adopt", (req, res) => {
    try {
      const result = discovery.adopt(req.params.id, req.body || {});
      activity.push({
        kind: "lifecycle",
        subject: req.params.id,
        summary: `discovered runtime adopted (${result.mode}) → ${result.recipe.id}`,
        meta: {
          nodeId: result.provenance.nodeId,
          port: result.provenance.port,
          deploymentId: result.deployment.id,
          dryRun: true,
        },
      });
      res.json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  // Ad-hoc single-endpoint discovery (read-only) + opt-in tiny capability probe.
  app.post("/api/discovery/probe", async (req, res) => {
    try {
      const b = req.body || {};
      const result = await discovery.discoverEndpoint({
        host: b.host,
        port: b.port,
        scheme: b.scheme,
        credRef: b.credRef,
      });
      activity.push({
        kind: "discovery",
        subject: `${b.host}:${b.port}`,
        summary: `ad-hoc endpoint probed (read-only)`,
        meta: { runtime: result.runtime, health: result.health, suggestedTemplate: result.suggestedTemplate.templateId },
      });
      res.json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.post("/api/discovery/probe-capabilities", async (req, res) => {
    try {
      const b = req.body || {};
      res.json(
        await discovery.probeCapabilities({
          host: b.host,
          port: b.port,
          scheme: b.scheme,
          credRef: b.credRef,
          modelId: b.modelId,
        })
      );
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  for (const action of ["start", "stop", "restart"]) {
    app.post(`/api/deployments/:id/${action}`, requireLifecycleAuth, (req, res) => {
      try {
        const state = deployments.begin(req.params.id, action, { actor: actorOf(req) });
        res.status(202).json({ deployment: state, dryRun: true });
      } catch (err) {
        res.status(err.status || 400).json({ error: err.message });
      }
    });
  }

  app.get("/api/audit", (req, res) => {
    const limit = Number(req.query.limit) || 100;
    res.json({ entries: deployments.readAudit({ limit }) });
  });

  // ─── Routes: activity ──────────────────────────────────
  app.get("/api/activity", (req, res) => {
    const limit = Number(req.query.limit) || 100;
    const kinds = typeof req.query.kinds === "string" ? req.query.kinds.split(",") : null;
    const events = activity.list({ limit, kinds });
    res.json({ events });
  });

  // ─── Routes: console ───────────────────────────────────
  app.get("/api/console/:recipeId/status", (req, res) => {
    const recipe = recipeRegistry.get(req.params.recipeId);
    if (!recipe) return res.status(404).json({ error: "recipe not found" });
    res.json({
      recipeId: recipe.id,
      logDir: recipe.logSource?.path ?? null,
      ...liveConsole.status(recipe.id),
    });
  });

  // ─── Observation loops (called from the broadcast tick) ─
  const prevOnline = new Map();
  const seenBench = new Set();

  const PROBE_TTL_MS = 6000;
  const DISCOVERY_TTL_MS = 60_000;
  /** deploymentId -> { at: number, observed: string|null } */
  const probeCache = new Map();
  /** deploymentId -> { at: number, value: boolean } */
  const discoveredCache = new Map();
  const discoveryInFlight = new Set();

  /** Declared probe host for a deployment's primary node (same host rule as LlmProbe). */
  function deploymentHost(dep) {
    const spark = sparkRegistry.getSpark(dep.nodeIds?.[0]);
    return spark ? llmProbeHost(spark) : null;
  }

  function recipeForDeployment(dep) {
    return recipeRegistry.get(dep.recipeId);
  }

  function classifyFromSnapshot(recipe, snap) {
    const list = snap?.metrics?.llm || [];
    const llm = list.find((l) => l.port === recipe?.endpoint?.port) || list[0];
    if (!llm) return "not-detected";
    if (llm.available === true) return "running";
    if (llm.posture?.auth === "protected") return "auth-gated";
    // Runtime classification is PROVIDER-owned; WS-1 classify semantics stay.
    const runtime = detectRuntime({ backendType: llm.backend, port: recipe?.endpoint?.port });
    return healthClassify(runtime, { status: null, errorCode: llm.errorCode, errorName: llm.errorName });
  }

  function refreshProbes() {
    const now = Date.now();
    for (const dep of deploymentRegistry.list()) {
      const recipe = recipeForDeployment(dep);
      if (!recipe || recipe.metadata?.managedBy !== "external") continue;

      const cached = probeCache.get(dep.id);
      if (!cached || now - cached.at >= PROBE_TTL_MS) {
        const url = probeUrl(deploymentHost(dep), recipe.endpoint?.port, recipe.healthProbe?.path);
        probeCache.set(dep.id, { at: now, observed: null });
        const runtime = recipe.engine?.runtime ?? recipe.runtime;
        void probeEndpoint(url)
          .then((outcome) =>
            probeCache.set(dep.id, { at: Date.now(), observed: healthClassify(runtime, outcome) })
          )
          .catch(() => probeCache.set(dep.id, { at: Date.now(), observed: "not-detected" }));
      }

      const disc = discoveredCache.get(dep.id);
      if (discoveryInFlight.has(dep.id)) continue;
      if (disc && now - disc.at < DISCOVERY_TTL_MS) continue;
      const spark = sparkRegistry.getSpark(dep.nodeIds?.[0]);
      if (!spark) continue;
      discoveryInFlight.add(dep.id);
      sshExec(spark, processEvidenceCmd(), {
        timeoutMs: 6000,
      })
        .then((out) => discoveredCache.set(dep.id, { at: Date.now(), value: /\bup\b/.test(out) }))
        .catch(() => discoveredCache.set(dep.id, { at: Date.now(), value: false }))
        .finally(() => discoveryInFlight.delete(dep.id));
    }
  }

  function observeFleet() {
    refreshProbes();
    // Read-only discovery scan (TTL-guarded internally): GET /v1/models + pgrep.
    void discovery.scan();

    // 1) Externally-managed deployments: derive observed state from the probe.
    for (const dep of deploymentRegistry.list()) {
      const recipe = recipeForDeployment(dep);
      if (!recipe) continue;
      const primary = monitors.get(dep.nodeIds?.[0]);
      let observed = "not-detected";
      if (primary) {
        let snap = null;
        let online = false;
        try {
          snap = primary.snapshot();
          online = Boolean(snap?.online);
        } catch {
          online = false;
        }
        if (online) observed = probeCache.get(dep.id)?.observed || classifyFromSnapshot(recipe, snap);
      }
      dep.servedModelId = recipe.metadata?.servedModelId ?? null;
      deployments.observe(dep.id, {
        observed,
        discovered: discoveredCache.get(dep.id)?.value === true,
      });
    }

    // 2) Node online/offline transitions → activity events.
    for (const [id, monitor] of monitors) {
      let online = false;
      try {
        online = Boolean(monitor.snapshot()?.online);
      } catch {
        online = false;
      }
      const prev = prevOnline.get(id);
      if (prev !== undefined && prev !== online) {
        activity.push({
          kind: "node",
          subject: id,
          summary: online ? "node came online" : "node went offline",
          meta: null,
        });
      }
      prevOnline.set(id, online);
    }

    // 3) Benchmark completions → activity events.
    for (const [manager, label] of [
      [decodeBenchManager, "decode"],
      [prefillBenchManager, "prefill"],
    ]) {
      if (!manager?.historyBySpark) continue;
      for (const [sparkId, list] of manager.historyBySpark) {
        for (const job of list) {
          if (job.status !== "completed" || seenBench.has(job.benchId)) continue;
          seenBench.add(job.benchId);
          const top = job.results?.[0];
          const tps = top?.meanDecodeTps ?? top?.prefillTps ?? null;
          activity.push({
            kind: "bench",
            subject: job.benchId,
            summary: `${label} benchmark finished on ${sparkId}${tps != null ? ` at ${tps} tok/s` : ""}`,
            attribution: null,
            meta: { sparkId, port: job.config?.port, recipeId: job.config?.recipeId || null },
          });
        }
      }
    }

    // 4) Showcase sessions → activity events.
    if (showcaseManager?.historyBySpark) {
      for (const [sparkId, list] of showcaseManager.historyBySpark) {
        for (const rec of list) {
          const key = `sc:${rec.sessionId}`;
          if (rec.status === "running" || seenBench.has(key)) continue;
          seenBench.add(key);
          activity.push({
            kind: "showcase",
            subject: rec.sessionId,
            summary: `showcase session ${rec.status} on ${sparkId}`,
            attribution: null,
            meta: { sparkId, promptType: rec.promptType || null },
          });
        }
      }
    }
  }

  function shutdown() {
    deployments.cancelAll();
    liveConsole.closeAll();
    for (const t of consoleFlushTimers.values()) clearTimeout(t);
    consoleFlushTimers.clear();
  }

  return {
    modelRegistry,
    recipeRegistry,
    deploymentRegistry,
    deployments,
    discovery,
    liveConsole,
    activity,
    handleWsMessage,
    detachClient,
    observeFleet,
    recipeForEndpoint,
    shutdown,
  };
}
