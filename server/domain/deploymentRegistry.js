/**
 * DeploymentRegistry — DEPLOYMENT bindings: WHERE a recipe SHOULD run.
 *
 *   {id, modelId, recipeId, nodeIds[], desiredState, metadata, createdAt, updatedAt}
 *
 * A deployment is the join of MODEL + RECIPE + COMPUTE. Removing a deployment
 * only removes the binding — never the model, recipe or weights. Lifecycle
 * (start/stop) stays DRY-RUN and lives in DeploymentService.
 */
import fs from "fs";
import { atomicWrite } from "../util/atomicWrite.js";
import { DEPLOYMENTS_JSON_PATH } from "../config.js";
import { normalizeDeployment, validateDeployment } from "./schema.js";

const MAX_DEPLOYMENTS = 1024;

export class DeploymentRegistry {
  /** @param {{path?: string}} [opts] */
  constructor(opts = {}) {
    this.path = opts.path || DEPLOYMENTS_JSON_PATH;
    /** @type {Map<string, object>} */
    this._deployments = new Map();
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.path)) return;
      const raw = JSON.parse(fs.readFileSync(this.path, "utf8"));
      for (const d of Array.isArray(raw?.deployments) ? raw.deployments : []) {
        if (d?.id) this._deployments.set(d.id, normalizeDeployment(d));
      }
    } catch (err) {
      console.error("[DeploymentRegistry] load failed:", err.message);
    }
  }

  reload() {
    this._deployments.clear();
    this._load();
  }

  _save() {
    atomicWrite(
      this.path,
      JSON.stringify({ schemaVersion: 2, deployments: [...this._deployments.values()] }, null, 2),
      0o600
    );
  }

  list() {
    return [...this._deployments.values()];
  }

  get(id) {
    return this._deployments.get(id) || null;
  }

  listForModel(modelId) {
    return this.list().filter((d) => d.modelId === modelId);
  }

  listForRecipe(recipeId) {
    return this.list().filter((d) => d.recipeId === recipeId);
  }

  hasForModel(modelId) {
    return this.list().some((d) => d.modelId === modelId);
  }

  hasForRecipe(recipeId) {
    return this.list().some((d) => d.recipeId === recipeId);
  }

  /** @throws {Error & {status:number}} */
  create(body) {
    const dep = normalizeDeployment(body);
    if (!dep.id) dep.id = `dep-${dep.recipeId}-${Math.random().toString(36).slice(2, 7)}`;
    const { ok, errors } = validateDeployment(dep);
    if (!ok) {
      const err = new Error(errors.join("; "));
      err.status = 400;
      throw err;
    }
    if (this._deployments.has(dep.id)) {
      const err = new Error(`deployment id already exists: ${dep.id}`);
      err.status = 409;
      throw err;
    }
    if (this._deployments.size >= MAX_DEPLOYMENTS) {
      const err = new Error(`Deployment registry is full (${MAX_DEPLOYMENTS})`);
      err.status = 409;
      throw err;
    }
    this._deployments.set(dep.id, dep);
    this._save();
    return dep;
  }

  /** Update the desired intent only (dry-run semantics). */
  setDesired(id, desiredState) {
    const dep = this._deployments.get(id);
    if (!dep) return null;
    dep.desiredState = desiredState;
    dep.updatedAt = Date.now();
    this._deployments.set(id, dep);
    this._save();
    return dep;
  }

  /** Never touches model/recipe/weights — binding only. */
  remove(id) {
    if (!this._deployments.has(id)) return null;
    this._deployments.delete(id);
    this._save();
    return { deleted: true, id };
  }

  /** Ensure a binding exists for a recipe's legacy nodeIds (seed/idempotent). */
  ensureForRecipe(recipe, { managedBy = "external" } = {}) {
    if (!recipe?.nodeIds?.length) return null;
    const id = `dep-${recipe.id}`;
    if (this._deployments.has(id)) return this._deployments.get(id);
    return this.create({
      id,
      modelId: recipe.modelRef?.modelId,
      recipeId: recipe.id,
      nodeIds: recipe.nodeIds,
      desiredState: recipe.metadata?.desired === "running" ? "running" : "unknown",
      metadata: { managedBy },
    });
  }
}

export const deploymentRegistry = new DeploymentRegistry();
