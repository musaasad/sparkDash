import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeploymentService } from "../DeploymentService.js";
import { RecipeRegistry } from "../../recipes/RecipeRegistry.js";

function tmpStore(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sd-dep-${name}-`));
  return {
    recipes: path.join(dir, "recipes.json"),
    active: path.join(dir, "active.json"),
    audit: path.join(dir, "audit.jsonl"),
  };
}

function makeService(name, managedBy = "sparkdash") {
  const t = tmpStore(name);
  const recipes = new RecipeRegistry({ path: t.recipes, getKnownNodeIds: () => ["dgx-3"] });
  recipes.upsert({
    id: "qwen38-tabbyapi-dgx3",
    modelId: "qwen38",
    name: "Qwen TabbyAPI",
    runtime: "tabbyapi-exl3",
    topology: "single",
    nodeIds: ["dgx-3"],
    modelPath: "/home/m/models/Qwen",
    workdir: "/home/m/tabbyAPI",
    apiPort: 8889,
    metadata: { managedBy },
  });
  const svc = new DeploymentService({
    recipeRegistry: recipes,
    auditPath: t.audit,
    activePath: t.active,
  });
  return { svc, recipes, t };
}

test("dry-run start transitions available→starting→loading→running and audits", async () => {
  const { svc, t } = makeService("happy");
  const changes = [];
  svc.onStateChange = (s) => changes.push(s.state);
  const state = svc.begin("qwen38-tabbyapi-dgx3", "start", { actor: "test" });
  assert.equal(state.dryRun, true);
  assert.equal(state.state, "starting");
  // Wait for the simulated completion.
  await new Promise((r) => setTimeout(r, 4300));
  assert.equal(svc.getState("qwen38-tabbyapi-dgx3").state, "running");
  assert.ok(changes.includes("loading"));
  svc.cancelAll();
  const audit = fs.readFileSync(t.audit, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(audit[0].action, "start");
  assert.equal(audit[0].dryRun, true);
  assert.equal(audit[0].recipe, "qwen38-tabbyapi-dgx3");
});

test("duplicate launch rejected 409 while an op is active", () => {
  const { svc } = makeService("dup");
  svc.begin("qwen38-tabbyapi-dgx3", "start");
  assert.throws(() => svc.begin("qwen38-tabbyapi-dgx3", "start"), /already active/);
  svc.cancelAll();
});

test("externally-managed deployment rejects all mutations with a reason", () => {
  const { svc } = makeService("external", "external");
  for (const action of ["start", "stop", "restart"]) {
    assert.throws(() => svc.begin("qwen38-tabbyapi-dgx3", action), /externally managed/);
  }
});

test("unknown recipe 404; archived recipe 409", () => {
  const { svc, recipes } = makeService("edge");
  assert.throws(() => svc.begin("nope", "start"), /recipe not found/);
  recipes.upsert({ ...recipes.get("qwen38-tabbyapi-dgx3"), archived: true });
  assert.throws(() => svc.begin("qwen38-tabbyapi-dgx3", "start"), /archived/);
});

test("observe() maps external deployment to running/stopped from probe", () => {
  const { svc } = makeService("observe", "external");
  assert.equal(svc.observe("qwen38-tabbyapi-dgx3", { llmAvailable: true }).state, "running");
  assert.equal(svc.observe("qwen38-tabbyapi-dgx3", { llmAvailable: false }).state, "stopped");
});

test("DeploymentService source contains no exec/ssh capability", () => {
  // The dry-run engine must never gain a way to run commands this phase.
  const src = fs.readFileSync(
    new URL("../DeploymentService.js", import.meta.url),
    "utf8"
  );
  assert.ok(!/from ["']child_process["']|require\(["']child_process["']\)|\.spawn\(|\.execSync\(|sshExec\(/.test(src));
  const { svc } = makeService("nosecret");
  const s = svc.begin("qwen38-tabbyapi-dgx3", "start");
  assert.equal(s.dryRun, true);
  svc.cancelAll();
});