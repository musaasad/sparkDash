/**
 * ModelRegistry — the logical Model layer of the control plane.
 *
 *   Model → Deployment Recipe → Runtime → Compute Nodes
 *
 * A Model is the family/identity ("Qwen 3.8 Flash Next"); the ways to run it
 * live in RecipeRegistry. Persistence mirrors SparkRegistry: atomic JSON at
 * config/models.json, no secrets in this file, `toPublic` redaction boundary.
 *
 * Archiving a model NEVER deletes weights — it only hides the entry from the
 * active list while preserving recipes, notes and benchmark history.
 */
import fs from "fs";
import { atomicWrite } from "../util/atomicWrite.js";
import { MODELS_JSON_PATH } from "../config.js";
import { validateModelWrite, isValidSlug } from "../validate.js";

const MAX_MODELS = 512;

export class ModelRegistry {
  /**
   * @param {{ path?: string }} [opts]
   */
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
      const list = Array.isArray(raw?.models) ? raw.models : [];
      for (const m of list) {
        if (m && isValidSlug(m.id)) this._models.set(m.id, m);
      }
    } catch (err) {
      console.error("[ModelRegistry] load failed:", err.message);
    }
  }

  _save() {
    atomicWrite(this.path, JSON.stringify({ models: [...this._models.values()] }, null, 2), 0o600);
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
   * Create or replace a model. Validation is strict (validateModelWrite).
   * @throws {Error & {status: number}}
   */
  upsert(body) {
    const { ok, errors } = validateModelWrite(body);
    if (!ok) {
      const err = new Error(errors.join("; "));
      err.status = 400;
      throw err;
    }
    const prev = this._models.get(body.id);
    if (!prev && this._models.size >= MAX_MODELS) {
      const err = new Error(`Model registry is full (${MAX_MODELS})`);
      err.status = 409;
      throw err;
    }
    const now = Date.now();
    const model = {
      id: body.id,
      name: String(body.name).trim(),
      family: body.family != null ? String(body.family).trim() : null,
      notes: body.notes != null ? String(body.notes) : "",
      archived: Boolean(body.archived ?? prev?.archived ?? false),
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    this._models.set(model.id, model);
    this._save();
    return model;
  }

  /**
   * Archive semantics: mark archived (preserves everything). Hard delete is
   * only allowed for entries with no recipes — recipes own the weights-adjacent
   * config, so the caller must pass `hasRecipes` from RecipeRegistry.
   * @param {string} id
   * @param {{ archive?: boolean, hasRecipes?: boolean }} [opts]
   */
  remove(id, opts = {}) {
    const model = this._models.get(id);
    if (!model) return null;
    if (opts.archive === false) {
      if (opts.hasRecipes) {
        const err = new Error("Model still has recipes — archive it instead of deleting");
        err.status = 409;
        throw err;
      }
      this._models.delete(id);
      this._save();
      return { deleted: true, id };
    }
    model.archived = true;
    model.updatedAt = Date.now();
    this._models.set(id, model);
    this._save();
    return { archived: true, id };
  }

  restore(id) {
    const model = this._models.get(id);
    if (!model) return null;
    model.archived = false;
    model.updatedAt = Date.now();
    this._models.set(id, model);
    this._save();
    return model;
  }
}

export const modelRegistry = new ModelRegistry();