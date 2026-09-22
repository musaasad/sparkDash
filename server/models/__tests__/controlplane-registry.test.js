import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Never write the live config/*.json (or live secrets) during tests.
const SD_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sd-cp-"));
process.env.SPARKDASH_CONFIG_DIR = SD_ROOT;
process.env.SPARKS_SECRETS_PATH = path.join(SD_ROOT, "secrets.json");
process.env.SECRETS_KEY_PATH = path.join(SD_ROOT, ".secrets-key");

const { ModelRegistry } = await import("../ModelRegistry.js");
const { RecipeRegistry } = await import("../../recipes/RecipeRegistry.js");

function tmp(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sd-${name}-`));
  return path.join(dir, "store.json");
}

const VALID_RECIPE = {
  id: "qwen38-tabbyapi-dgx3",
  modelId: "qwen38",
  name: "TabbyAPI EXL3 (dgx-3)",
  runtime: "tabbyapi-exl3",
  topology: "single",
  nodeIds: ["dgx-3"],
  modelPath: "/home/musaasad/models/Qwen3.8-Flash-Next-EXL3",
  workdir: "/home/musaasad/tabbyAPI",
  logDir: "/home/musaasad/tabbyAPI/logs",
  apiPort: 8889,
  healthPath: "/v1/models",
  contextLength: 262144,
  cpuAffinity: "5-9,15-19",
  launcher: "taskset -c 5-9,15-19 python main.py",
  env: [
    { name: "EXL3_INT8_GEMV", value: "0" },
    { name: "EXL3_MOE_COOP_WIDE", value: "1" },
    { name: "API_TOKEN", value: "super-secret", secret: true },
  ],
};

test("model registry upsert + archive preserves (never deletes) + restore", () => {
  const reg = new ModelRegistry({ path: tmp("models") });
  const m = reg.upsert({ id: "qwen38", name: "Qwen 3.8 Flash Next", family: "Qwen" });
  assert.equal(m.name, "Qwen 3.8 Flash Next");
  const arch = reg.remove("qwen38");
  assert.equal(arch.archived, true);
  assert.equal(reg.get("qwen38").archived, true); // still present — weights safe
  assert.equal(reg.listActive().length, 0);
  reg.restore("qwen38");
  assert.equal(reg.get("qwen38").archived, false);
});

test("model hard-delete blocked while recipes reference it", () => {
  const mpath = tmp("models2");
  const rpath = tmp("recipes2");
  const models = new ModelRegistry({ path: mpath });
  const recipes = new RecipeRegistry({ path: rpath, getKnownNodeIds: () => ["dgx-3"] });
  models.upsert({ id: "qwen38", name: "Qwen" });
  recipes.upsert(VALID_RECIPE);
  assert.throws(
    () => models.remove("qwen38", { archive: false, hasRecipes: recipes.hasRecipesForModel("qwen38") }),
    /archive it instead/
  );
});

test("recipe validation rejects injection, bad topology, unknown node", () => {
  const recipes = new RecipeRegistry({ path: tmp("recipes3"), getKnownNodeIds: () => ["dgx-3"] });
  assert.throws(() => recipes.upsert({ ...VALID_RECIPE, modelPath: "/x/$(whoami)" }), /modelPath/);
  assert.throws(() => recipes.upsert({ ...VALID_RECIPE, topology: "tp2" }), /requires exactly 2/);
  assert.throws(() => recipes.upsert({ ...VALID_RECIPE, nodeIds: ["nope"] }), /unknown node/);
  assert.throws(() => recipes.upsert({ ...VALID_RECIPE, apiPort: 99999 }), /apiPort/);
  assert.throws(() => recipes.upsert({ ...VALID_RECIPE, cpuAffinity: "5-9; rm -rf /" }), /cpuAffinity/);
  assert.throws(() => recipes.upsert({ ...VALID_RECIPE, launcher: "python x.py `id`" }), /forbidden shell/);
});

test("recipe port conflict on same node is rejected 409", () => {
  const recipes = new RecipeRegistry({ path: tmp("recipes4"), getKnownNodeIds: () => ["dgx-3"] });
  recipes.upsert(VALID_RECIPE);
  assert.throws(
    () => recipes.upsert({ ...VALID_RECIPE, id: "other", name: "Other", apiPort: 8889 }),
    /already used by recipe/
  );
});

test("toPublic strips secret env values; edit round-trip preserves them", () => {
  const recipes = new RecipeRegistry({ path: tmp("recipes5"), getKnownNodeIds: () => ["dgx-3"] });
  recipes.upsert(VALID_RECIPE);
  const pub = recipes.toPublic(recipes.get(VALID_RECIPE.id));
  const secret = pub.env.find((e) => e.name === "API_TOKEN");
  assert.equal(secret.secret, true);
  assert.equal(secret.value, undefined); // never crosses the boundary
  assert.equal(secret.hasValue, true);
  assert.ok(!JSON.stringify(pub).includes("super-secret"));

  // Client echoes back the redacted env (no value) — stored secret survives.
  const edited = recipes.upsert({ ...pub, name: "Renamed" });
  assert.equal(recipes.get(edited.id).env.find((e) => e.name === "API_TOKEN").value, "super-secret");
});

test("clone copies without exposing secret; new id required", () => {
  const recipes = new RecipeRegistry({ path: tmp("recipes6"), getKnownNodeIds: () => ["dgx-3"] });
  recipes.upsert(VALID_RECIPE);
  const clone = recipes.clone(VALID_RECIPE.id, "qwen38-copy", { apiPort: 8890 });
  assert.equal(clone.id, "qwen38-copy");
  // Duplicate re-points secretRefs but does NOT copy values → distinct missing state.
  assert.equal(recipes.get("qwen38-copy").env.find((e) => e.name === "API_TOKEN").value, null);
  assert.equal(recipes.get("qwen38-copy").metadata.secretsMissing, true);
  assert.throws(() => recipes.clone(VALID_RECIPE.id, "bad id"), /lowercase slug/);
});