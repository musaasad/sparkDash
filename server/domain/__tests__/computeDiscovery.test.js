/**
 * ComputeDiscoveryService — BOUNDED, READ-ONLY, EXPLAINABLE.
 * Hermetic: temp SPARKDASH_CONFIG_DIR, mocked sshExec + fetch, no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sd-compute-disc-"));
process.env.SPARKDASH_CONFIG_DIR = ROOT;

const { ComputeDiscoveryService, READONLY_FACTS_CMD } = await import("../computeDiscovery.js");

/** 9 sections joined by `---` (8 separators), matching READONLY_FACTS_CMD. */
const FACTS = [
  "dgx-4",
  "NVIDIA GB10, 580.173.02, 121000",
  "model name : NVIDIA GB10",
  "20",
  "MemTotal:       126000000 kB",
  "aarch64",
  "Linux 6.17.0-1031-nvidia",
  "123 vllm serve /models/x\n124 llama-server",
  "2: enp1s0f0np0    inet 10.100.208.4/24\n3: eno1    inet 192.168.1.200/24",
].join("\n---\n");

function fakeRegistry(nodes) {
  const store = new Map(nodes.map((n) => [n.id, n]));
  return {
    sparkIds: [...store.keys()],
    getSpark: (id) => store.get(id) || null,
  };
}

function okFetch(body = { data: [{ id: "some-model" }] }) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

const NODES = [
  { id: "dgx-1", name: "DGX 1", kind: "spark", lanIp: "192.168.1.161", cx7Ip: "10.10.0.1", fabric: "rack-a", llmPorts: [8888] },
  { id: "dgx-2", name: "DGX 2", kind: "spark", lanIp: "192.168.1.162", cx7Ip: "10.10.0.2", fabric: "rack-a", llmPorts: [8889] },
];

test("discovers only what answered; every field carries provenance", async () => {
  const reg = fakeRegistry(NODES);
  const svc = new ComputeDiscoveryService({
    sparkRegistry: reg,
    sshExecFn: async (_spark, cmd) => {
      assert.equal(cmd, READONLY_FACTS_CMD);
      return FACTS;
    },
    fetchImpl: okFetch(),
  });

  const r = await svc.discover({ host: "192.168.1.200", port: 8888, sshUser: "musa" });
  assert.equal(r.reachable, true);
  assert.equal(r.sshReachable, true);
  assert.equal(r.fields.hostname.value, "dgx-4");
  assert.equal(r.fields.hostname.provenance, "discovered");
  assert.equal(r.fields.gpuChip.value, "NVIDIA GB10");
  assert.equal(r.fields.gpuMemoryGB.value, 118);
  assert.equal(r.fields.memoryGB.value, 120);
  assert.equal(r.fields.cpuCores.value, 20);
  assert.equal(r.fields.arch.value, "aarch64");
  assert.equal(r.fields.processes.value.length, 2);
  assert.equal(r.fields.interfaces.value.length, 2);
  assert.equal(r.endpoints[0].reachable, true);
  assert.equal(r.endpoints[0].servedModelIds[0], "some-model");
  assert.ok(r.steps.some((s) => s.includes("read-only")));
});

test("unreachable host degrades gracefully — UNKNOWN, never fabricated", async () => {
  const svc = new ComputeDiscoveryService({
    sparkRegistry: fakeRegistry([]),
    sshExecFn: async () => {
      throw new Error("ssh timeout");
    },
    fetchImpl: async () => {
      throw new Error("refused");
    },
  });
  const r = await svc.discover({ host: "10.9.9.9", port: 8888 });
  assert.equal(r.reachable, false);
  assert.equal(r.sshReachable, false);
  assert.equal(r.fields.hostname.value, null);
  assert.equal(r.fields.hostname.provenance, "unknown");
  assert.equal(r.endpoints.length, 1);
  assert.equal(r.endpoints[0].provenance, "unknown");
  assert.deepEqual(r.endpoints[0].servedModelIds, []);
});

test("a known configured node contributes CONFIGURED identity, not observed guesses", async () => {
  const svc = new ComputeDiscoveryService({
    sparkRegistry: fakeRegistry(NODES),
    sshExecFn: async () => {
      throw new Error("offline");
    },
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  const r = await svc.discover({ host: "192.168.1.161" });
  assert.equal(r.knownNodeId, "dgx-1");
  assert.equal(r.hostProvenance, "configured");
  assert.equal(r.fields.hostname.provenance, "configured");
  assert.equal(r.fields.cx7Ip.value, "10.10.0.1");
});

test("ports are bounded to typed port + known node llmPorts (no sweep)", async () => {
  const seen = [];
  const svc = new ComputeDiscoveryService({
    sparkRegistry: fakeRegistry(NODES),
    sshExecFn: async () => {
      throw new Error("offline");
    },
    fetchImpl: async (url) => {
      seen.push(url);
      return { ok: false, status: 503, json: async () => ({}) };
    },
  });
  const r = await svc.discover({ host: "192.168.1.162", port: 9999 });
  assert.deepEqual(r.endpoints.map((e) => e.port).sort((a, b) => a - b), [8889, 9999]);
  assert.equal(seen.length, 2);
});

test("fabricIp is INFERRED from an overlapping subnet, and marked inferred", async () => {
  const svc = new ComputeDiscoveryService({
    sparkRegistry: fakeRegistry(NODES),
    sshExecFn: async () =>
      [
        "dgx-4", "", "", "", "", "", "", "",
        "2: enp1s0f0np0    inet 10.10.0.44/24",
      ].join("\n---\n"),
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  const r = await svc.discover({ host: "192.168.1.200" });
  assert.equal(r.fields.fabricIp.provenance, "inferred");
});

test("host is required", async () => {
  const svc = new ComputeDiscoveryService({});
  await assert.rejects(() => svc.discover({}), /host is required/);
});

test("cred ref splits: port ref → endpoint bearer, bare ref → ssh password", async () => {
  let seenHeaders = null;
  let seenSshPassword = null;
  const svc = new ComputeDiscoveryService({
    sparkRegistry: fakeRegistry([]),
    credResolver: (ref) => (ref === "spark:dgx-1:8888" ? "sk-key" : "pw"),
    sshExecFn: async (spark) => {
      seenSshPassword = spark.ssh.password ?? null;
      return FACTS;
    },
    fetchImpl: async (_url, init) => {
      seenHeaders = init.headers;
      throw new Error("refused");
    },
  });

  await svc.discover({ host: "10.0.0.9", port: 8888, sshAuth: "pass", credRef: "spark:dgx-1:8888" });
  assert.equal(seenHeaders.Authorization, "Bearer sk-key");
  // port ref is an LLM key, not the ssh password
  assert.equal(seenSshPassword, null);

  seenHeaders = null;
  seenSshPassword = null;
  await svc.discover({ host: "10.0.0.9", port: 8888, sshAuth: "pass", credRef: "spark:dgx-1" });
  assert.equal(seenSshPassword, "pw");
  assert.equal(seenHeaders.Authorization, undefined);
});
