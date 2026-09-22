/**
 * ModelRegistry — the logical MODEL layer of the control plane (v2).
 *
 *   Model (weights identity) → Recipe (how it CAN run) → Deployment (where it
 *   SHOULD run) → Runtime (observed) → Compute.
 *
 * Weights identity lives HERE (weightPaths map with variant ids), not in
 * recipes. A model may carry several weight variants (e.g. default EXL3 vs
 * 2.9bpw) selected by a recipe via modelRef.weightId.
 *
 * Persistence mirrors SparkRegistry: atomic JSON at config/models.json, no
 * secrets in this file. Archiving NEVER deletes weights (flag only); hard
 * delete is blocked while any recipe or deployment references the model.
 */
import fs from "fs";
import { atomicWrite } from "../util/atomicWrite.js";
import { MODELS_JSON_PATH } from "../config.js";
import { normalizeModel, validateModel } from "../domain/schema.js";
import { migrateModelsFile } from "../domain/migrate.js";

const MAX_MODELS = 512;

export class ModelRegistry {
  /** @param {{ path?: string }} [opts] */
  constructor(opts = {}) {
    this.path = opts.path || MODELS_JSON_PATH;
    /** @type {Map<string, object>} */
    this._models = new Map();
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.path)) return;
      const raw = JSON.parse(fs.readFileSync(this.path, "utf8"));
      for (const m of Array.isArray(raw?.models) ? raw.models : []) {
        if (m && m.id) this._models.set(m.id, normalizeModel(m));
      }
    } catch (err) {
      console.error("[ModelRegistry] load failed:", err.message);
    }
  }

  /** Re-read from disk (used after a v1→v2 migration rewrote the file). */
  reload() {
    this._models.clear();
    this._load();
  }

  /** Migrate an on-disk v1 file to v2 in place (idempotent, writes a .v1.bak). */
  migrate() {
    return migrateModelsFile(this.path);
  }

  _save() {
    atomicWrite(this.path, JSON.stringify({ schemaVersion: 2, models: [...this._models.values()] }, null, 2), 0o600);
  }

  /** All models including archived. */
  list() {
    return [...this._models.values()];
  }

  /** Active (non-archived) models. */
  listActive() {
    return this.list().filter((m) => !m.archived);
  }

  get(id) {
    return this._models.get(id) || null;
  }

  /**
   * Create or replace a model. `body` may be v1-flat or v2 structured; legacy
   * `modelPath` lands on weightPaths.default.
   * @throws {Error & {status: number}}
   */
  upsert(body) {
    const model = normalizeModel(body, this._models.get(body?.id) || null);
    const { ok, errors } = validateModel(model);
    if (!ok) {
      const err = new Error(errors.join("; "));
      err.status = 400;
      throw err;
    }
    const prev = this._models.get(model.id);
    if (!prev && this._models.size >= MAX_MODELS) {
      const err = new Error(`Model registry is full (${MAX_MODELS})`);
      err.status = 409;
      throw err;
    }
    this._models.set(model.id, model);
    this._save();
    return model;
  }

  /** Set/overwrite one weight variant path (used by the recipe editor flow). */
  setWeightPath(id, variant, absPath) {
    const model = this._models.get(id);
    if (!model) return null;
    model.weightPaths = model.weightPaths || {};
    model.weightPaths[variant || "default"] = absPath;
    model.updatedAt = Date.now();
    this._models.set(id, model);
    this._save();
    return model;
  }

  /**
   * Archive semantics: flag archived + archivedAt (weights preserved). Hard
   * delete only when nothing references the model.
   * @param {string} id
   * @param {{ archive?: boolean, hasRecipes?: boolean, hasDeployments?: boolean }} [opts]
   */
  remove(id, opts = {}) {
    const model = this._models.get(id);
    if (!model) return null;
    if (opts.archive === false) {
      if (opts.hasRecipes || opts.hasDeployments) {
        const err = new Error("Model is still referenced by recipes/deployments — archive it instead of deleting");
        err.status = 409;
        throw err;
      }
      this._models.delete(id);
      this._save();
      return { deleted: true, id };
    }
    model.archived = true;
    model.archivedAt = Date.now();
    model.updatedAt = Date.now();
    this._models.set(id, model);
    this._save();
    return { archived: true, id };
  }

  restore(id) {
    const model = this._models.get(id);
    if (!model) return null;
    model.archived = false;
    model.archivedAt = null;
    model.updatedAt = Date.now();
    this._models.set(id, model);
    this._save();
    return model;
  }
}

export const modelRegistry = new ModelRegistry();
