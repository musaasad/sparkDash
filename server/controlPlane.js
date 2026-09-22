/**
 * Control-plane wiring: Model Registry, Recipe Registry, Deployment lifecycle
 * (DRY-RUN), Live Console streaming, Activity feed, and their API surface.
 *
 * Kept out of index.js so the existing monitoring server stays readable and
 * upstream-mergeable. index.js provides the fleet deps; this module owns the
 * new domain.
 */
import { isLoopbackBind } from "./auth.js";
import { configuredToken, extractBearer, authenticate } from "./auth.js";
import { modelRegistry } from "./models/ModelRegistry.js";
import { recipeRegistry } from "./recipes/RecipeRegistry.js";
import { DeploymentService } from "./deployments/DeploymentService.js";
import { LiveConsoleManager } from "./collectors/LiveConsole.js";
import { ActivityLog } from "./activity/ActivityLog.js";
import { createRateLimiter } from "./validate.js";
import { classifyProbe, probeEndpoint, probeUrl } from "./deployments/deploymentStatus.js";
import { sshExec } from "./collectors/ssh.js";
import { llmProbeHost } from "./collectors/llmHost.js";

/**
 * Seed the first real deployment as generic architecture metadata (not logic).
 * Qwen 3.8 on dgx-3 via TabbyAPI+EXL3 — the known-good values from the lab.
 * Observe-only (managedBy: external): SparkDash reads its state from the LLM
 * probe and never starts/stops it. Skips silently if a model already exists.
 */
function seedQwenExample(modelRegistry, recipeRegistry) {
  try {
    if (modelRegistry.list().length > 0 || recipeRegistry.list().length > 0) return;
    modelRegistry.upsert({
      id: "qwen38-flash-next",
      name: "Qwen 3.8 Flash Next",
      family: "Qwen",
      notes: "EXL3 quantized MoE with MTP speculative decoding.",
    });
    recipeRegistry.upsert(
      {
        id: "qwen38-tabbyapi-dgx3",
        modelId: "qwen38-flash-next",
        name: "TabbyAPI EXL3 (dgx-3)",
        runtime: "tabbyapi-exl3",
        topology: "single",
        nodeIds: ["dgx-3"],
        modelPath: "/home/musaasad/models/Qwen3.8-Flash-Next-EXL3",
        workdir: "/home/musaasad/tabbyAPI",
        logDir: "/home/musaasad/tabbyAPI/logs",
        apiPort: 8889,
        healthPath: "/v1/models",
        contextLength: 262144,
        cpuAffinity: "5-9,15-19",
        launcher: "taskset -c 5-9,15-19 python main.py",
        metadata: { managedBy: "external", venv: "/home/musaasad/exllamav3/.venv" },
        notes: "Known-good single-node deployment. Started outside SparkDash — observe-only.",
        env: [
          { name: "EXL3_INT8_GEMV", value: "0", secret: false },
          { name: "EXL3_MOE_COOP_WIDE", value: "1", secret: false },
          { name: "EXL3_GR_INT8", value: "1", secret: false },
          { name: "EXL3_MTP_HEAD_N", value: "65536", secret: false },
          { name: "EXL3_NGRAM_STREAM", value: "0", secret: false },
          { name: "TORCH_CUDA_ARCH_LIST", value: "12.1", secret: false },
        ],
      },
      { skipNodeCheck: true }
    );
    console.log("[control-plane] seeded Qwen 3.8 example deployment (observe-only)");
  } catch (err) {
    console.warn("[control-plane] Qwen seed skipped:", err.message);
  }
}

/**
 * Seed the distributed TP2 deployment: DeepSeek V4.1 Flash served by vLLM with
 * --tensor-parallel-size 2 --nnodes 2 across dgx-1 (rank 0) + dgx-2 (rank 1).
 * Facts verified live from /v1/models + the process table (read-only).
 * Observe-only; idempotent by recipe id.
 */
function seedTp2Example(modelRegistry, recipeRegistry) {
  try {
    if (recipeRegistry.get("v41-tp2-vllm-dgx12")) return;
    modelRegistry.upsert({
      id: "deepseek-v41-flash",
      name: "DeepSeek V4.1 Flash",
      family: "DeepSeek",
      notes: "EXL3-quantized MoE served tensor-parallel across two DGX Sparks.",
    });
    recipeRegistry.upsert(
      {
        id: "v41-tp2-vllm-dgx12",
        modelId: "deepseek-v41-flash",
        name: "vLLM TP2 (dgx-1 + dgx-2)",
        runtime: "vllm",
        topology: "tp2",
        nodeIds: ["dgx-1", "dgx-2"],
        modelPath: "/model",
        workdir: "/model",
        logDir: null,
        apiPort: 8888,
        healthPath: "/v1/models",
        contextLength: 600000,
        cpuAffinity: null,
        launcher:
          "vllm serve /model --served-model-name DeepSeek-V4.1-Flash-UNCENSORED-EXL3 --tensor-parallel-size 2 --nnodes 2 (containerized)",
        metadata: {
          managedBy: "external",
          // Operator intent: TP2 is expected up (unknown-default external recipe).
          desired: "running",
          servedModelId: "DeepSeek-V4.1-Flash-UNCENSORED-EXL3",
          masterAddr: "10.100.124.2",
          speculative: "dspark x3",
        },
        notes:
          "Distributed deployment: dgx-1 rank 0 (API) + dgx-2 rank 1 (worker). Started outside SparkDash — observe-only.",
        env: [],
      },
      { skipNodeCheck: true }
    );
    console.log("[control-plane] seeded DeepSeek V4.1 TP2 deployment (observe-only)");
  } catch (err) {
    console.warn("[control-plane] TP2 seed skipped:", err.message);
  }
}

/**
 * @param {{
 *   app: import("express").Express,
 *   wss: import("ws").WebSocketServer,
 *   sparkRegistry: {sparkIds: string[], getSpark: (id:string)=>object|null},
 *   monitors: Map<string, {snapshot: () => object}>,
 *   decodeBenchManager: object,
 *   prefillBenchManager: object,
 *   broadcastLifecycle: (payload: object) => void,
 * }} deps
 */
export function createControlPlane(deps) {
  const { app, sparkRegistry, monitors, decodeBenchManager, prefillBenchManager, showcaseManager } =
    deps;

  // ─── Registries ────────────────────────────────────────
  recipeRegistry.getKnownNodeIds = () => sparkRegistry.sparkIds;

  // Seed the first real deployment (Qwen 3.8 on dgx-3) as OBSERVE-ONLY metadata
  // when the registry is empty. Idempotent; never controls the live process.
  seedQwenExample(modelRegistry, recipeRegistry);
  seedTp2Example(modelRegistry, recipeRegistry);

  const activity = new ActivityLog();

  const deployments = new DeploymentService({
    recipeRegistry,
    onStateChange: (state) => {
      deps.broadcastLifecycle({ type: "lifecycle", state });
      if (state.lastOp) {
        activity.push({
          kind: "lifecycle",
          subject: state.recipeId,
          summary: `${state.lastOp} → ${state.state} (dry-run)`,
          attribution: null,
          meta: { managedBy: state.managedBy, dryRun: true },
        });
      }
    },
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
          // Let the manager stop the tail once all subscribers are gone.
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
        .find((r) => Number(r.apiPort) === p && (r.nodeIds || []).includes(nodeId)) || null
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
    // No token configured: lifecycle mutations stay closed unless the
    // operator explicitly opted into loopback dry-runs for development.
    const remote = !isLoopbackBind(process.env.BIND_HOST || "127.0.0.1");
    const socketLoopback = /^(127\.|::1)/.test(req.socket?.remoteAddress || "");
    if (
      !remote &&
      socketLoopback &&
      process.env.SPARKDASH_ALLOW_DRYRUN_LOOPBACK === "1"
    ) {
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

  // ─── Routes: models ────────────────────────────────────
  app.get("/api/models", (req, res) => {
    const includeArchived = req.query.includeArchived === "1";
    res.json({
      models: includeArchived ? modelRegistry.list() : modelRegistry.listActive(),
    });
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
    const states = new Map(deployments.listStates().map((s) => [s.recipeId, s]));
    res.json({
      model,
      recipes: recipes.map((r) => recipeRegistry.toPublic(r)),
      deployments: recipes.map((r) => states.get(r.id) || deployments.getState(r.id)),
    });
  });

  app.delete("/api/models/:id", (req, res) => {
    const hard = req.query.hard === "1";
    try {
      const result = modelRegistry.remove(req.params.id, {
        archive: !hard,
        hasRecipes: recipeRegistry.hasRecipesForModel(req.params.id),
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
      const recipe = recipeRegistry.upsert(req.body || {});
      activity.push({
        kind: "lifecycle",
        subject: recipe.id,
        summary: `recipe saved: ${recipe.name}`,
        meta: { modelId: recipe.modelId, nodes: recipe.nodeIds },
      });
      res.json({ recipe: recipeRegistry.toPublic(recipe) });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.get("/api/recipes/:id", (req, res) => {
    const recipe = recipeRegistry.get(req.params.id);
    if (!recipe) return res.status(404).json({ error: "recipe not found" });
    res.json({ recipe: recipeRegistry.toPublic(recipe) });
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

  // ─── Routes: deployments (DRY-RUN lifecycle) ───────────
  app.get("/api/deployments", (_req, res) => {
    res.json({ deployments: deployments.listStates(), dryRun: true });
  });

  for (const action of ["start", "stop", "restart"]) {
    app.post(`/api/deployments/:recipeId/${action}`, requireLifecycleAuth, (req, res) => {
      try {
        const state = deployments.begin(req.params.recipeId, action, { actor: actorOf(req) });
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
      logDir: recipe.logDir,
      ...liveConsole.status(recipe.id),
    });
  });

  // ─── Observation loops (called from the broadcast tick) ─
  const prevOnline = new Map();
  const seenBench = new Set();

  // Desired-vs-observed probe cache. An unauthenticated 401/403 CLASSIFIES as
  // auth-gated (the process is up and serving), never as stopped. The SSH
  // pgrep corroboration is strictly read-only; nothing is signalled here.
  const PROBE_TTL_MS = 6000;
  const DISCOVERY_TTL_MS = 60_000;
  /** recipeId -> { at: number, observed: string|null } */
  const probeCache = new Map();
  /** recipeId -> { at: number, value: boolean } */
  const discoveredCache = new Map();
  const discoveryInFlight = new Set();

  /** Declared probe host for a recipe's primary node (same host rule as LlmProbe). */
  function recipeHost(recipe) {
    const spark = sparkRegistry.getSpark(recipe.nodeIds?.[0]);
    return spark ? llmProbeHost(spark) : null;
  }

  /** Fallback classification from the monitor snapshot (first tick / mid-refresh). */
  function classifyFromSnapshot(recipe, snap) {
    const list = snap?.metrics?.llm || [];
    const llm = list.find((l) => l.port === recipe.apiPort) || list[0];
    if (!llm) return "not-detected";
    if (llm.available === true) return "running";
    // 401/403 posture from the existing probe: the endpoint answered but is gated.
    if (llm.posture?.auth === "protected") return "auth-gated";
    return classifyProbe({ status: null, errorCode: llm.errorCode, errorName: llm.errorName });
  }

  /** Fire-and-forget refresh of the read-only probe + pgrep corroboration. */
  function refreshProbes() {
    const now = Date.now();
    for (const recipe of recipeRegistry.list()) {
      if (recipe.metadata?.managedBy !== "external") continue;

      const cached = probeCache.get(recipe.id);
      if (!cached || now - cached.at >= PROBE_TTL_MS) {
        const url = probeUrl(recipeHost(recipe), recipe.apiPort, recipe.healthPath);
        probeCache.set(recipe.id, { at: now, observed: null });
        void probeEndpoint(url)
          .then((outcome) => {
            probeCache.set(recipe.id, { at: Date.now(), observed: classifyProbe(outcome) });
          })
          .catch(() => {
            probeCache.set(recipe.id, { at: Date.now(), observed: "not-detected" });
          });
      }

      const disc = discoveredCache.get(recipe.id);
      if (discoveryInFlight.has(recipe.id)) continue;
      if (disc && now - disc.at < DISCOVERY_TTL_MS) continue;
      const spark = sparkRegistry.getSpark(recipe.nodeIds?.[0]);
      if (!spark) continue;
      discoveryInFlight.add(recipe.id);
      sshExec(spark, "pgrep -f 'tabbyapi|vllm' >/dev/null 2>&1 && echo up || echo down", {
        timeoutMs: 6000,
      })
        .then((out) => discoveredCache.set(recipe.id, { at: Date.now(), value: /\bup\b/.test(out) }))
        .catch(() => discoveredCache.set(recipe.id, { at: Date.now(), value: false }))
        .finally(() => discoveryInFlight.delete(recipe.id));
    }
  }

  function observeFleet() {
    refreshProbes();

    // 1) Externally-managed deployments: derive observed state from the probe.
    for (const recipe of recipeRegistry.list()) {
      const primary = monitors.get(recipe.nodeIds?.[0]);
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
        if (online) {
          observed = probeCache.get(recipe.id)?.observed || classifyFromSnapshot(recipe, snap);
        }
      }
      deployments.observe(recipe.id, {
        observed,
        discovered: discoveredCache.get(recipe.id)?.value === true,
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

    // 3) Benchmark completions → activity events (real history entries only).
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

    // 4) Showcase sessions (real inference demos) → activity events.
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
    deployments,
    liveConsole,
    activity,
    handleWsMessage,
    detachClient,
    observeFleet,
    recipeForEndpoint,
    shutdown,
  };
}