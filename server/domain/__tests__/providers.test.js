import test from "node:test";
import assert from "node:assert/strict";
import {
  RUNTIME_TYPES,
  detectRuntime,
  providerFor,
  healthClassify,
  servedModelIds,
  renderLaunchCommand,
  parseTelemetryLine,
  parseLogLine,
} from "../providers/registry.js";
import { RECIPE_RUNTIMES } from "../../validate.js";

test("registry is keyed by runtime and covers the validate enum", () => {
  for (const r of RECIPE_RUNTIMES) assert.ok(RUNTIME_TYPES.includes(r), `missing runtime ${r}`);
  for (const r of RUNTIME_TYPES) assert.equal(providerFor(r).runtimes.includes(r), true);
});

test("detectRuntime classifies backend signals to the right runtime", () => {
  assert.equal(detectRuntime({ backendType: "exl3" }), "tabbyapi-exl3");
  assert.equal(detectRuntime({ ownedBy: "tabbyapi" }), "tabbyapi-exl3");
  assert.equal(detectRuntime({ backendType: "sglang" }), "sglang");
  assert.equal(detectRuntime({ backendType: "vllm" }), "vllm");
  assert.equal(detectRuntime({ backendType: "llama.cpp" }), "llama.cpp");
  assert.equal(detectRuntime({ ownedBy: "llama.cpp" }), "llama.cpp");
  assert.equal(detectRuntime({ serverIsOpenAI: true }), "vllm");
  assert.equal(detectRuntime({}), "custom"); // catch-all, never null
});

test("healthClassify keeps WS-1 auth-gated semantics per runtime", () => {
  for (const r of RUNTIME_TYPES) {
    assert.equal(healthClassify(r, { status: 200 }), "running");
    assert.equal(healthClassify(r, { status: 401 }), "auth-gated");
    assert.equal(healthClassify(r, { status: 403 }), "auth-gated");
    assert.equal(healthClassify(r, { status: 500 }), "unhealthy");
    assert.equal(healthClassify(r, { errorCode: "ECONNREFUSED" }), "not-detected");
    assert.equal(healthClassify(r, { errorName: "TimeoutError" }), "unhealthy");
  }
});

test("servedModelIds reads OpenAI data[] and llama.cpp slots[]", () => {
  assert.deepEqual(servedModelIds("vllm", { data: [{ id: "org/model" }] }), ["org/model"]);
  assert.deepEqual(servedModelIds("llama.cpp", [{ id: "gguf-model" }]), ["gguf-model"]);
  assert.deepEqual(servedModelIds("custom", { data: [] }), []);
});

test("renderLaunchCommand is dry-run string only; external returns null", () => {
  const recipe = { engine: { runtime: "vllm" }, modelPath: "/models/a", endpoint: { port: 8000 } };
  assert.equal(renderLaunchCommand(recipe), "vllm serve /models/a --port 8000");
  assert.equal(
    renderLaunchCommand({ engine: { runtime: "custom" }, modelPath: "/m", endpoint: { port: 1 } }),
    null
  );
  // An explicit launcher always wins.
  assert.equal(
    renderLaunchCommand({ engine: { runtime: "sglang" }, launch: { command: "custom cmd" } }),
    "custom cmd"
  );
});

test("provider-owned log shaping: loguru + tabby telemetry, external generic", () => {
  const line = parseLogLine("tabbyapi-exl3", "2026-09-21 20:36:55.347 | INFO     | hi");
  assert.equal(line.level, "INFO");
  assert.equal(line.ts, "2026-09-21T20:36:55.347");

  const ev = parseTelemetryLine("tabbyapi-exl3", "#7 chat/completions: 100 prompt tokens · temperature: 0.5");
  assert.equal(ev.phase, "start");
  assert.equal(ev.reqId, 7);

  const ext = parseLogLine("custom", "plain line");
  assert.equal(ext.level, "raw");
  assert.equal(ext.msg, "plain line");
  assert.equal(parseTelemetryLine("custom", "#7 whatever"), null);
});

test("provider catalog exposes a non-empty label per runtime (GET /api/runtimes source)", () => {
  for (const r of RUNTIME_TYPES) {
    const p = providerFor(r);
    assert.equal(typeof p.label, "string");
    assert.ok(p.label.length > 0, `empty label for ${r}`);
    assert.equal(typeof p.launchable, "boolean");
  }
});
