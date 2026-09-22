/**
 * RecipeRegistry — Deployment RECIPES v2: declarative, reusable, protected.
 *
 * A recipe answers "how CAN this model run" — engine, serving, launch, endpoint,
 * topology, probes, discovery, log source and dry-run lifecycle command
 * templates. It carries NO weight paths (those live on the MODEL), NO raw
 * secret values (secretRef only) and keeps `nodeIds` only as a legacy binding
 * hint — the canonical binding lives in the DEPLOYMENT registry.
 *
 * Secret env entries use `secretRef: 'recipe:<recipeId>:<NAME>'`; the value is
 * moved to the existing encrypted secrets store and STRIPPED from API responses.
 */
import fs from "fs";
import { atomicWrite } from "../util/atomicWrite.js";
import { RECIPES_JSON_PATH } from "../config.js";
import { isValidSlug, isValidPosixPath } from "../validate.js";
import { normalizeRecipe, validateRecipeV2, topologySlug } from "../domain/schema.js";
import { validateRecipeFeasibility } from "../domain/recipeValidate.js";
import { applyTransition } from "../domain/recipeLifecycle.js";
import { migrateRecipesFile } from "../domain/migrate.js";
import { saveRecipeEnv, loadRecipeEnv } from "../secretsStore.js";

const MAX_RECIPES = 1024;

/** Non-leaking secret hint: first 3 and last 4 characters. */
function maskHint(value) {
  if (value == null || value === "") return null;
  const s = String(value);
  if (s.length <= 8) return `${s.slice(0, 2)}…`;
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}

export class RecipeRegistry {
  /** @param {{ path?: string, getKnownNodeIds?: () => string[] }} [opts] */
  constructor(opts = {}) {
    this.path = opts.path || RECIPES_JSON_PATH;
    this.getKnownNodeIds = opts.getKnownNodeIds || (() => null);
    /** Optional resolver: recipe -> model weight absolute path (for toPublic). */
    this.getModelWeightPath = opts.getModelWeightPath || (() => null);
    /** Optional deps for feasibility validation (set by the control plane). */
    this.modelRegistry = null;
    this.deploymentRegistry = null;
    /** @type {Map<string, object>} */
    this._recipes = new Map();
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.path)) return;
      const raw = JSON.parse(fs.readFileSync(this.path, "utf8"));
      for (const r of Array.isArray(raw?.recipes) ? raw.recipes : []) {
        if (r && r.id) this._recipes.set(r.id, normalizeRecipe(r));
      }
    } catch (err) {
      console.error("[RecipeRegistry] load failed:", err.message);
    }
  }

  reload() {
    this._recipes.clear();
    this._load();
  }

  /** Migrate an on-disk v1 file to v2 in place (idempotent, writes a .v1.bak). */
  migrate() {
    return migrateRecipesFile(this.path);
  }

  _save() {
    // Secret values never persist in recipes.json — only secretRef by name.
    const strip = (r) => {
      if (!r?.launch?.env) return r;
      const env = r.launch.env.map((e) => (e.secretRef ? { name: e.name, secretRef: e.secretRef } : e));
      return { ...r, env, launch: { ...r.launch, env } };
    };
    atomicWrite(
      this.path,
      JSON.stringify({ schemaVersion: 2, recipes: [...this._recipes.values()].map(strip) }, null, 2),
      0o600
    );
  }

  list({ includeArchived = false } = {}) {
    const all = [...this._recipes.values()];
    return includeArchived ? all : all.filter((r) => !r.archived);
  }

  listForModel(modelId, opts = {}) {
    return this.list(opts).filter((r) => r.modelRef?.modelId === modelId);
  }

  get(id) {
    return this._recipes.get(id) || null;
  }

  hasRecipesForModel(modelId) {
    return [...this._recipes.values()].some((r) => r.modelRef?.modelId === modelId);
  }

  /**
   * Redacted public view: secret values never cross the API boundary, but the
   * secretRef and hasValue do so the client can round-trip safely. Also exposes
   * legacy flat projection fields (modelId/runtime/topology/nodeIds/apiPort/…)
   * so existing consumers keep working without changes.
   */
  toPublic(recipe) {
    if (!recipe) return recipe;
    const env = (recipe.launch?.env || []).map((e) =>
      e.secretRef
        ? { name: e.name, secret: true, hasValue: e.value != null && e.value !== "", secretRef: e.secretRef, hint: maskHint(e.value) }
        : { name: e.name, value: e.value ?? "", secret: false }
    );
    const modelId = recipe.modelRef?.modelId ?? null;
    const weightPath =
      this.getModelWeightPath(recipe) || recipe.launch?.workdir || null;
    return {
      ...recipe,
      launch: { ...recipe.launch, env },
      env,
      modelId,
      runtime: recipe.engine.runtime,
      topology: topologySlug(recipe.topology),
      topologyBlock: recipe.topology,
      apiPort: recipe.endpoint.port,
      healthPath: recipe.healthProbe.path,
      contextLength: recipe.serving.contextLength,
      cpuAffinity: recipe.launch.affinity ?? null,
      logDir: recipe.logSource.path ?? null,
      launcher: recipe.launch.command ?? null,
      modelPath: weightPath,
      archived: Boolean(recipe.archived || recipe.lifecycleState === "archived"),
      secretsMissing: Boolean(recipe.metadata?.secretsMissing),
    };
  }

  listPublic(opts = {}) {
    return this.list(opts).map((r) => this.toPublic(r));
  }

  /** Persist any secret env values to the encrypted store (keyed by secretRef). */
  _persistSecrets(recipe) {
    const store = loadRecipeEnv();
    let changed = false;
    for (const e of recipe.launch?.env || []) {
      if (e.secretRef && e.value != null && e.value !== "") {
        if (store.get(e.secretRef) !== e.value) {
          store.set(e.secretRef, e.value);
          changed = true;
        }
      }
    }
    if (changed) saveRecipeEnv(store);
  }

  /** Port-conflict guard: same node + same endpoint port across active recipes. */
  _assertNoPortConflict(candidate) {
    for (const other of this._recipes.values()) {
      if (other.id === candidate.id || other.archived) continue;
      if (Number(other.endpoint?.port) !== Number(candidate.endpoint?.port)) continue;
      const overlap = (other.nodeIds || []).filter((n) => (candidate.nodeIds || []).includes(n));
      if (overlap.length > 0) {
        const err = new Error(
          `Port ${candidate.endpoint.port} is already used by recipe "${other.id}" on node(s) ${overlap.join(", ")}`
        );
        err.status = 409;
        throw err;
      }
    }
  }

  /**
   * Create or replace a recipe. `body` may be v1-flat or v2 structured.
   * @throws {Error & {status: number}}
   */
  upsert(body, { skipNodeCheck = false } = {}) {
    const prev = this._recipes.get(body?.id) || null;
    const recipe = normalizeRecipe(body, prev);
    const errors = [];

    if (body?.modelPath != null && body.modelPath !== "" && !isValidPosixPath(body.modelPath))
      errors.push("modelPath must be an absolute POSIX path without .. or shell metacharacters");
    if (body?.logDir != null && body.logDir !== "" && !isValidPosixPath(body.logDir))
      errors.push("logDir (logSource.path) must be an absolute POSIX path");

    const known = skipNodeCheck ? null : this.getKnownNodeIds() || [];
    const feasibility = validateRecipeFeasibility(recipe, {
      knownNodeIds: skipNodeCheck ? null : known,
      modelRegistry: skipNodeCheck ? null : this.modelRegistry,
      recipeRegistry: this,
      deploymentRegistry: skipNodeCheck ? null : this.deploymentRegistry,
    });
    errors.push(...feasibility.errors);

    if (errors.length === 0) {
      // Fold resume note-less seeding: keep state as-is.
    }
    if (errors.length > 0) {
      const err = new Error(errors.join("; "));
      err.status = 400;
      throw err;
    }
    if (!prev && this._recipes.size >= MAX_RECIPES) {
      const err = new Error(`Recipe registry is full (${MAX_RECIPES})`);
      err.status = 409;
      throw err;
    }
    if (recipe.lifecycleState === "archived" && !prev) recipe.archived = true;
    this._assertNoPortConflict(recipe);
    this._recipes.set(recipe.id, recipe);
    this._persistSecrets(recipe);
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
    recipe.lifecycleState = "archived";
    recipe.updatedAt = Date.now();
    this._recipes.set(id, recipe);
    this._save();
    return { archived: true, id };
  }

  restore(id) {
    const recipe = this._recipes.get(id);
    if (!recipe) return null;
    recipe.archived = false;
    if (recipe.lifecycleState === "archived") recipe.lifecycleState = "deprecated";
    recipe.updatedAt = Date.now();
    this._recipes.set(id, recipe);
    this._save();
    return recipe;
  }

  /**
   * Deep-copy duplicate as a new draft.
   * @throws {Error & {status:number}}
   */
  duplicate(sourceId, newId, overrides = {}) {
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
    const body = JSON.parse(JSON.stringify(src));
    Object.assign(body, overrides, { id: newId });
    // Overrides may use legacy flat keys; map them onto the structured blocks.
    if (overrides.apiPort != null) body.endpoint = { ...body.endpoint, port: overrides.apiPort };
    if (overrides.nodeIds) body.nodeIds = [...overrides.nodeIds];
    if (overrides.modelPath && body.modelRef) body.weightId = overrides.weightId || body.modelRef.weightId;
    if (!overrides.name) body.name = `${src.name} (copy)`;
    body.lifecycleState = "draft";
    body.provenance = { sourceRecipeId: src.id };
    body.createdAt = null;
    body.updatedAt = null;
    // Re-point secret refs at the new id so they resolve independently. Values
    // are NOT copied → flag the copy as missing secrets until they are re-entered.
    body.launch.env = (body.launch.env || []).map((e) =>
      e.secretRef ? { ...e, secretRef: `recipe:${newId}:${e.name}`, value: null } : { ...e }
    );
    if (body.launch.env.some((e) => e.secretRef)) {
      body.metadata = { ...(body.metadata || {}), secretsMissing: true };
    }
    body.archived = false;
    return this.upsert(body);
  }

  /** Backward-compatible alias for the old clone endpoint. */
  clone(sourceId, newId, overrides = {}) {
    return this.duplicate(sourceId, newId, overrides);
  }

  /**
   * Feasibility validation for an existing (or hypothetical) recipe.
   * NEVER executes commands — pure dry-run.
   */
  validate(id, ctx = {}) {
    const recipe = typeof id === "object" ? id : this._recipes.get(id);
    if (!recipe) return null;
    return validateRecipeFeasibility(recipe, {
      knownNodeIds: ctx.knownNodeIds ?? (this.getKnownNodeIds() || []),
      modelRegistry: this.modelRegistry,
      recipeRegistry: this,
      deploymentRegistry: this.deploymentRegistry,
      nodeIds: ctx.nodeIds,
    });
  }

  /**
   * Apply a legal lifecycle transition. `validated` requires a passing validate.
   * @throws {Error & {status:number}}
   */
  transition(id, to, opts = {}) {
    const recipe = this._recipes.get(id);
    if (!recipe) {
      const err = new Error("recipe not found");
      err.status = 404;
      throw err;
    }
    if (to === "validated") {
      const check = this.validate(id);
      if (!check?.ok) {
        const err = new Error(`cannot validate: ${check.errors.join("; ")}`);
        err.status = 400;
        throw err;
      }
      // A duplicated recipe re-points secretRefs without copying values — a
      // re-entered value is required before it may be marked validated.
      if (recipe.metadata?.secretsMissing) {
        const missing = (recipe.launch?.env || []).filter((e) => e.secretRef && !e.value);
        if (missing.length) {
          const err = new Error(
            `secret values missing after duplicate — re-enter: ${missing.map((e) => e.name).join(", ")}`
          );
          err.status = 409;
          throw err;
        }
        delete recipe.metadata.secretsMissing;
      }
    }
    applyTransition(recipe, to, opts);
    this._recipes.set(id, recipe);
    this._save();
    return recipe;
  }
}

export const recipeRegistry = new RecipeRegistry();
