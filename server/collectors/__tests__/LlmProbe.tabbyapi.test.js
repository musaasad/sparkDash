/**
 * TabbyAPI (DGX Spark Qwen/EXL3 deployment) detection + honest handling.
 *
 * Live shape: OpenAI-compatible /v1/models with owned_by='tabbyAPI' and
 * meta.n_ctx; /health {status:'healthy',issues:[]}; NO /metrics and NO
 * /server_info. Every inference-performance field must be null — never the
 * constructor-default 0 — so the UI renders "—".
 *
 * Hermetic: fixtures only, no real network.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";
import { deriveRuntimeState } from "../../../src/shared/runtimeState.js";

const MODEL_ID = "Qwen3.8-Flash-Next-EXL3";

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function notFound() {
  return {
    ok: false,
    status: 404,
    json: async () => ({}),
    text: async () => "",
  };
}

/**
 * Fixture TabbyAPI: /slots 404, /v1/models with meta.n_ctx, /health healthy,
 * /metrics + /stats + /server_info all 404.
 * @param {string[]} seen recorded paths
 */
function tabbyFetch(seen) {
  return async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.endsWith("/slots")) return notFound();
    if (u.endsWith("/v1/models")) {
      return jsonRes({
        data: [
          {
            id: MODEL_ID,
            owned_by: "tabbyAPI",
            meta: { n_ctx: 262144, n_ctx_train: 262144, n_vocab: 248320, n_embd: 2560 },
          },
        ],
      });
    }
    if (u.endsWith("/health")) return jsonRes({ status: "healthy", issues: [] });
    if (u.endsWith("/metrics")) return notFound();
    if (u.endsWith("/server_info") || u.endsWith("/get_server_info")) return notFound();
    return notFound();
  };
}

test("_classifyOpenAIBackend: owned_by tabbyAPI → tabbyapi (not vllm)", async () => {
  const probe = new LlmProbe({ lanIp: "192.168.1.246" }, 8889);
  assert.equal(await probe._classifyOpenAIBackend("tabbyAPI"), "tabbyapi");
});

test("tabbyapi probe: backend/modelId/contextLength honest, perf all null (never 0)", async () => {
  const probe = new LlmProbe({ lanIp: "192.168.1.246", llmApiKeys: { "8889": "sk-test" } }, 8889);
  const seen = [];
  probe._fetch = tabbyFetch(seen);

  const snap = await probe.probe();

  assert.equal(snap.backend, "tabbyapi");
  assert.equal(snap.modelId, MODEL_ID);
  assert.equal(snap.contextLength, 262144);
  assert.equal(snap.available, true);
  assert.equal(snap.authGated, false);
  assert.equal(snap.reachable, true);

  // TabbyAPI exposes no perf counters — UNKNOWN, not a fabricated 0.
  for (const key of [
    "generationTps",
    "prefillTps",
    "cachedPrefillTps",
    "uncachedPrefillTps",
    "totalOutputTokens",
    "slotsActive",
    "slotsTotal",
    "kvCacheUsage",
    "requestsRunning",
    "requestsWaiting",
    "ttftSeconds",
    "ttftP95Seconds",
    "preemptionsTotal",
    "prefixCacheHitRate",
    "e2eP95Seconds",
    "itlP95Seconds",
    "mtpAcceptanceRate",
    "gpuMemoryUtilization",
  ]) {
    assert.strictEqual(snap[key], null, `${key} must be null, got ${snap[key]}`);
    assert.notStrictEqual(snap[key], 0, `${key} must not be a fabricated 0`);
  }

  // No Prometheus /metrics fetch for perf (and no /server_info).
  assert.equal(seen.some((u) => u.endsWith("/metrics")), false);
  assert.equal(seen.some((u) => u.includes("/server_info")), false);
});

test("tabbyapi /props total_slots is the ONLY non-log metric, read honestly", async () => {
  const probe = new LlmProbe({ lanIp: "192.168.1.246" }, 8889);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) return notFound();
    if (u.endsWith("/v1/models")) {
      return jsonRes({ data: [{ id: MODEL_ID, owned_by: "tabbyAPI", meta: { n_ctx: 262144 } }] });
    }
    if (u.endsWith("/props")) return jsonRes({ total_slots: 4, max_seq_len: 262144 });
    if (u.endsWith("/health")) return jsonRes({ status: "healthy", issues: [] });
    return notFound();
  };
  const snap = await probe.probe();
  assert.equal(snap.slotsTotal, 4);
  // Everything else still honest-unknown (no HTTP metrics endpoint).
  assert.strictEqual(snap.generationTps, null);
  assert.strictEqual(snap.requestsRunning, null);
  assert.strictEqual(snap.slotsActive, null);
});

test("contextLength falls back to n_ctx_train when meta.n_ctx is absent", async () => {  const probe = new LlmProbe({ lanIp: "192.168.1.246", llmApiKeys: { "8889": "sk-test" } }, 8889);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) return notFound();
    if (u.endsWith("/v1/models")) {
      return jsonRes({ data: [{ id: MODEL_ID, owned_by: "tabbyAPI", meta: { n_ctx_train: 262144 } }] });
    }
    if (u.endsWith("/health")) return jsonRes({ status: "healthy", issues: [] });
    return notFound();
  };
  const snap = await probe.probe();
  assert.equal(snap.contextLength, 262144);
});

test("runtimeState: tabbyapi available + modelId + no active => READY (not degraded/offline/serving)", () => {
  const telemetry = {
    available: true,
    backend: "tabbyapi",
    modelId: MODEL_ID,
    contextLength: 262144,
    generationTps: null,
    prefillTps: null,
    requestsRunning: null,
    requestsWaiting: null,
    slotsActive: null,
    slotsTotal: null,
    totalOutputTokens: null,
    kvCacheUsage: null,
  };
  const state = deriveRuntimeState({ telemetry, reachable: true, managedBy: "external", observed: "running" });
  assert.equal(state, "ready");
  assert.notEqual(state, "degraded");
  assert.notEqual(state, "offline");
  assert.notEqual(state, "serving");
});
