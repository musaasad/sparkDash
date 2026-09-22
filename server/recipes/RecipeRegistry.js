/**
 * RecipeRegistry — Deployment Recipes: known-working ways to run a model.
 *
 * A recipe describes runtime, model path, workdir, topology (single/tp2/tp3),
 * assigned nodes, API port, health endpoint, context, env vars, CPU affinity,
 * launcher and notes. Node references are SparkRegistry ids (never free host
 * strings) so the target allowlist keeps its teeth.
 *
 * Env entries may be flagged `secret: true`; their values are then treated as
 * credentials: stored in the JSON file (lab-local, mode 0600) but STRIPPED
 * from every API response by `toPublic`.
 */
import fs from "fs";
import { atomicWrite } from "../util/atomicWrite.js";
import { RECIPES_JSON_PATH } from "../config.js";
import { validateRecipeWrite, isValidSlug } from "../validate.js";

const MAX_RECIPES = 1024;

export class RecipeRegistry {
  /**
   * @param {{ path?: string, getKnownNodeIds?: () => string[] }} [opts]
   */
  constructor(opts = {}) {
    this.path = opts.path || RECIPES_JSON_PATH;
    this.getKnownNodeIds = opts.getKnownNodeIds || (() => null);
    /** @type {Map<string, object>} */
    this._recipes = new Map();
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.path)) return;
      const raw = JSON.parse(fs.readFileSync(this.path, "utf8"));
      const list = Array.isArray(raw?.recipes) ? raw.recipes : [];
      for (const r of list) {
        if (r && isValidSlug(r.id)) this._recipes.set(r.id, r);
      }
    } catch (err) {
      console.error("[RecipeRegistry] load failed:", err.message);
    }
  }

  _save() {
    atomicWrite(this.path, JSON.stringify({ recipes: [...this._recipes.values()] }, null, 2), 0o600);
  }

  list({ includeArchived = false } = {}) {
    const all = [...this._recipes.values()];
    return includeArchived ? all : all.filter((r) => !r.archived);
  }

  listForModel(modelId, opts = {}) {
    return this.list(opts).filter((r) => r.modelId === modelId);
  }

  get(id) {
    return this._recipes.get(id) || null;
  }

  hasRecipesForModel(modelId) {
    return [...this._recipes.values()].some((r) => r.modelId === modelId);
  }

  /**
   * Redacted view for API responses: secret-flagged env values never leave
   * the server. Mirrors SparkRegistry.toPublic conventions.
   */
  toPublic(recipe) {
    if (!recipe) return recipe;
    const env = Array.isArray(recipe.env)
      ? recipe.env.map((e) =>
          e?.secret
            ? { name: e.name, secret: true, hasValue: e.value != null && e.value !== "" }
            : { name: e.name, value: e.value ?? "", secret: false }
        )
      : [];
    return { ...recipe, env };
  }

  listPublic(opts = {}) {
    return this.list(opts).map((r) => this.toPublic(r));
  }

  /** Port-conflict guard: same node + same API port across active recipes. */
  _assertNoPortConflict(candidate) {
    for (const other of this._recipes.values()) {
      if (other.id === candidate.id || other.archived) continue;
      if (Number(other.apiPort) !== Number(candidate.apiPort)) continue;
      const overlap = (other.nodeIds || []).filter((n) => (candidate.nodeIds || []).includes(n));
      if (overlap.length > 0) {
        const err = new Error(
          `Port ${candidate.apiPort} is already used by recipe "${other.id}" on node(s) ${overlap.join(", ")}`
        );
        err.status = 409;
        throw err;
      }
    }
  }

  /**
   * Create or replace a recipe. `knownNodes` defaults to the live Spark
   * registry ids via the injected getter; pass `skipNodeCheck` only in tests.
   * @throws {Error & {status: number}}
   */
  upsert(body, { skipNodeCheck = false } = {}) {
    const known = skipNodeCheck ? [] : this.getKnownNodeIds() || [];
    const { ok, errors } = validateRecipeWrite(body, { nodeIds: skipNodeCheck ? undefined : known });
    if (!ok) {
      const err = new Error(errors.join("; "));
      err.status = 400;
      throw err;
    }
    const prev = this._recipes.get(body.id);
    if (!prev && this._recipes.size >= MAX_RECIPES) {
      const err = new Error(`Recipe registry is full (${MAX_RECIPES})`);
      err.status = 409;
      throw err;
    }
    // Preserve stored secret values when the client echoes back a redacted
    // env entry (name + secret + hasValue, no value) on edit.
    const prevEnvByName = new Map((prev?.env || []).map((e) => [e.name, e]));
    const env = (Array.isArray(body.env) ? body.env : []).map((e) => {
      const stored = prevEnvByName.get(e.name);
      if (e.secret && (e.value == null || e.value === "") && stored?.secret) {
        return { name: e.name, value: stored.value, secret: true };
      }
      return { name: e.name, value: e.value ?? "", secret: Boolean(e.secret) };
    });
    const recipe = {
      id: body.id,
      modelId: body.modelId,
      name: String(body.name).trim(),
      runtime: body.runtime,
      topology: body.topology,
      nodeIds: [...body.nodeIds],
      modelPath: body.modelPath,
      workdir: body.workdir,
      logDir: body.logDir || null,
      apiPort: Number(body.apiPort),
      healthPath: body.healthPath || "/v1/models",
      contextLength: body.contextLength != null ? Number(body.contextLength) : null,
      cpuAffinity: body.cpuAffinity || null,
      launcher: body.launcher || null,
      metadata:
        body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
          ? body.metadata
          : {},
      notes: body.notes || "",
      env,
      archived: Boolean(body.archived ?? prev?.archived ?? false),
      createdAt: prev?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    this._assertNoPortConflict(recipe);
    this._recipes.set(recipe.id, recipe);
    this._save();
    return recipe;
  }

  /** Archive (default) — preserves everything; hard delete is explicit. */
  remove(id, { archive = true } = {}) {
    const recipe = this._recipes.get(id);
    if (!recipe) return null;
    if (!archive) {
      this._recipes.delete(id);
      this._save();
      return { deleted: true, id };
    }
    recipe.archived = true;
    recipe.updatedAt = Date.now();
    this._recipes.set(id, recipe);
    this._save();
    return { archived: true, id };
  }

  restore(id) {
    const recipe = this._recipes.get(id);
    if (!recipe) return null;
    recipe.archived = false;
    recipe.updatedAt = Date.now();
    this._recipes.set(id, recipe);
    this._save();
    return recipe;
  }

  /**
   * Clone an existing recipe under a new id (server-side copy; secret env
   * values carry over without ever crossing the API boundary).
   */
  clone(sourceId, newId, overrides = {}) {
    const src = this._recipes.get(sourceId);
    if (!src) return null;
    if (!isValidSlug(newId)) {
      const err = new Error("new recipe id must be a lowercase slug");
      err.status = 400;
      throw err;
    }
    if (this._recipes.has(newId)) {
      const err = new Error(`recipe id already exists: ${newId}`);
      err.status = 409;
      throw err;
    }
    const body = {
      ...src,
      ...overrides,
      id: newId,
      name: overrides.name || `${src.name} (copy)`,
      env: (src.env || []).map((e) => ({ ...e })),
      nodeIds: overrides.nodeIds || [...(src.nodeIds || [])],
    };
    return this.upsert(body);
  }
}

export const recipeRegistry = new RecipeRegistry();