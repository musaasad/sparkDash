/**
 * Committed compute seed: 3 DGX nodes + the CONFIGURED fabric triangle, loaded
 * read-only and never touching the live gitignored config/sparks.json.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sd-seed-"));
process.env.SPARKDASH_CONFIG_DIR = ROOT;

const { loadComputeSeed, seedComputeNodes, COMPUTE_SEED_PATH } = await import("../computeSeed.js");

test("compute seed carries 3 nodes and a configured fabric triangle", () => {
  const seed = loadComputeSeed();
  assert.equal(seed.nodes.length, 3);
  assert.deepEqual(seed.nodes.map((n) => n.id).sort(), ["dgx-1", "dgx-2", "dgx-3"]);

  const edges = seed.nodes.flatMap((n) => (n.fabricLinks || []).map((l) => [n.id, l.to].sort().join("~")));
  assert.deepEqual([...new Set(edges)].sort(), ["dgx-1~dgx-2", "dgx-1~dgx-3", "dgx-2~dgx-3"]);
  for (const n of seed.nodes) {
    for (const l of n.fabricLinks) {
      assert.equal(typeof l.speedMbps, "number");
      assert.ok(l.speedMbps > 0);
      assert.ok(["cx7", "fabric"].includes(l.medium));
    }
  }
});

test("seed loader returns empty (not throwing) on a bad path", () => {
  assert.deepEqual(loadComputeSeed(path.join(ROOT, "missing.json")).nodes, []);
});

test("seedComputeNodes seeds only an EMPTY registry and is idempotent", () => {
  const store = [];
  const fake = {
    get sparks() {
      return store.map((s) => ({ ...s }));
    },
    getSpark: (id) => store.find((s) => s.id === id) || null,
    addSpark: (c) => {
      store.push({ ...c });
      return c;
    },
  };
  assert.equal(seedComputeNodes(fake), 3);
  assert.equal(store.length, 3);
  assert.equal(seedComputeNodes(fake), 0); // not empty anymore

  // a non-empty (live) registry is never rewritten
  const live = { sparks: [{ id: "real-1" }], getSpark: (id) => (id === "real-1" ? {} : null), addSpark: () => assert.fail("must not add") };
  assert.equal(seedComputeNodes(live), 0);
});

test("seed file is committed inside server/seeds", () => {
  assert.ok(COMPUTE_SEED_PATH.endsWith(path.join("server", "seeds", "compute.json")));
  assert.ok(fs.existsSync(COMPUTE_SEED_PATH));
});
