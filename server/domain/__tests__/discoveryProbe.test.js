import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Never touch live config; no real network.
const SD_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sd-discprobe-"));
process.env.SPARKDASH_CONFIG_DIR = SD_ROOT;
process.env.SPARKS_SECRETS_PATH = path.join(SD_ROOT, "secrets.json");
process.env.SECRETS_KEY_PATH = path.join(SD_ROOT, ".secrets-key");

const { DiscoveryService, suggestTemplate } = await import("../discovery.js");
const { DeploymentRegistry } = await import("../deploymentRegistry.js");
const { RecipeRegistry } = await import("../../recipes/RecipeRegistry.js");

const freshDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "sd-dp-state-"));
const tmp = (n) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), `sd-dp-${n}-`)), "store.json");

/**
 * Harness: one node, mocked fetch keyed by port. `body` is what /v1/models
 * returns; a port not in `serving` refuses the connection.
 */
function harness({ serving = [8080], body = { data: [{ id: "qwen-3.8", owned_by: "vllm" }] }, secret = "sk-secret-value-xyz" } = {}) {
  const sparks = {
    sparkIds: ["n1"],
    getSpark: (id) => (id === "n1" ? { id: "n1", lanIp: "10.0.0.9", isLocal: false, llmPorts: [8080] } : null),
  };
  const recipes = new RecipeRegistry({ path: tmp("recipes"), getKnownNodeIds: () => sparks.sparkIds });
  const deployments = new DeploymentRegistry({ path: tmp("deps") });

  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", headers: init.headers || {}, body: init.body });
    const u = new URL(url);
    const port = Number(u.port);
    if (!serving.includes(port)) {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }
    if (u.pathname.endsWith("/v1/models")) {
      return { ok: true, status: 200, json: async () => body };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "x" } }] }) };
  };

  const disc = new DiscoveryService({
    sparkRegistry: sparks,
    recipeRegistry: recipes,
    deploymentRegistry: deployments,
    fetchImpl,
    path: path.join(freshDir(), "discovered.json"),
    credResolver: (ref) => (ref === "spark:n1:8080" ? secret : null),
    ttlMs: 0,
  });
  return { disc, calls, secret };
}

test("discoverEndpoint returns detected fields + per-field provenance", async () => {
  const h = harness();
  const out = await h.disc.discoverEndpoint({ host: "10.0.0.9", port: 8080 });

  assert.equal(out.runtime, "vllm");
  assert.equal(out.health, "running");
  assert.deepEqual(out.servedModelIds, ["qwen-3.8"]);
  assert.equal(out.modelId, "qwen-3.8");
  assert.equal(out.endpoint, "http://10.0.0.9:8080/v1/models");
  assert.equal(out.reachable, true);

  assert.equal(out.provenance.host, "user");
  assert.equal(out.provenance.port, "user");
  assert.equal(out.provenance.runtime, "detected");
  assert.equal(out.provenance.servedModelIds, "detected");
  assert.equal(out.provenance.health, "probed");
  assert.equal(out.provenance.contextLength, "unknown");
  assert.equal(out.provenance.runtimeConfidence, "medium");

  // READ-ONLY: bare GET, no cred attached.
  assert.ok(h.calls.every((c) => c.method === "GET"));
  assert.equal(out.credAttached, false);
});

test("discoverEndpoint surfaces metadata hints when exposed", async () => {
  const h = harness({
    body: { data: [{ id: "m", owned_by: "exl3", context_length: 32768, quantization: "EXL3" }] },
  });
  const out = await h.disc.discoverEndpoint({ host: "10.0.0.9", port: 8080 });
  assert.equal(out.contextLength, 32768);
  assert.equal(out.quantization, "exl3");
  assert.equal(out.apiProtocol, "openai");
  assert.equal(out.provenance.contextLength, "detected");
  assert.equal(out.provenance.quantization, "detected");
  assert.equal(out.suggestedTemplate.templateId, "tabbyapi-exl3");
});

test("unreachable endpoint degrades gracefully", async () => {
  const h = harness({ serving: [9999] });
  const out = await h.disc.discoverEndpoint({ host: "10.0.0.9", port: 8080 });
  assert.equal(out.health, "not-detected");
  assert.equal(out.reachable, false);
  assert.equal(out.servedModelIds.length, 0);
  assert.equal(out.provenance.reachable, "unknown");
  assert.equal(out.runtime, "custom");
});

test("auth-gated 401 still reads as up", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const disc = new DiscoveryService({
    sparkRegistry: { sparkIds: [], getSpark: () => null },
    recipeRegistry: { list: () => [] },
    deploymentRegistry: { list: () => [] },
    fetchImpl,
    path: path.join(freshDir(), "d.json"),
  });
  const out = await disc.discoverEndpoint({ host: "h", port: 1 });
  assert.equal(out.health, "auth-gated");
  assert.equal(out.reachable, true);
});

test("malformed JSON body never crashes", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } });
  const disc = new DiscoveryService({
    sparkRegistry: { sparkIds: [], getSpark: () => null },
    recipeRegistry: { list: () => [] },
    deploymentRegistry: { list: () => [] },
    fetchImpl,
    path: path.join(freshDir(), "d.json"),
  });
  const out = await disc.discoverEndpoint({ host: "h", port: 1 });
  assert.equal(out.servedModelIds.length, 0);
  assert.equal(out.provenance.servedModelIds, "unknown");
});

test("unknown runtime yields low-confidence template suggestion", async () => {
  const h = harness({ body: { data: [{ id: "m", owned_by: "who-knows" }] } });
  const out = await h.disc.discoverEndpoint({ host: "10.0.0.9", port: 8080 });
  assert.equal(out.runtime, "custom");
  assert.equal(out.provenance.runtime, "unknown");
  assert.equal(out.provenance.runtimeConfidence, "low");
  assert.equal(out.suggestedTemplate.confidence, "low");
});

test("suggestTemplate mapping", () => {
  assert.deepEqual(suggestTemplate({ runtime: "tabbyapi-exl3" }), { templateId: "tabbyapi-exl3", confidence: "high" });
  assert.deepEqual(suggestTemplate({ runtime: "vllm", apiProtocol: "openai" }), { templateId: "vllm-openai", confidence: "high" });
  assert.deepEqual(suggestTemplate({ runtime: "custom", apiProtocol: "openai" }), { templateId: "external-observed", confidence: "low" });
  assert.equal(suggestTemplate({}).templateId, "scratch");
  assert.equal(suggestTemplate({}).confidence, "low");
});

test("discoverEndpoint attaches cred as a reference only, never echoing the value", async () => {
  const h = harness();
  const out = await h.disc.discoverEndpoint({ host: "10.0.0.9", port: 8080, credRef: "spark:n1:8080" });
  assert.equal(out.credAttached, true);
  assert.equal(out.provenance.credRef, "user");
  const sentAuth = h.calls.find((c) => c.headers.Authorization);
  assert.equal(sentAuth.headers.Authorization, `Bearer ${h.secret}`);
  // The value is never present in the returned object.
  assert.equal(JSON.stringify(out).includes(h.secret), false);
  assert.equal(out.credRef, undefined);
});

test("capability probe is tiny, opt-in, and unknown when not detectable", async () => {
  const h = harness({ body: { data: [{ id: "plain-model", owned_by: "vllm" }] } });
  const out = await h.disc.probeCapabilities({ host: "10.0.0.9", port: 8080 });

  assert.equal(out.text, "yes");
  assert.equal(out.streaming, "yes");
  assert.equal(out.vision, "unknown");
  assert.equal(out.tools, "unknown");
  assert.equal(out.reasoning, "unknown");
  assert.equal(out.provenance.tools, "unknown");

  const posts = h.calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 2);
  for (const c of posts) {
    const payload = JSON.parse(c.body);
    assert.equal(payload.max_tokens, 1);
    assert.ok(payload.messages[0].content.length <= 4);
  }
  assert.equal(h.calls.length, 3); // one GET to resolve the model id + two tiny POSTs
});

test("capability probe maps 4xx to no and does not echo a secret", async () => {
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith("/v1/models")) return { ok: true, status: 200, json: async () => ({ data: [{ id: "m" }] }) };
    return { ok: false, status: 400, json: async () => ({}) };
  };
  const secret = "sk-do-not-echo";
  let sentAuth = null;
  const disc = new DiscoveryService({
    sparkRegistry: { sparkIds: [], getSpark: () => null },
    recipeRegistry: { list: () => [] },
    deploymentRegistry: { list: () => [] },
    fetchImpl: async (url, init = {}) => { sentAuth = init.headers?.Authorization ?? sentAuth; return fetchImpl(url, init); },
    credResolver: () => secret,
    path: path.join(freshDir(), "d.json"),
  });
  const out = await disc.probeCapabilities({ host: "h", port: 1, credRef: "x" });
  assert.equal(out.text, "no");
  assert.equal(out.streaming, "no");
  assert.equal(sentAuth, `Bearer ${secret}`);
  assert.equal(JSON.stringify(out).includes(secret), false);
});

test("scan is bounded: explicit single node only, no blind LAN sweep", async () => {
  const h = harness();
  const seen = [];
  h.disc.fetchImpl = async (url) => {
    seen.push(new URL(url).host);
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  };
  await h.disc.scan({ nodeId: "n1" });
  await new Promise((r) => setTimeout(r, 20));
  // Only the known node's configured port was touched.
  assert.ok(seen.length > 0);
  assert.ok(seen.every((host) => host === "10.0.0.9:8080"));
});

test("invalid host/port rejects", async () => {
  const h = harness();
  await assert.rejects(() => h.disc.discoverEndpoint({ host: "", port: 0 }), /required/);
  await assert.rejects(() => h.disc.probeCapabilities({ host: "h", port: 70000 }), /required/);
});
