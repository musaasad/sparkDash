/**
 * toPublic must strip LLM API key material — including after a port reorder /
 * rename (multi-port shape). The public snapshot is what reaches the client,
 * so a leak here would expose secrets.
 *
 * Hermetic: temp sparks.json + encrypted secrets store, synthetic keys only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-topublic-"));
process.env.SPARKS_JSON_PATH = path.join(TMPDIR, "sparks.json");
process.env.SPARKS_SECRETS_PATH = path.join(TMPDIR, "sparks-secrets.json");
process.env.SECRETS_KEY_PATH = path.join(TMPDIR, ".secrets-key");
process.env.LLM_PORT = "8888";

const { SparkRegistry } = await import("../SparkRegistry.js");
const { saveSecrets } = await import("../../secretsStore.js");

const SPARK_ID = "t";
const KEY_A = "sk-test-aaaa";
const KEY_B = "sk-test-bbbb";

function loadRegistry() {
  fs.writeFileSync(
    process.env.SPARKS_JSON_PATH,
    JSON.stringify({
      sparks: [{ id: SPARK_ID, name: "T", lanIp: "127.0.0.1", llmPorts: [8888, 8889] }],
    })
  );
  saveSecrets(
    new Map(),
    new Map([[SPARK_ID, { "8888": KEY_A, "8889": KEY_B }]])
  );
  return new SparkRegistry();
}

test("toPublic strips llmApiKeys on a multi-port spark", () => {
  const r = loadRegistry();
  const pub = r.toPublic(r.getSpark(SPARK_ID));
  assert.equal(Object.prototype.hasOwnProperty.call(pub, "llmApiKeys"), false);
  assert.deepEqual(pub.llmApiKeyPorts, [8888, 8889]);
  const json = JSON.stringify(pub);
  assert.equal(json.includes(KEY_A), false, "keyA leaked into public snapshot");
  assert.equal(json.includes(KEY_B), false, "keyB leaked into public snapshot");
});

test("toPublic stays clean after a port reorder/rename", () => {
  const r = loadRegistry();
  // rename 8888 -> 8890 beside the existing 8889 (a move), then reorder.
  r.syncLlmApiKeysToPorts(SPARK_ID, [8888, 8889], [8889, 8890]);
  r.syncLlmApiKeysToPorts(SPARK_ID, [8889, 8890], [8890, 8889]);

  assert.deepEqual(r.llmApiKeyPorts(SPARK_ID).sort((a, b) => a - b), [8889, 8890]);
  const pub = r.toPublic(r.getSpark(SPARK_ID));
  assert.equal(Object.prototype.hasOwnProperty.call(pub, "llmApiKeys"), false);
  const json = JSON.stringify(pub);
  assert.equal(json.includes(KEY_A), false, "keyA leaked after reorder");
  assert.equal(json.includes(KEY_B), false, "keyB leaked after reorder");
  assert.equal(r.hasLlmApiKey(SPARK_ID, 8889), true);
  assert.equal(r.hasLlmApiKey(SPARK_ID, 8890), true);
});
