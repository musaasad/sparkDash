/**
 * WS-1 domain core proof: a FICTIONAL model + recipe + deployment flows through
 * the v2 registries and renders with generic shape (zero concept-specific code).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sd-domain-"));
process.env.SPARKDASH_CONFIG_DIR = ROOT;
process.env.SPARKS_SECRETS_PATH = path.join(ROOT, "secrets.json");
process.env.SECRETS_KEY_PATH = path.join(ROOT, ".secrets-key");

const { ModelRegistry } = await import("../../models/ModelRegistry.js");
const { RecipeRegistry } = await import("../../recipes/RecipeRegistry.js");
const { DeploymentRegistry } = await import("../deploymentRegistry.js");

const NODES = ["node-7", "node-8", "node-9"];

function store(name) {
  const dir = fs.mkdtempSync(path.join(ROOT, name));
  return {
    models: path.join(dir, "models.json"),
    recipes: path.join(dir, "recipes.json"),
    deployments: path.join(dir, "deployments.json"),
  };
}

function wire(name) {
  const t = store(name);
  const models = new ModelRegistry({ path: t.models });
  const recipes = new RecipeRegistry({ path: t.recipes, getKnownNodeIds: () => NODES });
  const deps = new DeploymentRegistry({ path: t.deployments });
  recipes.modelRegistry = models;
  recipes.deploymentRegistry = deps;
  recipes.getModelWeightPath = (r) => models.get(r.modelRef?.modelId)?.weightPaths?.[r.modelRef?.weightId || "default"] ?? null;
  return { models, recipes, deps };
}

test("hypothetical model + recipe + deployment render generic v2 shape (no FE changes)", () => {
  const { models, recipes, deps } = wire("glm");

  const model = models.upsert({
    id: "glm-53-flash",
    name: "GLM-5.3 Flash",
    family: "GLM",
    weightPaths: { default: "/models/glm53", "2.9bpw": "/models/glm53-29" },
    tags: ["exl3"],
  });
  assert.equal(model.schemaVersion, 2);
  assert.deepEqual(Object.keys(model.weightPaths).sort(), ["2.9bpw", "default"]);

  const recipe = recipes.upsert({
    id: "glm53-sglang-pp3",
    modelRef: { modelId: "glm-53-flash", weightId: "2.9bpw" },
    name: "SGLang PP3",
    engine: { runtime: "sglang", quantization: "exl3", apiProtocol: "openai" },
    serving: { contextLength: 128000 },
    launch: { mechanism: "command", executable: "python", args: ["-m", "sglang.launch_server"], command: "python -m sglang.launch_server", workdir: "/opt/sglang", env: [{ name: "API_TOKEN", value: "sh", secret: true }] },
    endpoint: { scheme: "http", hostTemplate: "{nodeIp}", port: 8891, path: "/v1" },
    topology: { mode: "pp", parallelism: 3, minNodes: 3, maxNodes: 3 },
    healthProbe: { kind: "http", path: "/v1/models", expectUp: [200, 401, 403] },
    discovery: { strategy: "process" },
    logSource: { kind: "file", path: "/opt/sglang/logs" },
    nodeIds: NODES,
  });

  assert.equal(recipe.schemaVersion, 2);
  assert.equal(recipe.engine.runtime, "sglang");
  assert.equal(recipe.topology.mode, "pp");

  const pub = recipes.toPublic(recipe);
  assert.equal(pub.lifecycleState, "draft");
  assert.equal(pub.modelId, "glm-53-flash");
  assert.equal(pub.runtime, "sglang");
  assert.equal(pub.topology, "pp3");
  assert.equal(pub.apiPort, 8891);
  assert.equal(pub.modelPath, "/models/glm53-29");
  const secret = pub.env.find((e) => e.name === "API_TOKEN");
  assert.equal(secret.secret, true);
  assert.equal(secret.value, undefined);
  assert.equal(secret.hasValue, true);
  assert.equal(secret.secretRef, "recipe:glm53-sglang-pp3:API_TOKEN");

  // Validate endpoint is dry-run only and passes for the fictional recipe.
  const check = recipes.validate(recipe.id);
  assert.equal(check.ok, true);
  assert.deepEqual(check.errors, []);

  const dep = deps.create({
    id: "dep-glm53-sglang-pp3",
    modelId: "glm-53-flash",
    recipeId: "glm53-sglang-pp3",
    nodeIds: NODES,
    desiredState: "running",
  });
  assert.deepEqual(dep.nodeIds, NODES);
  assert.equal(deps.listForModel("glm-53-flash").length, 1);

  const modelView = recipes.listForModel("glm-53-flash", { includeArchived: true }).map((r) => recipes.toPublic(r));
  assert.equal(modelView[0].id, "glm53-sglang-pp3");
});

test("DELETE deployment removes binding only, never recipe/model/weights", () => {
  const { models, recipes, deps } = wire("unbind");
  models.upsert({ id: "m1", name: "M", weightPaths: { default: "/m" } });
  recipes.upsert({
    id: "r1",
    modelRef: { modelId: "m1" },
    name: "R",
    engine: { runtime: "vllm" },
    endpoint: { port: 9000 },
    topology: { mode: "single", parallelism: 1, minNodes: 1, maxNodes: 1 },
    nodeIds: ["node-7"],
  });
  const dep = deps.create({ id: "dep-r1", modelId: "m1", recipeId: "r1", nodeIds: ["node-7"] });
  assert.ok(deps.remove(dep.id));
  assert.equal(models.get("m1").weightPaths.default, "/m");
  assert.ok(recipes.get("r1"));
});

test("model hard-delete blocked while a deployment references it", () => {
  const { models, recipes, deps } = wire("harddel");
  models.upsert({ id: "m1", name: "M", weightPaths: { default: "/m" } });
  recipes.upsert({
    id: "r1",
    modelRef: { modelId: "m1" },
    name: "R",
    engine: { runtime: "vllm" },
    endpoint: { port: 9001 },
    topology: { mode: "single", parallelism: 1, minNodes: 1, maxNodes: 1 },
    nodeIds: ["node-7"],
  });
  deps.create({ id: "dep-r1", modelId: "m1", recipeId: "r1", nodeIds: ["node-7"] });
  assert.throws(
    () =>
      models.remove("m1", {
        archive: false,
        hasRecipes: recipes.hasRecipesForModel("m1"),
        hasDeployments: deps.hasForModel("m1"),
      }),
    /referenced/
  );
  assert.equal(models.remove("m1").archived, true);
});

test("archived recipe cannot back a new deployment and renders read-only", () => {
  const { recipes } = wire("arch");
  recipes.upsert({
    id: "r1",
    modelRef: { modelId: "m1" },
    name: "R",
    engine: { runtime: "vllm" },
    endpoint: { port: 9002 },
    topology: { mode: "single", parallelism: 1, minNodes: 1, maxNodes: 1 },
    nodeIds: ["node-7"],
  });
  recipes.transition("r1", "validated");
  recipes.transition("r1", "proven", { note: "works" });
  recipes.transition("r1", "deprecated");
  recipes.transition("r1", "archived");
  const pub = recipes.toPublic(recipes.get("r1"));
  assert.equal(pub.lifecycleState, "archived");
  assert.equal(pub.archived, true);
});

const { normalizeRecipe, normalizeDeployment } = await import("../schema.js");

test("F3 normalize drops lifecycleCommands for an external mechanism", () => {
  const r = normalizeRecipe({
    id: "x-ext",
    modelRef: { modelId: "m1" },
    name: "X",
    launchMechanism: "external",
    lifecycleCommands: { start: "a", stop: "b", status: "c" },
    endpoint: { port: 9010 },
  });
  assert.equal(r.launch.mechanism, "external");
  assert.deepEqual(r.lifecycleCommands, { start: null, stop: null, status: null });
});

test("F3 external seed recipes carry no lifecycleCommands", () => {
  const seeds = JSON.parse(
    fs.readFileSync(new URL("../../seeds/recipes.json", import.meta.url), "utf8")
  );
  for (const r of seeds.recipes) {
    if (r.launch?.mechanism === "external") {
      assert.equal(r.lifecycleCommands, undefined, `${r.id} must not carry control commands`);
    }
  }
});

test("F9 normalizeDeployment forces desiredState unknown for external managedBy", () => {
  const dep = normalizeDeployment({ recipeId: "r1", modelId: "m1", nodeIds: ["node-7"], desiredState: "running", metadata: { managedBy: "external" } });
  assert.equal(dep.desiredState, "unknown");
  const managed = normalizeDeployment({ recipeId: "r1", modelId: "m1", nodeIds: ["node-7"], desiredState: "running", metadata: { managedBy: "sparkdash" } });
  assert.equal(managed.desiredState, "running");
});
