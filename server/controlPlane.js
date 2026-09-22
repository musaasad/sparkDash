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

  function observeFleet() {
    // 1) Externally-managed deployments: derive state from LLM probes.
    for (const recipe of recipeRegistry.list()) {
      const primary = monitors.get(recipe.nodeIds?.[0]);
      if (!primary) {
        deployments.observe(recipe.id, { llmAvailable: false });
        continue;
      }
      let available = false;
      try {
        const snap = primary.snapshot();
        const llmList = snap?.metrics?.llm || [];
        available = llmList.some((l) => l.available);
      } catch {
        available = false;
      }
      deployments.observe(recipe.id, { llmAvailable: available });
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