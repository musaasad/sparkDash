/**
 * ACCEPTANCE SUITE (server) — proves the control plane is DATA-DRIVEN and
 * CONFIG-ONLY: a hypothetical model/recipe/compute enters through the config
 * API with zero schema/code edits and zero remote action.
 *
 * Hermetic: temp SPARKDASH_CONFIG_DIR, ephemeral loopback listener, mocked
 * fetch — no live nodes, no real ssh, no secrets.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sd-accept-"));
process.env.SPARKDASH_CONFIG_DIR = ROOT;
process.env.SPARKS_SECRETS_PATH = path.join(ROOT, "secrets.json");
process.env.SECRETS_KEY_PATH = path.join(ROOT, ".secrets-key");

const express = (await import("express")).default;
const { createControlPlane } = await import("../../controlPlane.js");
const { validateTopology } = await import("../topologyValidate.js");
const registry = await import("../providers/registry.js");

/** Fake SparkRegistry — local writes only, never a remote call. */
function makeRegistry(ids) {
  const nodes = new Map();
  for (const id of ids) nodes.set(id, { id, name: id, online: true, llmPorts: [8000], ssh: { user: "spark" } });
  return {
    get sparks() { return [...nodes.values()]; },
    get sparkIds() { return [...nodes.keys()]; },
    getSpark: (id) => nodes.get(id) ?? null,
    addSpark: (c) => { nodes.set(c.id, c); return c; },
  };
}

const fetchCalls = [];
const mockFetch = async (url) => {
  fetchCalls.push(String(url));
  return { status: 200, ok: true, json: async () => ({ data: [] }), text: async () => "" };
};

/** Boot the real control plane on an ephemeral port. */
async function boot() {
  const app = express();
  app.use(express.json());
  const sparkRegistry = makeRegistry(["dgx-1", "dgx-2", "dgx-3"]);
  createControlPlane({
    app,
    sparkRegistry,
    monitors: [],
    decodeBenchManager: {},
    prefillBenchManager: {},
    showcaseManager: {},
    broadcastLifecycle() {},
    fetchImpl: mockFetch,
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, sparkRegistry, close: () => new Promise((r) => server.close(r)) };
}

async function call(base, method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/* ─── 85 · CONFIG-ONLY ADD MODEL (no source change, starts no process) ─── */
test("85 a hypothetical model+recipe+deployment is created via the config API alone", async (t) => {
  const { base, close } = await boot();
  t.after(close);

  const m = await call(base, "POST", "/api/models", { id: "hyp-model", name: "Hypothetical GLM", weightPaths: { default: "/models/hyp" } });
  assert.equal(m.status, 200);
  assert.equal(m.json.model.id, "hyp-model");
  assert.equal(m.json.model.schemaVersion, 2);
  assert.equal(m.json.model.name, "Hypothetical GLM");

  const r = await call(base, "POST", "/api/recipes", {
    id: "hyp-recipe",
    modelRef: { modelId: "hyp-model", weightId: "default" },
    name: "Hypothetical TP2",
    engine: { runtime: "vllm" },
    topology: { mode: "tp", parallelism: 2, minNodes: 2, maxNodes: 2 },
    endpoint: { port: 9201, path: "/v1" },
    nodeIds: ["dgx-1", "dgx-2"],
    launch: { mechanism: "command", executable: "python", command: "python -m vllm", workdir: "/opt/hyp" },
    healthProbe: { kind: "http", path: "/v1/models" },
    discovery: { strategy: "process" },
    logSource: { kind: "file", path: "/var/log/hyp" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.recipe.modelId, "hyp-model");
  assert.equal(r.json.recipe.topology, "tp2");

  // A binding auto-syncs from the recipe; explicitly create one with a role.
  const d = await call(base, "POST", "/api/deployments", {
    modelId: "hyp-model", recipeId: "hyp-recipe", nodeIds: ["dgx-1", "dgx-2"], desiredState: "running", role: "primary",
  });
  assert.equal(d.status, 200);
  assert.equal(d.json.deployment.role, "primary");
  assert.equal(d.json.deployment.modelId, "hyp-model");
  assert.equal(d.json.runtime.dryRun, true);

  // CONFIG-ONLY: the runtime state is dry-run and no process was started.
  const list = await call(base, "GET", "/api/deployments");
  assert.equal(list.status, 200);
  assert.equal(list.json.dryRun, true);
  assert.ok(list.json.deployments.length >= 1);
  assert.ok(list.json.deployments.every((x) => x.dryRun === true && x.lastOp === null));
});

/* ─── 86 · CONFIG-ONLY ADD COMPUTE (DGX #4 validate + local write, no remote action) ─── */
test("86 a hypothetical DGX #4 validates config-only and joins the fleet", async (t) => {
  const { base, sparkRegistry, close } = await boot();
  t.after(close);
  fetchCalls.length = 0;

  const draft = {
    id: "dgx-4",
    name: "DGX 4",
    kind: "spark",
    lanIp: "10.0.0.4",
    llmPorts: [8000],
    ssh: { user: "spark", auth: "key" },
    fabricLinks: [{ to: "dgx-3", speedMbps: 200_000, medium: "cx7" }],
  };
  const v = await call(base, "POST", "/api/compute/validate", { draft });
  assert.equal(v.status, 200);
  assert.equal(v.json.configOnly, true);
  assert.equal(v.json.ok, true);
  assert.equal(v.json.invalidCount, 0);
  // bounded reachability probe against the mocked fetch only — never ssh.
  assert.ok(fetchCalls.length >= 1 && fetchCalls.length <= 3);

  sparkRegistry.addSpark({ ...draft });
  assert.ok(sparkRegistry.sparkIds.includes("dgx-4"));
  assert.equal(sparkRegistry.sparks.length, 4);

  // The 4th node is accepted generically into a binding (no slot assumption).
  await call(base, "POST", "/api/models", { id: "quad-model", name: "Quad model", weightPaths: { default: "/models/quad" } });
  const r = await call(base, "POST", "/api/recipes", {
    id: "quad-recipe", modelRef: { modelId: "quad-model", weightId: "default" }, name: "Quad",
    engine: { runtime: "vllm" },
    topology: { mode: "tp", parallelism: 4, minNodes: 4, maxNodes: 4 },
    endpoint: { port: 9202, path: "/v1" },
    nodeIds: ["dgx-1", "dgx-2", "dgx-3", "dgx-4"],
    launch: { mechanism: "command", executable: "python", command: "python -m vllm", workdir: "/opt/quad" },
    healthProbe: { kind: "http", path: "/v1/models" },
    discovery: { strategy: "process" },
    logSource: { kind: "file", path: "/var/log/quad" },
  });
  assert.equal(r.status, 200);
  const d = await call(base, "POST", "/api/deployments", { modelId: "quad-model", recipeId: "quad-recipe", nodeIds: ["dgx-1", "dgx-2", "dgx-3", "dgx-4"] });
  assert.equal(d.status, 200);
  assert.deepEqual(d.json.deployment.nodeIds, ["dgx-1", "dgx-2", "dgx-3", "dgx-4"]);
});

/* ─── 80/81/82 · registry-level topology capability is data, not node count ─── */
test("80 provider-declared TP3 on 3 nodes is VALID (registry capability)", () => {
  assert.equal(registry.supportsTopology("vllm", { mode: "tp", degree: 3, nodeCount: 3 }), "supported");
  const out = validateTopology({ topology: { mode: "tp", tp: 3 }, nodeCount: 3, runtime: "vllm", registry });
  assert.equal(out.status, "valid");
});

test("81 a provider that does NOT support TP is INVALID on 3 nodes", () => {
  const provider = { supportsTopology: ({ mode }) => (mode === "single" ? "supported" : "unsupported") };
  const out = validateTopology({ topology: { mode: "tp", tp: 3 }, nodeCount: 3, provider });
  assert.equal(out.status, "invalid");
});

test("82 3 nodes with no configured degree is TOPOLOGY UNKNOWN (never TP3)", () => {
  const out = validateTopology({ topology: { mode: "single", parallelism: 1 }, nodeCount: 3, runtime: "vllm", registry });
  assert.equal(out.status, "needs-confirmation");
  assert.match(out.reason, /do not imply/);
});
