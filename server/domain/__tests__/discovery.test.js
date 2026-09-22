import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Never touch live config.
const SD_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sd-disc-"));
process.env.SPARKDASH_CONFIG_DIR = SD_ROOT;
process.env.SPARKS_SECRETS_PATH = path.join(SD_ROOT, "secrets.json");
process.env.SECRETS_KEY_PATH = path.join(SD_ROOT, ".secrets-key");

const { DiscoveryService } = await import("../discovery.js");
const { ModelRegistry } = await import("../../models/ModelRegistry.js");
const { RecipeRegistry } = await import("../../recipes/RecipeRegistry.js");
const { DeploymentRegistry } = await import("../deploymentRegistry.js");

const tmp = (n) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), `sd-d-${n}-`)), "store.json");

/** Unique store dir per harness so tests never share discovered.json. */
const freshDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "sd-d-state-"));

/** Harness with one online node exposing two ports; only `serving` answers. */
function harness({ serving = [8888], sshUp = true } = {}) {
  const sparks = {
    sparkIds: ["n1"],
    getSpark: (id) =>
      id === "n1"
        ? { id: "n1", name: "Node One", lanIp: "10.0.0.9", isLocal: false, llmPorts: [8888, 9999] }
        : null,
  };
  const models = new ModelRegistry({ path: tmp("models") });
  const recipes = new RecipeRegistry({ path: tmp("recipes"), getKnownNodeIds: () => sparks.sparkIds });
  recipes.modelRegistry = models;
  const deployments = new DeploymentRegistry({ path: tmp("deps") });

  const calls = [];
  const fetchImpl = async (url) => {
    calls.push({ url, method: "GET" });
    const port = Number(new URL(url).port);
    if (!serving.includes(port)) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "qwen-3.8-flash", owned_by: "vllm" }] }),
    };
  };
  const sshCalls = [];
  const sshExecFn = async (_spark, cmd) => {
    sshCalls.push(cmd);
    return sshUp ? "up\n" : "down\n";
  };

  const disc = new DiscoveryService({
    sparkRegistry: sparks,
    recipeRegistry: recipes,
    deploymentRegistry: deployments,
    modelRegistry: models,
    fetchImpl,
    sshExecFn,
    path: path.join(freshDir(), "discovered.json"),
    ttlMs: 0,
  });
  return { disc, sparks, models, recipes, deployments, calls, sshCalls };
}

/** Flush the fire-and-forget scan promises. */
const settle = () => new Promise((r) => setTimeout(r, 20));

test("scan finds uncovered serving endpoints with read-only evidence", async () => {
  const h = harness();
  await h.disc.scan();
  await settle();

  const list = h.disc.list();
  assert.equal(list.length, 1);
  const rec = list[0];
  assert.equal(rec.nodeId, "n1");
  assert.equal(rec.port, 8888);
  assert.equal(rec.runtime, "vllm");
  assert.equal(rec.health, "running");
  assert.equal(rec.processEvidence, true);
  assert.equal(rec.alreadyAdopted, false);
  assert.deepEqual(rec.servedModelIds, ["qwen-3.8-flash"]);

  // READ-ONLY: every HTTP call is a bare GET; ssh is pgrep only.
  assert.ok(h.calls.every((c) => c.method === "GET"));
  assert.ok(h.sshCalls.every((c) => /pgrep/.test(c)));
});

test("a covered endpoint is not 'new' and correlates to its deployment", async () => {
  const h = harness();
  h.models.upsert({ id: "qwen", name: "Qwen", weightPaths: { default: "/m/qwen" } });
  const r = h.recipes.upsert({
    id: "r-qwen", modelId: "qwen", name: "R", runtime: "vllm", topology: "single",
    nodeIds: ["n1"], modelPath: "/m/qwen", workdir: "/w", apiPort: 8888,
    metadata: { servedModelId: "qwen-3.8-flash" },
  });
  const dep = h.deployments.create({ modelId: "qwen", recipeId: r.id, nodeIds: ["n1"], desiredState: "unknown" });
  dep.servedModelId = "qwen-3.8-flash";

  await h.disc.scan();
  await settle();

  const list = h.disc.list();
  const rec = list.find((x) => x.port === 8888);
  assert.equal(rec.alreadyAdopted, true);
  assert.equal(rec.matchedModelId, "qwen");
  assert.equal(rec.matchedRecipeId, r.id);
  assert.equal(h.disc.list({ includeAdopted: false }).length, 0);
});

test("offline endpoint degrades gracefully — no fabricated entry", async () => {
  const h = harness({ serving: [9999] });
  await h.disc.scan();
  await settle();
  const list = h.disc.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].port, 9999); // only the answering port
  assert.ok(!list.some((r) => r.port === 8888));
});

test("adopt mode=create writes config only, desiredState unknown, process untouched", async () => {
  const h = harness();
  await h.disc.scan();
  await settle();
  const rec = h.disc.list()[0];

  const beforeFetch = h.calls.length;
  const result = h.disc.adopt(rec.id, { mode: "create", modelName: "Qwen 3.8 Flash" });

  assert.equal(result.dryRun, true);
  assert.equal(result.deployment.desiredState, "unknown");
  assert.equal(result.deployment.metadata.managedBy, "external");
  assert.deepEqual(result.deployment.nodeIds, ["n1"]);
  assert.equal(result.recipe.engine.runtime, "vllm");
  assert.equal(result.recipe.endpoint.port, 8888);
  assert.equal(result.recipe.launch.mechanism, "external");
  assert.equal(result.provenance.discoveryId, rec.id);
  assert.equal(h.models.get(result.model.id).name, "Qwen 3.8 Flash");
  assert.equal(h.recipes.get(result.recipe.id).id, result.recipe.id);

  // Adoption issues no network of its own; no start/stop/signal.
  assert.equal(h.calls.length, beforeFetch);
  const adopted = h.disc.list().find((x) => x.id === rec.id);
  assert.equal(adopted.alreadyAdopted, true);
});

test("adopt mode=associate binds a deployment to the matched recipe", async () => {
  const h = harness();
  await h.disc.scan();
  await settle();
  const rec = h.disc.list()[0];

  h.models.upsert({ id: "m1", name: "M1", weightPaths: { default: "/m1" } });
  h.recipes.upsert({
    id: "r1", modelId: "m1", name: "R1", runtime: "vllm", topology: "single",
    nodeIds: ["n1"], modelPath: "/m1", workdir: "/w", apiPort: 8890,
  });

  const result = h.disc.adopt(rec.id, { mode: "associate", modelId: "m1", recipeId: "r1" });
  assert.equal(result.mode, "associate");
  assert.equal(result.deployment.modelId, "m1");
  assert.equal(result.deployment.recipeId, "r1");
  assert.deepEqual(result.deployment.nodeIds, ["n1"]);
});

test("adopt rejects unknown discovery id and mismatched recipe", async () => {
  const h = harness();
  await h.disc.scan();
  await settle();
  const rec = h.disc.list()[0];
  assert.throws(() => h.disc.adopt("nope", { mode: "create", modelName: "x" }), /not found/);

  h.models.upsert({ id: "m1", name: "M1", weightPaths: { default: "/m1" } });
  h.models.upsert({ id: "m2", name: "M2", weightPaths: { default: "/m2" } });
  h.recipes.upsert({
    id: "r1", modelId: "m1", name: "R1", runtime: "vllm", topology: "single",
    nodeIds: ["n1"], modelPath: "/m1", workdir: "/w", apiPort: 8888,
  });
  assert.throws(() => h.disc.adopt(rec.id, { mode: "associate", modelId: "m2", recipeId: "r1" }), /does not reference/);
});
