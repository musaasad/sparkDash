/**
 * tabbyLogDir config field: normalized, published, and the credential stays in
 * the encrypted store (do NOT re-put it; toPublic never leaks the token).
 *
 * Hermetic: temp sparks.json + encrypted secrets store.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-tabbylog-"));
process.env.SPARKS_JSON_PATH = path.join(TMPDIR, "sparks.json");
process.env.SPARKS_SECRETS_PATH = path.join(TMPDIR, "sparks-secrets.json");
process.env.SECRETS_KEY_PATH = path.join(TMPDIR, ".secrets-key");
process.env.LLM_PORT = "8888";

const { SparkRegistry } = await import("../SparkRegistry.js");
const { saveSecrets } = await import("../../secretsStore.js");

const SPARK_ID = "t";
const KEY_A = "sk-test-aaaa";

function loadRegistry(extra = {}) {
  fs.writeFileSync(
    process.env.SPARKS_JSON_PATH,
    JSON.stringify({
      sparks: [{ id: SPARK_ID, name: "T", lanIp: "127.0.0.1", llmPorts: [8888], ...extra }],
    })
  );
  saveSecrets(new Map(), new Map([[SPARK_ID, { "8888": KEY_A }]]));
  return new SparkRegistry();
}

test("tabbyLogDir is normalized and published on the public snapshot", () => {
  const r = loadRegistry({ tabbyLogDir: "  /home/musaasad/tabbyAPI/logs  " });
  const pub = r.toPublic(r.getSpark(SPARK_ID));
  assert.equal(pub.tabbyLogDir, "/home/musaasad/tabbyAPI/logs");
});

test("absent/empty tabbyLogDir stays null (honest 'no log configured')", () => {
  const r = loadRegistry();
  assert.equal(r.getSpark(SPARK_ID).tabbyLogDir, null);
  assert.equal(r.toPublic(r.getSpark(SPARK_ID)).tabbyLogDir, null);
});

test("tabbyLogDir does NOT leak or touch the credential; key stays out of JSON", () => {
  const r = loadRegistry({ tabbyLogDir: "/home/musaasad/tabbyAPI/logs" });
  const pub = r.toPublic(r.getSpark(SPARK_ID));
  assert.equal(Object.prototype.hasOwnProperty.call(pub, "llmApiKeys"), false);
  assert.deepEqual(pub.llmApiKeyPorts, [8888]);
  const json = JSON.stringify(pub);
  assert.equal(json.includes(KEY_A), false, "token leaked into public snapshot");
  assert.equal(json.includes("tabbyLogDir"), true);
});
