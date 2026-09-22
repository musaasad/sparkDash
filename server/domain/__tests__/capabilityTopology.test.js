/**
 * Role model + provider topology capability + capability-aware validation.
 *
 * Invariants under test:
 *  - role change is a CONFIG write (no model recreation)
 *  - fleet size NEVER produces a degree
 *  - UNKNOWN != FAILED (needs-confirmation, never silently valid)
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sd-cap-"));
process.env.SPARKDASH_CONFIG_DIR = ROOT;

const { DEPLOYMENT_ROLES, normalizeDeployment, normalizeDeploymentRole, validateDeployment } = await import("../schema.js");
const { DeploymentRegistry } = await import("../deploymentRegistry.js");
const { validateTopology } = await import("../topologyValidate.js");
const { validateRecipeFeasibility } = await import("../recipeValidate.js");
const registry = await import("../providers/registry.js");
const { normalizeRecipe } = await import("../schema.js");

// ─── Roles ────────────────────────────────────────────────

test("role set is the expanded 6 and legacy 'edge' folds onto 'worker'", () => {
  assert.deepEqual([...DEPLOYMENT_ROLES], ["primary", "worker", "specialist", "reviewer", "experimental", "none"]);
  assert.equal(normalizeDeploymentRole("edge"), "worker");
  for (const r of DEPLOYMENT_ROLES) assert.equal(normalizeDeploymentRole(r), r);
  assert.equal(normalizeDeploymentRole("bogus"), null);
  assert.equal(normalizeDeploymentRole(null), null);
});

test("validateDeployment accepts the new roles and rejects unknowns", () => {
  for (const role of DEPLOYMENT_ROLES) {
    const dep = normalizeDeployment({ id: "d1", recipeId: "r1", modelId: "m1", nodeIds: ["n"], role });
    assert.equal(validateDeployment(dep).ok, true, role);
  }
  const bad = normalizeDeployment({ id: "d1", recipeId: "r1", modelId: "m1", nodeIds: ["n"] });
  bad.role = "bogus";
  assert.equal(validateDeployment(bad).ok, false);
});

test("role change is a config-only write (model/recipe untouched, idempotent)", () => {
  const dir = fs.mkdtempSync(path.join(ROOT, "roles-"));
  const deps = new DeploymentRegistry({ path: path.join(dir, "deployments.json") });
  const dep = deps.create({ id: "dep-r1", modelId: "m1", recipeId: "r1", nodeIds: ["n1"] });
  const modelRefBefore = dep.modelId;
  const recipeRefBefore = dep.recipeId;

  const changed = deps.setRole("dep-r1", "edge");
  assert.equal(changed.role, "worker");
  assert.equal(changed.modelId, modelRefBefore);
  assert.equal(changed.recipeId, recipeRefBefore);

  // persisted + reloadable (idempotent across a fresh load)
  const reloaded = new DeploymentRegistry({ path: path.join(dir, "deployments.json") });
  assert.equal(reloaded.get("dep-r1").role, "worker");

  // clearing is allowed, unknown role throws 400
  assert.equal(deps.setRole("dep-r1", null).role, null);
  assert.throws(() => deps.setRole("dep-r1", "bogus"), /unknown deployment role/);
  assert.equal(deps.setRole("nope", "worker"), null);
});

// ─── Provider capability ──────────────────────────────────

const { DeploymentService } = await import("../../deployments/DeploymentService.js");

test("DeploymentService projects role from the registry with no recreation", () => {
  const dir = fs.mkdtempSync(path.join(ROOT, "svc-"));
  const deps = new DeploymentRegistry({ path: path.join(dir, "deployments.json") });
  deps.create({ id: "dep-r1", modelId: "m1", recipeId: "r1", nodeIds: ["n1"] });
  const recipe = { id: "r1", modelRef: { modelId: "m1" }, endpoint: { port: 9200, path: "/v1" }, launch: { mechanism: "command" }, topology: { minNodes: 1, maxNodes: 1 } };
  const svc = new DeploymentService({
    recipeRegistry: { get: (id) => (id === "r1" ? recipe : null) },
    deploymentRegistry: deps,
    auditPath: path.join(dir, "audit.jsonl"),
    activePath: path.join(dir, "active.json"),
  });
  const state = svc.getState("dep-r1");
  assert.equal(state.role, null);
  deps.setRole("dep-r1", "reviewer");
  assert.equal(svc.getState("dep-r1").role, "reviewer");
  assert.equal(deps.get("dep-r1").recipeId, "r1");
  svc.cancelAll();
});
test("base default is unknown; external is unknown (never fabricate)", () => {
  assert.equal(registry.supportsTopology("custom", { mode: "tp", degree: 2, nodeCount: 2 }), "unknown");
  assert.equal(registry.supportsTopology("llama.cpp", { mode: "tp", degree: 2, nodeCount: 2 }), "unknown");
});

test("vllm/sglang declare tp support by node count, other modes unknown", () => {
  for (const rt of ["vllm", "sglang"]) {
    assert.equal(registry.supportsTopology(rt, { mode: "tp", degree: 2, nodeCount: 2 }), "supported");
    assert.equal(registry.supportsTopology(rt, { mode: "tp", degree: 4, nodeCount: 2 }), "unsupported");
    assert.equal(registry.supportsTopology(rt, { mode: "pp", degree: 2, nodeCount: 3 }), "unknown");
    assert.equal(registry.supportsTopology(rt, { mode: "dp", degree: 2, nodeCount: 3 }), "unknown");
    assert.equal(registry.supportsTopology(rt, { mode: "single", degree: 1, nodeCount: 1 }), "supported");
  }
});

test("tabbyapi declares single-only; every parallelism mode is unsupported", () => {
  assert.equal(registry.supportsTopology("tabbyapi-exl3", { mode: "single", degree: 1, nodeCount: 1 }), "supported");
  for (const mode of ["tp", "pp", "dp", "ep"]) {
    assert.equal(registry.supportsTopology("tabbyapi-exl3", { mode, degree: 2, nodeCount: 2 }), "unsupported");
  }
});

test("topologyDescriptor exposes capability as DATA (provider, not model-name check)", () => {
  assert.equal(registry.topologyDescriptor("tabbyapi-exl3").tp, "unsupported");
  assert.equal(registry.topologyDescriptor("tabbyapi-exl3").single, "supported");
  assert.equal(registry.topologyDescriptor("vllm").tp, "by-node-count");
  assert.equal(registry.topologyDescriptor("sglang").tp, "by-node-count");
  // External/unmodelled runtimes declare nothing ⇒ every mode stays UNKNOWN.
  assert.equal(registry.topologyDescriptor("custom").tp, undefined);
  assert.equal(registry.supportsTopology("custom", { mode: "tp", degree: 2, nodeCount: 2 }), "unknown");
});

test("an explicitly non-TP runtime (tabbyapi) makes TP-on-2-nodes INVALID", () => {
  const out = t({ mode: "tp", tp: 2 }, 2, "tabbyapi-exl3");
  assert.equal(out.status, "invalid");
  assert.match(out.reason, /does not support topology mode\(s\): tp/);
});

test("TP3/3 on an external/unknown runtime stays NEEDS-CONFIRMATION", () => {
  const out = t({ mode: "tp", tp: 3 }, 3, "custom");
  assert.equal(out.status, "needs-confirmation");
  assert.notEqual(out.status, "valid");
});

// ─── validateTopology ─────────────────────────────────────

const t = (topology, nodeCount, runtime) => validateTopology({ topology, nodeCount, runtime, registry });

test("TP2 on 2 nodes with a tp-declaring provider is VALID", () => {
  const out = t({ mode: "tp", tp: 2 }, 2, "vllm");
  assert.equal(out.status, "valid");
});

test("TP4 on 2 nodes is INVALID (degree > nodes)", () => {
  const out = t({ mode: "tp", tp: 4 }, 2, "vllm");
  assert.equal(out.status, "invalid");
  assert.match(out.reason, /at least 4 node/);
});

test("TP3 on 3 nodes with an UNKNOWN provider is NEEDS-CONFIRMATION (not invalid, not valid)", () => {
  const out = t({ mode: "tp", tp: 3 }, 3, "custom");
  assert.equal(out.status, "needs-confirmation");
});

test("TP3 on 3 nodes with a fixture provider that advertises TP3 is VALID", () => {
  const provider = { supportsTopology: ({ mode, degree, nodeCount }) => (mode === "tp" && degree <= nodeCount ? "supported" : "unknown") };
  const out = validateTopology({ topology: { mode: "tp", tp: 3 }, nodeCount: 3, provider });
  assert.equal(out.status, "valid");
});

test("TP3 on 3 nodes with a fixture provider that does NOT support TP is INVALID", () => {
  const provider = { supportsTopology: ({ mode }) => (mode === "single" ? "supported" : "unsupported") };
  const out = validateTopology({ topology: { mode: "tp", tp: 3 }, nodeCount: 3, provider });
  assert.equal(out.status, "invalid");
});

test("node count NEVER produces a degree: 3 nodes with no configured degree => unknown", () => {
  const out = t({ mode: "single", parallelism: 1 }, 3, "vllm");
  assert.equal(out.status, "needs-confirmation");
  assert.match(out.reason, /do not imply/);
});

test("a structurally-fine single on 1 node is valid for a launching provider", () => {
  assert.equal(t({ mode: "single", parallelism: 1 }, 1, "vllm").status, "valid");
  assert.equal(t({ mode: "single", parallelism: 1 }, 1, "tabbyapi-exl3").status, "valid");
});

test("a capability check is keyed per degree kind (ep-only uses ep, not tp)", () => {
  const seen = [];
  const provider = { supportsTopology: (spec) => { seen.push(spec.mode); return spec.mode === "ep" ? "unsupported" : "unknown"; } };
  const out = validateTopology({ topology: { mode: "ep", ep: 2 }, nodeCount: 2, provider });
  assert.deepEqual(seen, ["ep"]);
  assert.equal(out.status, "invalid");
});

test("product of degrees over node count is invalid", () => {
  const out = t({ mode: "tp", tp: 2, pp: 2 }, 3, "vllm");
  assert.equal(out.status, "invalid");
  assert.match(out.reason, /product/);
});

test("missing node count is needs-confirmation (unknown != failed)", () => {
  assert.equal(validateTopology({ topology: { mode: "tp", tp: 2 }, nodeCount: 0, runtime: "vllm", registry }).status, "needs-confirmation");
});

// ─── recipeValidate wiring ────────────────────────────────

function recipeWith(topology, runtime, nodeIds) {
  return normalizeRecipe({
    id: "r1",
    modelRef: { modelId: "m1" },
    name: "R",
    engine: { runtime },
    endpoint: { port: 9100 },
    topology,
    nodeIds,
  });
}

test("recipeValidate errors on an unsupported provider degree", () => {
  const recipe = recipeWith({ mode: "tp", tp: 2 }, "tabbyapi-exl3", ["n1", "n2"]);
  const res = validateRecipeFeasibility(recipe, { knownNodeIds: ["n1", "n2"] });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /topology:/.test(e)));
});

test("recipeValidate warns (never errors) on an unknown provider degree", () => {
  const recipe = recipeWith({ mode: "tp", tp: 2 }, "custom", ["n1", "n2"]);
  const res = validateRecipeFeasibility(recipe, { knownNodeIds: ["n1", "n2"] });
  assert.equal(res.ok, true);
  assert.ok(res.warnings.some((w) => /needs confirmation/.test(w)));
});

test("recipeValidate stays clean for a declared tp2/vllm recipe", () => {
  const recipe = recipeWith({ mode: "tp", tp: 2 }, "vllm", ["n1", "n2"]);
  const res = validateRecipeFeasibility(recipe, { knownNodeIds: ["n1", "n2"] });
  assert.equal(res.ok, true);
  assert.equal(res.warnings.filter((w) => /topology/.test(w)).length, 0);
});
