/**
 * computeValidate — pre-SAVE validation. CONFIG-ONLY + READ-ONLY.
 * Distinguishes INVALID (blocks) from UNVERIFIED (allowable, confirmable).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sd-compute-val-"));
process.env.SPARKDASH_CONFIG_DIR = ROOT;

const { validateComputeDraft } = await import("../computeValidate.js");

function fakeRegistry(nodes) {
  const store = new Map(nodes.map((n) => [n.id, n]));
  return {
    sparkIds: [...store.keys()],
    getSpark: (id) => store.get(id) || null,
  };
}

const NODES = [
  { id: "dgx-1", name: "DGX 1", lanIp: "192.168.1.161", ssh: { host: "192.168.1.161", user: "musa" } },
];

const offlineFetch = async () => {
  throw new Error("refused");
};

function draft(over = {}) {
  return {
    id: "dgx-4",
    name: "DGX 4",
    kind: "spark",
    lanIp: "192.168.1.164",
    llmPorts: [8891],
    ssh: { host: "192.168.1.164", user: "musa", auth: "key" },
    ...over,
  };
}

const codes = (r) => r.issues.map((i) => i.code);

test("a clean draft has no INVALID issues and ok=true even when unverified", async () => {
  const r = await validateComputeDraft(fakeRegistry(NODES), draft(), { fetchImpl: offlineFetch, discovered: null });
  assert.equal(r.ok, true);
  assert.equal(r.invalidCount, 0);
  // reachability is unverified, never invalid
  assert.ok(codes(r).includes("endpoint-unreachable"));
  assert.ok(r.issues.every((i) => i.severity === "unverified"));
});

test("malformed id and duplicate id are INVALID", async () => {
  const bad = await validateComputeDraft(fakeRegistry(NODES), draft({ id: "bad id!" }), { fetchImpl: offlineFetch });
  assert.equal(bad.ok, false);
  assert.ok(codes(bad).includes("id-malformed"));

  const dup = await validateComputeDraft(fakeRegistry(NODES), draft({ id: "dgx-1" }), { fetchImpl: offlineFetch });
  assert.ok(codes(dup).includes("id-duplicate"));
});

test("duplicate hostname across nodes is INVALID", async () => {
  const r = await validateComputeDraft(fakeRegistry(NODES), draft({ lanIp: "192.168.1.161", ssh: { host: "192.168.1.161", user: "musa" } }), { fetchImpl: offlineFetch });
  assert.ok(codes(r).includes("host-duplicate"));
  assert.equal(r.ok, false);
});

test("missing host and empty ports are reported", async () => {
  const r = await validateComputeDraft(fakeRegistry(NODES), draft({ lanIp: "", ssh: { host: "", user: "musa" }, llmPorts: [] }), { fetchImpl: offlineFetch });
  assert.ok(codes(r).includes("host-missing"));
  assert.ok(codes(r).includes("ports-empty"));
});

test("self fabric link is INVALID; absent peer is UNVERIFIED", async () => {
  const r = await validateComputeDraft(fakeRegistry(NODES), draft({ fabricLinks: [{ to: "dgx-4" }, { to: "ghost" }] }), { fetchImpl: offlineFetch });
  assert.ok(codes(r).includes("fabric-self"));
  assert.ok(codes(r).includes("fabric-missing-peer"));
});

test("provider conflict is UNVERIFIED, not INVALID", async () => {
  const discovered = { sshReachable: true, fields: { gpuChip: { value: "NVIDIA GB10", provenance: "discovered" } } };
  const r = await validateComputeDraft(fakeRegistry(NODES), draft({ kind: "host" }), { fetchImpl: offlineFetch, discovered });
  const conflict = r.issues.find((i) => i.code === "kind-conflict");
  assert.equal(conflict.severity, "unverified");
  assert.equal(r.ok, true);
});

test("does not mutate the registry (config-only)", async () => {
  const reg = fakeRegistry(NODES);
  await validateComputeDraft(reg, draft(), { fetchImpl: offlineFetch });
  assert.deepEqual(reg.sparkIds, ["dgx-1"]);
});

test("update mode excludes self from duplicate checks", async () => {
  const r = await validateComputeDraft(fakeRegistry(NODES), draft({ id: "dgx-1", lanIp: "192.168.1.161" }), { fetchImpl: offlineFetch, selfId: "dgx-1" });
  assert.ok(!codes(r).includes("id-duplicate"));
  assert.ok(!codes(r).includes("host-duplicate"));
});
