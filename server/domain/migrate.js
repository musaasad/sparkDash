/**
 * One-time v1 → v2 registry migration.
 *
 * v1 had models.json {models[]} without schemaVersion and recipes.json
 * {recipes[]} with nodeIds + modelPath + secret env values. v2 separates the
 * concepts: weight identity moves to the MODEL, node binding moves to a seed
 * DEPLOYMENT, secret values move to the encrypted secrets store, and the
 * remaining recipe fields become structured blocks.
 *
 * Contract:
 *  - detects v1 by a missing schemaVersion
 *  - writes a one-time `<file>.v1.bak` before rewriting
 *  - idempotent (v2 files are left byte-identical on a second run)
 */
import fs from "fs";
import { atomicWrite } from "../util/atomicWrite.js";
import { normalizeModel, normalizeRecipe, normalizeDeployment } from "./schema.js";
import { saveRecipeEnv, loadRecipeEnv } from "../secretsStore.js";

const SCHEMA_VERSION = 2;

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`[migrate] unreadable ${file}: ${err.message}`);
    return null;
  }
}

function writeJson(file, obj) {
  atomicWrite(file, JSON.stringify(obj, null, 2) + "\n", 0o600);
}

function backup(file) {
  const bak = `${file}.v1.bak`;
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
  return bak;
}

/**
 * Migrate one models file in place. Returns the persisted v2 document.
 * @returns {{migrated: boolean, doc: object}}
 */
export function migrateModelsFile(file) {
  const raw = readJson(file);
  if (!raw || raw.schemaVersion === SCHEMA_VERSION) {
    return { migrated: false, doc: raw };
  }
  backup(file);
  const doc = {
    schemaVersion: SCHEMA_VERSION,
    models: (Array.isArray(raw.models) ? raw.models : []).map((m) => normalizeModel(m)),
  };
  writeJson(file, doc);
  return { migrated: true, doc };
}

/**
 * Migrate one recipes file in place. Returns v2 recipes plus any deployment
 * bindings derived from the removed `nodeIds` (the caller persists those).
 * @returns {{migrated: boolean, doc: object, deployments: object[]}}
 */
export function migrateRecipesFile(file) {
  const raw = readJson(file);
  if (!raw || raw.schemaVersion === SCHEMA_VERSION) {
    return { migrated: false, doc: raw, deployments: [] };
  }
  backup(file);
  const recipes = [];
  const deployments = [];
  const secretMap = loadRecipeEnv();
  for (const r of Array.isArray(raw.recipes) ? raw.recipes : []) {
    const recipe = normalizeRecipe(r);
    // v1 modelPath -> model weightPaths.default is handled by migrateAll (needs models file).
    for (const e of recipe.launch.env) {
      if (e.value != null && e.value !== "") secretMap.set(e.secretRef, e.value);
    }
    recipes.push(recipe);
    const nodeIds = Array.isArray(r.nodeIds) ? r.nodeIds : [];
    if (nodeIds.length > 0) {
      deployments.push(
        normalizeDeployment({
          id: `dep-${recipe.id}`,
          modelId: recipe.modelRef?.modelId,
          recipeId: recipe.id,
          nodeIds,
          desiredState: r.metadata?.desired === "running" ? "running" : "unknown",
          metadata: { managedBy: r.metadata?.managedBy || "external" },
          createdAt: r.createdAt ?? Date.now(),
          updatedAt: r.updatedAt ?? Date.now(),
        })
      );
      // Recipe keeps its nodeIds hint too so existing joins stay stable.
    }
  }
  saveRecipeEnv(secretMap);
  // Secret values leave the recipe file — secretRef by name only.
  const strip = (r) => {
    const env = (r.launch?.env || []).map((e) => (e.secretRef ? { name: e.name, secretRef: e.secretRef } : e));
    return { ...r, env, launch: { ...r.launch, env } };
  };
  const doc = { schemaVersion: SCHEMA_VERSION, recipes: recipes.map(strip) };
  writeJson(file, doc);
  return { migrated: true, doc, deployments };
}

/**
 * Run the full migration across the registry files + seed deployments.
 * @param {{modelsPath: string, recipesPath: string, deploymentsPath: string}} paths
 * @returns {{migrated: boolean}}
 */
export function runMigrations(paths) {
  const models = migrateModelsFile(paths.modelsPath);
  const recipes = migrateRecipesFile(paths.recipesPath);
  if (!models.migrated && !recipes.migrated) return { migrated: false };

  // v1 recipe.modelPath -> the owning model's weightPaths.default. The recipe
  // backup still carries the raw modelPath after the in-place rewrite.
  const bak = readJson(`${paths.recipesPath}.v1.bak`);
  const rawModels = readJson(paths.modelsPath)?.models || [];
  const modelById = new Map(rawModels.map((m) => [m.id, m]));
  let modelsTouched = false;
  for (const r of Array.isArray(bak?.recipes) ? bak.recipes : []) {
    const m = modelById.get(r.modelId);
    if (m && r.modelPath) {
      m.weightPaths = m.weightPaths || {};
      m.weightPaths.default = r.modelPath;
      m.updatedAt = Date.now();
      modelsTouched = true;
    }
  }
  if (modelsTouched) writeJson(paths.modelsPath, { schemaVersion: SCHEMA_VERSION, models: rawModels });

  // Merge derived deployments with any existing ones.
  if (recipes.deployments.length > 0) {
    const existing = readJson(paths.deploymentsPath)?.deployments || [];
    const byId = new Map(existing.map((d) => [d.id, d]));
    for (const d of recipes.deployments) if (!byId.has(d.id)) byId.set(d.id, d);
    writeJson(paths.deploymentsPath, { schemaVersion: SCHEMA_VERSION, deployments: [...byId.values()] });
  }
  return { migrated: true };
}

export { SCHEMA_VERSION };
