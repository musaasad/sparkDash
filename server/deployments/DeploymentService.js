/**
 * DeploymentService — server-side lifecycle state for DEPLOYMENT bindings.
 *
 *   A deployment answers "where SHOULD this recipe run". This service is the
 *   OBSERVED layer: desired vs observed classification, display derivation and
 *   the DRY-RUN lifecycle simulation.
 *
 * SAFETY CONTRACT (this phase):
 *  - Every mutation is DRY-RUN. No SSH, no process control, no remote command
 *    is ever executed here.
 *  - Externally-managed deployments are OBSERVE-ONLY: state comes from the LLM
 *    probe; mutations are rejected with 409.
 *  - Duplicate launches are prevented in-memory.
 *  - Every operation is appended to config/audit.jsonl with a dryRun flag.
 *
 * `begin(id, …)` accepts a deployment id; a bare recipe id still resolves for
 * backward compatibility (older callers/tests).
 */
import fs from "fs";
import { atomicWrite } from "../util/atomicWrite.js";
import { AUDIT_LOG_PATH, DEPLOYMENTS_ACTIVE_PATH } from "../config.js";
import { deriveDisplay } from "./deploymentStatus.js";

export const DEPLOYMENT_STATES = Object.freeze([
  "available",
  "starting",
  "loading",
  "running",
  "stopping",
  "stopped",
  "error",
]);

/** Dry-run simulation cadence (ms from op start). */
const SIM_STEPS = {
  start: [
    { at: 0, state: "starting" },
    { at: 1500, state: "loading" },
    { at: 4000, state: "running" },
  ],
  stop: [
    { at: 0, state: "stopping" },
    { at: 1500, state: "stopped" },
  ],
};

export class DeploymentService {
  /**
   * @param {{
   *   recipeRegistry: {get: (id: string) => object|null},
   *   deploymentRegistry?: {get: (id: string)=>object|null, list: ()=>object[], setDesired: (id:string, s:string)=>object|null},
   *   auditPath?: string,
   *   activePath?: string,
   *   onStateChange?: (state: object) => void,
   * }} opts
   */
  constructor(opts) {
    this.recipeRegistry = opts.recipeRegistry;
    this.deploymentRegistry = opts.deploymentRegistry || null;
    this.auditPath = opts.auditPath || AUDIT_LOG_PATH;
    this.activePath = opts.activePath || DEPLOYMENTS_ACTIVE_PATH;
    this.onStateChange = opts.onStateChange || (() => {});
    /** @type {Map<string, object>} state key -> deployment runtime state */
    this._states = new Map();
    /** @type {Map<string, ReturnType<typeof setTimeout>[]>} pending sim timers */
    this._timers = new Map();
    this._loadActive();
  }

  /** Resolve a deployment id OR a bare recipe id to {dep, recipe}. */
  _resolve(id) {
    const dep = this.deploymentRegistry?.get(id) || null;
    if (dep) return { dep, recipe: this.recipeRegistry.get(dep.recipeId) };
    const recipe = this.recipeRegistry.get(id);
    if (recipe) return { dep: null, recipe };
    return null;
  }

  _key(id) {
    return this.deploymentRegistry?.get(id)?.id || id;
  }

  _loadActive() {
    try {
      if (!fs.existsSync(this.activePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.activePath, "utf8"));
      for (const d of Array.isArray(raw?.deployments) ? raw.deployments : []) {
        const rawKey = d.deploymentId || d.recipeId;
        if (!rawKey) continue;
        // Collapse legacy recipe-keyed checkpoints onto their deployment-entity
        // id so a recipe that now has a deployment binding never yields a second
        // runtime view. Stale entries whose recipe lost its binding are dropped.
        const dep = this.deploymentRegistry?.get(rawKey) || this.deploymentRegistry?.listForRecipe(d.recipeId)[0];
        if (this.deploymentRegistry && !dep) continue;
        const key = dep ? dep.id : rawKey;
        if (this._states.has(key)) continue; // deployment-keyed entry wins
        // Ops that were mid-flight when the server died settle to their end
        // state; nothing is actually running in dry-run mode.
        const settled =
          d.state === "starting" || d.state === "loading"
            ? "running"
            : d.state === "stopping"
              ? "stopped"
              : d.state;
        const desired =
          dep?.desiredState || d.desired || (d.managedBy === "external" ? "unknown" : "stopped");
        const observed = d.observed || "not-detected";
        this._states.set(key, {
          ...d,
          deploymentId: key,
          recipeId: dep?.recipeId || d.recipeId,
          desired,
          observed,
          discovered: Boolean(d.discovered),
          display: d.display || deriveDisplay({ desired, observed }),
          state: settled,
          recoveredAt: Date.now(),
        });
      }
    } catch (err) {
      console.error("[DeploymentService] active checkpoint load failed:", err.message);
    }
  }

  _checkpoint() {
    try {
      atomicWrite(
        this.activePath,
        JSON.stringify({ deployments: [...this._states.values()] }, null, 2),
        0o600
      );
    } catch (err) {
      console.error("[DeploymentService] checkpoint failed:", err.message);
    }
  }

  audit(entry) {
    const record = { ts: new Date().toISOString(), ...entry };
    try {
      fs.appendFileSync(this.auditPath, JSON.stringify(record) + "\n", { mode: 0o600 });
    } catch (err) {
      console.error("[DeploymentService] audit append failed:", err.message);
    }
    return record;
  }

  readAudit({ limit = 100 } = {}) {
    try {
      if (!fs.existsSync(this.auditPath)) return [];
      const lines = fs
        .readFileSync(this.auditPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .slice(-Math.max(1, Math.min(500, limit)));
      return lines
        .reverse()
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  _baseState(id, dep, recipe) {
    // Ownership follows the launch MECHANISM (the authoritative signal): only an
    // external mechanism is observe-only. Legacy rows without a mechanism fall
    // back to declared metadata so pre-existing external seeds stay external.
    const mechanism = recipe?.launch?.mechanism ?? dep?.metadata?.mechanism ?? null;
    const declared =
      dep?.metadata?.managedBy ?? recipe?.metadata?.managedBy ?? null;
    const managedBy =
      mechanism === "external" || declared === "external" ? "external" : "sparkdash";
    const declaredDesired =
      dep?.desiredState && dep.desiredState !== "unknown"
        ? dep.desiredState
        : recipe?.metadata?.desired ?? dep?.desiredState;
    const desired =
      declaredDesired === "running" || declaredDesired === "stopped"
        ? declaredDesired
        : managedBy === "external"
          ? "unknown"
          : "stopped";
    const nodeIds = dep?.nodeIds || recipe?.nodeIds || [];
    const observed = "not-detected";
    return {
      deploymentId: id,
      recipeId: recipe?.id ?? dep?.recipeId ?? null,
      modelId: dep?.modelId ?? recipe?.modelRef?.modelId ?? null,
      nodeIds,
      apiPort: recipe?.endpoint?.port ?? null,
      role: dep?.role ?? null,
      servedModelId: recipe?.metadata?.servedModelId ?? null,
      endpoint: recipe?.endpoint
        ? `${recipe.endpoint.scheme || "http"}://${recipe.endpoint.hostTemplate || "{nodeIp}"}:${recipe.endpoint.port}${recipe.endpoint.path || "/v1"}`
        : null,
      processEvidence: null,
      managedBy,
      dryRun: true,
      state: "available",
      desired,
      observed,
      discovered: false,
      display: deriveDisplay({ desired, observed }),
      lastOp: null,
      lastError: null,
      startedAt: null,
      updatedAt: Date.now(),
    };
  }

  getState(id) {
    const key = this._key(id);
    const existing = this._states.get(key);
    if (existing) return existing;
    const resolved = this._resolve(id);
    if (!resolved?.recipe) return null;
    const state = this._baseState(key, resolved.dep, resolved.recipe);
    this._states.set(key, state);
    return state;
  }

  listStates() {
    return [...this._states.values()];
  }

  /**
   * Observe-only update for externally-managed deployments.
   *
   * `observed` is the probe classification; an auth-gated 401 PROVES the process
   * is up. `discovered` is read-only SSH corroboration. Never transitions a
   * dry-run managed op while one is active.
   */
  observe(id, { observed, llmAvailable, discovered = false } = {}) {
    const state = this.getState(id);
    if (!state) return state;
    if (state.lastOp) return state; // an explicit op (dry-run) wins while active

    const observedNext = observed || (llmAvailable ? "running" : "not-detected");
    const stateNext =
      observedNext === "running" || observedNext === "auth-gated"
        ? "running"
        : observedNext === "unhealthy"
          ? "error"
          : "stopped";
    const display = deriveDisplay({ desired: state.desired, observed: observedNext, discovered });

    if (
      state.observed === observedNext &&
      state.display === display &&
      state.discovered === discovered
    ) {
      return state;
    }
    state.observed = observedNext;
    state.discovered = discovered;
    state.display = display;
    if (state.managedBy === "external") state.state = stateNext;
    state.updatedAt = Date.now();
    this._checkpoint();
    this.onStateChange({ ...state });
    return state;
  }

  _clearTimers(key) {
    for (const t of this._timers.get(key) || []) clearTimeout(t);
    this._timers.delete(key);
  }

  /**
   * Begin a dry-run operation. Returns the new state.
   * @param {string} id deployment or recipe id
   * @param {"start"|"stop"|"restart"} action
   * @param {{ actor?: string }} [opts]
   */
  begin(id, action, opts = {}) {
    const resolved = this._resolve(id);
    if (!resolved?.recipe) {
      const err = new Error(`deployment/recipe not found: ${id}`);
      err.status = 404;
      throw err;
    }
    const { dep, recipe } = resolved;
    if (recipe.lifecycleState === "archived" || recipe.archived) {
      const err = new Error("recipe is archived — restore it first");
      err.status = 409;
      throw err;
    }
    const key = dep?.id ?? recipe.id;
    const state = this.getState(key);
    if (state.managedBy === "external") {
      const err = new Error(
        "externally managed deployment — SparkDash does not control this process (observe-only)"
      );
      err.status = 409;
      throw err;
    }
    if (state.lastOp) {
      const err = new Error(`an operation is already active for this deployment: ${state.lastOp}`);
      err.status = 409;
      throw err;
    }

    const steps =
      action === "restart"
        ? [...SIM_STEPS.stop, ...SIM_STEPS.start.map((s) => ({ at: s.at + 2000, state: s.state }))]
        : SIM_STEPS[action];
    if (!steps) {
      const err = new Error(`unknown lifecycle action: ${action}`);
      err.status = 400;
      throw err;
    }

    state.lastOp = action;
    state.lastError = null;
    this._clearTimers(key);
    const timers = [];
    for (const step of steps) {
      const apply = () => {
        state.state = step.state;
        state.display = step.state;
        state.updatedAt = Date.now();
        if (step.state === "running") {
          state.startedAt = Date.now();
          state.desired = "running";
          if (dep) this.deploymentRegistry.setDesired(dep.id, "running");
        }
        if (step.state === "stopped") {
          state.desired = "stopped";
          if (dep) this.deploymentRegistry.setDesired(dep.id, "stopped");
        }
        if (step.state === "stopped" || step.state === "running") {
          state.lastOp = null;
          this._timers.delete(key);
          state.display = deriveDisplay({ desired: state.desired, observed: state.observed });
        }
        this._checkpoint();
        this.onStateChange({ ...state });
      };
      if (step.at === 0) apply();
      else timers.push(setTimeout(apply, step.at));
    }
    if (timers.length) this._timers.set(key, timers);

    this.audit({
      actor: opts.actor || "api",
      node: (state.nodeIds || []).join(","),
      recipe: state.recipeId,
      deployment: state.deploymentId,
      action,
      result: "accepted",
      dryRun: true,
    });
    this._checkpoint();
    this.onStateChange({ ...state });
    return { ...state };
  }

  /** Test/shutdown hook: cancel pending simulation timers. */
  cancelAll() {
    for (const timers of this._timers.values()) for (const t of timers) clearTimeout(t);
    this._timers.clear();
  }
}
