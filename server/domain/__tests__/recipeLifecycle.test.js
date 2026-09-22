import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sd-life-"));
process.env.SPARKDASH_CONFIG_DIR = ROOT;
process.env.SPARKS_SECRETS_PATH = path.join(ROOT, "secrets.json");
process.env.SECRETS_KEY_PATH = path.join(ROOT, ".secrets-key");

const { ModelRegistry } = await import("../../models/ModelRegistry.js");
const { RecipeRegistry } = await import("../../recipes/RecipeRegistry.js");
const { DeploymentRegistry } = await import("../deploymentRegistry.js");

function wire(name) {
  const dir = fs.mkdtempSync(path.join(ROOT, name));
  const models = new ModelRegistry({ path: path.join(dir, "models.json") });
  const recipes = new RecipeRegistry({ path: path.join(dir, "recipes.json"), getKnownNodeIds: () => ["node-7"] });
  const deps = new DeploymentRegistry({ path: path.join(dir, "deployments.json") });
  recipes.modelRegistry = models;
  recipes.deploymentRegistry = deps;
  models.upsert({ id: "m1", name: "M", weightPaths: { default: "/m" } });
  recipes.upsert({
    id: "r1",
    modelRef: { modelId: "m1" },
    name: "R",
    engine: { runtime: "sglang" },
    endpoint: { port: 9100 },
    topology: { mode: "single", parallelism: 1, minNodes: 1, maxNodes: 1 },
    healthProbe: { kind: "http", path: "/v1/models", expectUp: [200] },
    discovery: { strategy: "process" },
    logSource: { kind: "file", path: "/logs" },
    nodeIds: ["node-7"],
  });
  return { models, recipes, deps };
}

test("legal transitions: draft→validated→proven→deprecated→archived", () => {
  const { recipes } = wire("legal");
  assert.equal(recipes.get("r1").lifecycleState, "draft");
  assert.equal(recipes.transition("r1", "validated").lifecycleState, "validated");
  assert.throws(() => recipes.transition("r1", "proven"), /requires an operator note/);
  const proven = recipes.transition("r1", "proven", { note: "verified on node-7" });
  assert.equal(proven.lifecycleState, "proven");
  assert.equal(proven.provenance.note, "verified on node-7");
  assert.equal(recipes.transition("r1", "deprecated").lifecycleState, "deprecated");
  assert.equal(recipes.transition("r1", "archived").lifecycleState, "archived");
});

test("illegal transitions are 409 with a reason", () => {
  const { recipes } = wire("illegal");
  const cases = [
    ["draft", "proven"],
    ["draft", "archived"],
    ["draft", "proven"],
  ];
  assert.equal(recipes.get("r1").lifecycleState, "draft");
  for (const [, to] of cases) {
    assert.throws(
      () => recipes.transition("r1", to),
      (e) => e.status === 409 && /cannot go|only a deprecated/.test(e.message)
    );
  }
  // validated cannot jump straight to archived either
  recipes.transition("r1", "validated");
  assert.throws(
    () => recipes.transition("r1", "archived"),
    (e) => e.status === 409 && /only a deprecated/.test(e.message)
  );
  // archived is read-only
  recipes.transition("r1", "proven", { note: "n" });
  recipes.transition("r1", "deprecated");
  recipes.transition("r1", "archived");
  try {
    recipes.transition("r1", "draft");
    assert.fail("expected read-only rejection");
  } catch (e) {
    assert.equal(e.status, 409);
    assert.match(e.message, /read-only/);
  }
});

test("validated requires a passing validate", () => {
  const { recipes, models } = wire("validreq");
  models.remove("m1"); // archived model → validate fails
  try {
    recipes.transition("r1", "validated");
    assert.fail("expected a validation failure");
  } catch (e) {
    assert.equal(e.status, 400);
    assert.match(e.message, /archived/);
  }
  assert.equal(recipes.get("r1").lifecycleState, "draft");
});

test("duplicate: proven recipe → draft copy; original untouched", () => {
  const { recipes } = wire("dup");
  recipes.transition("r1", "validated");
  recipes.transition("r1", "proven", { note: "keep" });

  const copy = recipes.duplicate("r1", "r1-copy", { apiPort: 9101 });
  assert.equal(copy.lifecycleState, "draft");
  assert.equal(copy.archived, false);
  assert.equal(copy.provenance.sourceRecipeId, "r1");
  assert.equal(copy.provenance.provenAt, undefined);
  assert.equal(copy.name, "R (copy)");

  const original = recipes.get("r1");
  assert.equal(original.lifecycleState, "proven");
  assert.equal(original.provenance.note, "keep");
  assert.equal(original.provenance.sourceRecipeId, undefined);
  assert.equal(original.name, "R");

  assert.throws(() => recipes.duplicate("r1", "r1-copy"), /already exists/);
  assert.throws(() => recipes.duplicate("r1", "bad id"), /lowercase slug/);
});
