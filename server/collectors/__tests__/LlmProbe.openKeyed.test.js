/**
 * P0 TRUTH-DEFECT: an OPEN reachable endpoint (no key) must be DETECTED and
 * READ; a keyed endpoint WITHOUT a key must stay honestly UNAVAILABLE with an
 * explicit auth error — never offline, never invented telemetry.
 *
 * Hermetic: `_fetch` is fully mocked, no network, no timers.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";
import { probeOutcome, deriveRuntimeState, isReachableFromProbe } from "../../../src/shared/runtimeState.js";

const VLLM_METRICS = `vllm:prompt_tokens_total{engine="0"} 1000.0
vllm:generation_tokens_total{engine="0"} 500.0
vllm:num_requests_running{engine="0"} 2.0
vllm:num_requests_waiting{engine="0"} 1.0
vllm:kv_cache_usage_perc{engine="0"} 0.42
`;

function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}
function textRes(txt, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => txt, json: async () => ({}) };
}

/** Freeze Date.now so counter-diff rates are deterministic. */
function freezeClock(t) {
  const now = 10_000;
  t.mock.method(Date, "now", () => now);
  return now;
}

test("probe reads an OPEN endpoint (no key): available + backend + modelId + telemetry", async (t) => {
  const now = freezeClock(t);
  const probe = new LlmProbe({ lanIp: "192.168.1.173" }, 8888);
  probe.lastProbeTime = now - 2000;
  probe.lastTokenCounts = { input: 1000, output: 500 };
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/slots")) return jsonRes({}, 404);
    if (u.endsWith("/v1/models")) {
      return jsonRes({ data: [{ id: "DeepSeek-V4.1-Flash-UNCENSORED-EXL3", max_model_len: 600000 }] });
    }
    if (u.endsWith("/metrics")) return textRes(VLLM_METRICS.replace("1000.0", "1200.0").replace("500.0", "900.0"));
    if (u.endsWith("/health")) return textRes("", 200);
    if (u.includes("server_info")) return jsonRes({}, 404);
    return jsonRes({}, 404);
  };

  const snap = await probe.probe();
  assert.equal(snap.available, true, "open endpoint must be available");
  assert.equal(snap.reachable, true);
  assert.equal(snap.authGated, false);
  assert.equal(snap.backend, "vllm");
  assert.equal(snap.modelId, "DeepSeek-V4.1-Flash-UNCENSORED-EXL3");
  assert.equal(snap.contextLength, 600000);
  assert.equal(snap.requestsRunning, 2);
  assert.equal(snap.kvCacheUsage, 0.42);
  assert.ok(Math.abs(snap.generationTps - 200) < 2, `generationTps ${snap.generationTps}`);
  assert.equal(snap.error, null);
});

test("probe on a KEYED endpoint without a key: available=false + honest auth error, NOT offline", async () => {
  const probe = new LlmProbe({ lanIp: "192.168.1.246" }, 8889);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) return jsonRes({ detail: "Please provide an API key" }, 401);
    if (u.endsWith("/health")) return jsonRes({ status: "healthy" }, 200);
    return jsonRes({}, 404);
  };

  const snap = await probe.probe();
  assert.equal(snap.available, false, "no key => metrics gated, honestly unavailable");
  assert.equal(snap.reachable, true, "401 still proves the process is up");
  assert.equal(snap.authGated, true);
  assert.match(String(snap.error), /api key required/i);
  assert.equal(snap.errorName, "AuthRequired");
  assert.equal(snap.modelId, null, "never invent a model id");
  // Golden rule: unavailable telemetry is UNKNOWN, never a measured zero.
  assert.equal(snap.generationTps, null, "no fabricated 0 tok/s when unavailable");
  assert.equal(snap.prefillTps, null, "no fabricated 0 prefill when unavailable");
  assert.equal(snap.slotsActive, null);
  assert.equal(snap.slotsTotal, null);
  assert.equal(snap.totalOutputTokens, null);
  assert.notEqual(snap.errorCode, "ECONNREFUSED");

  // Canonical state derivation must agree: gated-but-reachable is not offline.
  const outcome = probeOutcome({ status: 401, hasKey: false });
  assert.equal(outcome.reachable, true);
  assert.equal(outcome.keyedWithoutKey, true);
  assert.equal(isReachableFromProbe({ status: 401 }), true);
  const state = deriveRuntimeState({
    display: "running-external",
    managedBy: "external",
    observed: "auth-gated",
    telemetry: { available: false, error: snap.error },
    reachable: true,
    keyedWithoutKey: true,
  });
  assert.notEqual(state, "offline");
  assert.equal(state, "reachable");
});

test("probe with a WRONG key on a keyed endpoint reports rejection", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.9", llmApiKeys: { "8889": "wrong" } }, 8889);
  probe._fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/models")) return jsonRes({ detail: "bad key" }, 401);
    return jsonRes({}, 404);
  };
  const snap = await probe.probe();
  assert.equal(snap.available, false);
  assert.equal(snap.reachable, true);
  assert.match(String(snap.error), /api key rejected/i);
  assert.equal(snap.errorName, "AuthRejected");
});

test("a genuinely dead endpoint reads unreachable with no auth error", async () => {
  const probe = new LlmProbe({ lanIp: "10.0.0.9" }, 8888);
  probe._fetch = async () => {
    const err = new Error("connect ECONNREFUSED");
    err.code = "ECONNREFUSED";
    throw err;
  };
  const snap = await probe.probe();
  assert.equal(snap.available, false);
  assert.equal(snap.reachable, false);
  assert.equal(snap.authGated, false);
  assert.ok(!/api key/i.test(String(snap.error)), "dead endpoint must not claim auth");
});
