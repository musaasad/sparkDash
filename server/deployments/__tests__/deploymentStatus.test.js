import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyProbe,
  deriveDisplay,
  probeEndpoint,
  probeUrl,
  DISPLAY_STATES,
} from "../deploymentStatus.js";
import { DeploymentService } from "../DeploymentService.js";
import { RecipeRegistry } from "../../recipes/RecipeRegistry.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("classifyProbe: 2xx is running", () => {
  assert.equal(classifyProbe({ status: 200 }), "running");
  assert.equal(classifyProbe({ status: 204 }), "running");
});

test("classifyProbe: 401/403 is auth-gated (process up, endpoint gated)", () => {
  assert.equal(classifyProbe({ status: 401 }), "auth-gated");
  assert.equal(classifyProbe({ status: 403 }), "auth-gated");
});

test("classifyProbe: 5xx and other 4xx are unhealthy", () => {
  assert.equal(classifyProbe({ status: 500 }), "unhealthy");
  assert.equal(classifyProbe({ status: 503 }), "unhealthy");
  assert.equal(classifyProbe({ status: 404 }), "unhealthy");
});

test("classifyProbe: refused / DNS / unreachable is not-detected", () => {
  assert.equal(classifyProbe({ errorCode: "ECONNREFUSED" }), "not-detected");
  assert.equal(classifyProbe({ errorCode: "ENOTFOUND" }), "not-detected");
  assert.equal(classifyProbe({ errorCode: "EAI_AGAIN" }), "not-detected");
  assert.equal(classifyProbe({ errorCode: "EHOSTUNREACH" }), "not-detected");
  assert.equal(classifyProbe({}), "not-detected");
});

test("classifyProbe: timeout is unhealthy", () => {
  assert.equal(classifyProbe({ errorName: "TimeoutError" }), "unhealthy");
  assert.equal(classifyProbe({ errorName: "AbortError" }), "unhealthy");
});

test("probeUrl builds the health path and defaults to /v1/models", () => {
  assert.equal(probeUrl("10.0.0.3", 8889, "/v1/models"), "http://10.0.0.3:8889/v1/models");
  assert.equal(probeUrl("10.0.0.3", 8889, null), "http://10.0.0.3:8889/v1/models");
  assert.equal(probeUrl(null, 8889, "/health"), null);
});

test("probeEndpoint classifies mocked outcomes without real network", async () => {
  const ok = await probeEndpoint("http://h:1/v1/models", {
    fetchImpl: async () => ({ status: 401 }),
  });
  assert.equal(classifyProbe(ok), "auth-gated");

  const refused = await probeEndpoint("http://h:1/v1/models", {
    fetchImpl: async () => {
      const err = new TypeError("fetch failed");
      err.cause = { code: "ECONNREFUSED" };
      throw err;
    },
  });
  assert.equal(classifyProbe(refused), "not-detected");

  const timeout = await probeEndpoint("http://h:1/v1/models", {
    fetchImpl: async () => {
      const err = new Error("timeout");
      err.name = "TimeoutError";
      throw err;
    },
  });
  assert.equal(classifyProbe(timeout), "unhealthy");
});

test("deriveDisplay: fixed vocabulary matrix", () => {
  assert.equal(deriveDisplay({ desired: "running", observed: "running" }), "running");
  assert.equal(deriveDisplay({ desired: "stopped", observed: "running" }), "running-external");
  assert.equal(deriveDisplay({ desired: "stopped", observed: "auth-gated" }), "running-external");
  assert.equal(deriveDisplay({ desired: "unknown", observed: "running" }), "running-external");
  assert.equal(deriveDisplay({ desired: "unknown", observed: "auth-gated" }), "running-external");
  assert.equal(deriveDisplay({ desired: "running", observed: "not-detected" }), "expected-not-detected");
  assert.equal(deriveDisplay({ desired: "running", observed: "not-detected", discovered: true }), "expected-not-detected");
  assert.equal(deriveDisplay({ desired: "unknown", observed: "not-detected", discovered: true }), "running-external");
  assert.equal(deriveDisplay({ desired: "running", observed: "unhealthy" }), "degraded");
  assert.equal(deriveDisplay({ desired: "stopped", observed: "not-detected" }), "stopped");
  assert.equal(deriveDisplay({}), "stopped");
  for (const d of [deriveDisplay({}), deriveDisplay({ desired: "running", observed: "auth-gated" })]) {
    assert.ok(DISPLAY_STATES.includes(d));
  }
});

function makeService(name, managedBy = "external") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sd-dstat-${name}-`));
  const recipes = new RecipeRegistry({
    path: path.join(dir, "recipes.json"),
    getKnownNodeIds: () => ["dgx-3"],
  });
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
  return new DeploymentService({
    recipeRegistry: recipes,
    auditPath: path.join(dir, "audit.jsonl"),
    activePath: path.join(dir, "active.json"),
  });
}

test("externally-managed recipe defaults desired=unknown", () => {
  const svc = makeService("default");
  const state = svc.getState("qwen38-tabbyapi-dgx3");
  assert.equal(state.desired, "unknown");
  assert.equal(state.observed, "not-detected");
  assert.equal(state.display, "stopped");
});

test("observe(): auth-gated 401 shows Running external, not Stopped", () => {
  const svc = makeService("qwen");
  const state = svc.observe("qwen38-tabbyapi-dgx3", { observed: "auth-gated" });
  assert.equal(state.observed, "auth-gated");
  assert.equal(state.display, "running-external");
  assert.equal(state.state, "running");
});

test("observe(): desired=running + not-detected warns Expected · not detected", () => {
  const svc = makeService("expected");
  svc.getState("qwen38-tabbyapi-dgx3").desired = "running";
  const state = svc.observe("qwen38-tabbyapi-dgx3", { observed: "not-detected" });
  assert.equal(state.display, "expected-not-detected");
});

test("observe(): unhealthy degrades", () => {
  const svc = makeService("degraded");
  const state = svc.observe("qwen38-tabbyapi-dgx3", { observed: "unhealthy" });
  assert.equal(state.display, "degraded");
});

test("observe(): discovered pgrep evidence upgrades a missing endpoint to external", () => {
  const svc = makeService("discovered");
  const state = svc.observe("qwen38-tabbyapi-dgx3", { observed: "not-detected", discovered: true });
  assert.equal(state.discovered, true);
  assert.equal(state.display, "running-external");
});

test("dry-run start/stop moves desired through the existing path and persists it", async () => {
  const svc = makeService("managed", "sparkdash");
  svc.begin("qwen38-tabbyapi-dgx3", "start");
  await new Promise((r) => setTimeout(r, 4300));
  const running = svc.observe("qwen38-tabbyapi-dgx3", { observed: "running" });
  assert.equal(running.desired, "running");
  assert.equal(running.display, "running");
  svc.begin("qwen38-tabbyapi-dgx3", "stop");
  await new Promise((r) => setTimeout(r, 1700));
  const stopped = svc.observe("qwen38-tabbyapi-dgx3", { observed: "not-detected" });
  assert.equal(stopped.desired, "stopped");
  assert.equal(stopped.display, "stopped");
  svc.cancelAll();
});

test("observe(): declared metadata.desired=running yields Running, not external", () => {
  const svc = makeService("declared");
  svc.recipeRegistry.upsert({
    ...svc.recipeRegistry.get("qwen38-tabbyapi-dgx3"),
    metadata: { managedBy: "external", desired: "running" },
  });
  const state = svc.observe("qwen38-tabbyapi-dgx3", { observed: "running" });
  assert.equal(state.desired, "running");
  assert.equal(state.display, "running");
});

test("DeploymentService still owns no ssh/child_process capability", () => {
  const src = fs.readFileSync(new URL("../DeploymentService.js", import.meta.url), "utf8");
  assert.ok(!/child_process|sshExec\(/.test(src));
});
