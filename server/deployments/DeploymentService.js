/**
 * DeploymentService — server-side lifecycle state for model deployments.
 *
 * SAFETY CONTRACT (this phase):
 *  - Every mutation is DRY-RUN. No SSH, no process control, no remote command
 *    is ever executed here. Tests assert zero sshExec calls.
 *  - Externally-managed deployments (e.g. Qwen on dgx-3 started outside
 *    SparkDash) are OBSERVE-ONLY: their state comes from the LLM probe;
 *    mutations are rejected with 409 and an explicit reason.
 *  - Duplicate launches are prevented with an in-memory lock plus a
 *    checkpoint file (mirrors the benchmark manager pattern).
 *  - Every operation is appended to config/audit.jsonl with a dryRun flag.
 *
 * Long-term, the managed path will execute an allowlisted launcher command
 * built ONLY from validated recipe fields via shlexQuote — never free-form
 * shell, never the Hermes remote-mutation pattern.
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
   *   auditPath?: string,
   *   activePath?: string,
   *   onStateChange?: (state: object) => void,
   * }} opts
   */
  constructor(opts) {
    this.recipeRegistry = opts.recipeRegistry;
    this.auditPath = opts.auditPath || AUDIT_LOG_PATH;
    this.activePath = opts.activePath || DEPLOYMENTS_ACTIVE_PATH;
    this.onStateChange = opts.onStateChange || (() => {});
    /** @type {Map<string, object>} recipeId -> deployment state */
    this._states = new Map();
    /** @type {Map<string, ReturnType<typeof setTimeout>[]>} pending sim timers */
    this._timers = new Map();
    this._loadActive();
  }

  _loadActive() {
    try {
      if (!fs.existsSync(this.activePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.activePath, "utf8"));
      for (const d of Array.isArray(raw?.deployments) ? raw.deployments : []) {
        if (d?.recipeId) {
          // Ops that were mid-flight when the server died settle to their
          // end state; nothing is actually running in dry-run mode.
          const settled =
            d.state === "starting" || d.state === "loading"
              ? "running"
              : d.state === "stopping"
                ? "stopped"
                : d.state;
          const desired = d.desired || (d.managedBy === "external" ? "unknown" : "stopped");
          const observed = d.observed || "not-detected";
          this._states.set(d.recipeId, {
            ...d,
            desired,
            observed,
            discovered: Boolean(d.discovered),
            display: d.display || deriveDisplay({ desired, observed }),
            state: settled,
            recoveredAt: Date.now(),
          });
        }
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

  _baseState(recipe) {
    const managedBy = recipe.metadata?.managedBy === "sparkdash" ? "sparkdash" : "external";
    // Externally-managed recipes have no SparkDash intent → desired stays
    // unknown unless the seed asserts an operator intent via metadata.desired.
    const declared = recipe.metadata?.desired;
    const desired =
      declared === "running" || declared === "stopped"
        ? declared
        : managedBy === "external"
          ? "unknown"
          : "stopped";
    const observed = "not-detected";
    return {
      recipeId: recipe.id,
      modelId: recipe.modelId,
      nodeIds: recipe.nodeIds || [],
      apiPort: recipe.apiPort,
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

  getState(recipeId) {
    const existing = this._states.get(recipeId);
    if (existing) return existing;
    const recipe = this.recipeRegistry.get(recipeId);
    if (!recipe) return null;
    const state = this._baseState(recipe);
    this._states.set(recipeId, state);
    return state;
  }

  listStates() {
    return [...this._states.values()];
  }

  /**
   * Observe-only update for externally-managed deployments.
   *
   * `observed` is the probe classification (see deploymentStatus.classifyProbe);
   * an auth-gated 401 PROVES the process is up. `llmAvailable` is kept for
   * backward compatibility and maps to running / not-detected. `discovered` is
   * read-only SSH corroboration evidence. Never transitions a dry-run managed op.
   *
   * @param {string} recipeId
   * @param {{ observed?: string, llmAvailable?: boolean, discovered?: boolean }} input
   */
  observe(recipeId, { observed, llmAvailable, discovered = false } = {}) {
    const state = this.getState(recipeId);
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
    // Externally-managed recipes have no dry-run engine owning `state`; managed
    // recipes keep the lifecycle state the dry-run op settled on.
    if (state.managedBy === "external") state.state = stateNext;
    state.updatedAt = Date.now();
    this._checkpoint();
    this.onStateChange({ ...state });
    return state;
  }

  _clearTimers(recipeId) {
    for (const t of this._timers.get(recipeId) || []) clearTimeout(t);
    this._timers.delete(recipeId);
  }

  /**
   * Begin a dry-run operation. Returns the new state.
   * @param {string} recipeId
   * @param {"start"|"stop"|"restart"} action
   * @param {{ actor?: string }} [opts]
   */
  begin(recipeId, action, opts = {}) {
    const recipe = this.recipeRegistry.get(recipeId);
    if (!recipe) {
      const err = new Error(`recipe not found: ${recipeId}`);
      err.status = 404;
      throw err;
    }
    if (recipe.archived) {
      const err = new Error("recipe is archived — restore it first");
      err.status = 409;
      throw err;
    }
    const state = this.getState(recipeId);
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
    this._clearTimers(recipeId);
    const timers = [];
    for (const step of steps) {
      const apply = () => {
        state.state = step.state;
        // Transitional lifecycle steps pass through to the display pill so the
        // pulse stays honest; settled steps recompute from desired+observed.
        state.display = step.state;
        state.updatedAt = Date.now();
        if (step.state === "running") {
          state.startedAt = Date.now();
          state.desired = "running";
        }
        if (step.state === "stopped") state.desired = "stopped";
        if (step.state === "stopped" || step.state === "running") {
          state.lastOp = null;
          this._timers.delete(recipeId);
          state.display = deriveDisplay({ desired: state.desired, observed: state.observed });
        }
        this._checkpoint();
        this.onStateChange({ ...state });
      };
      if (step.at === 0) apply();
      else timers.push(setTimeout(apply, step.at));
    }
    if (timers.length) this._timers.set(recipeId, timers);

    this.audit({
      actor: opts.actor || "api",
      node: (recipe.nodeIds || []).join(","),
      recipe: recipeId,
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