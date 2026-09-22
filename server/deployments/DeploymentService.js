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
          this._states.set(d.recipeId, {
            ...d,
            state: d.state === "starting" || d.state === "loading" ? "running" : d.state === "stopping" ? "stopped" : d.state,
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
    return {
      recipeId: recipe.id,
      modelId: recipe.modelId,
      nodeIds: recipe.nodeIds || [],
      apiPort: recipe.apiPort,
      managedBy: recipe.metadata?.managedBy === "sparkdash" ? "sparkdash" : "external",
      dryRun: true,
      state: "available",
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
   * Observe-only update for externally-managed deployments: the LLM probe
   * says whether the endpoint answers, which maps to running/unavailable.
   * Never transitions a dry-run managed op.
   */
  observe(recipeId, { llmAvailable }) {
    const state = this.getState(recipeId);
    if (!state || state.managedBy !== "external") return state;
    if (state.lastOp) return state; // an explicit op (dry-run) wins while active
    const next = llmAvailable ? "running" : "stopped";
    if (state.state !== next) {
      state.state = next;
      state.updatedAt = Date.now();
      this._checkpoint();
      this.onStateChange({ ...state });
    }
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
        state.updatedAt = Date.now();
        if (step.state === "running") state.startedAt = Date.now();
        if (step.state === "stopped" || step.state === "running") {
          state.lastOp = null;
          this._timers.delete(recipeId);
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