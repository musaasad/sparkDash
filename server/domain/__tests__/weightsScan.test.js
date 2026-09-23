/**
 * WeightsScanService — bounded, read-only, hermetic.
 * Fixture temp dirs only; no real FS sweep, no network, no config touch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { WeightsScanService, isWeightFile } = await import("../weightsScan.js");

const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), "sd-weights-"));
const touch = (dir, name, bytes = 10) => {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, "x".repeat(bytes));
  return p;
};

test("no configured dir → honest empty state, configured:false (never fake success)", async () => {
  const svc = new WeightsScanService({ getConfiguredDirs: () => [] });
  const r = await svc.scan();
  assert.equal(r.configured, false);
  assert.deepEqual(r.matches, []);
  assert.ok(r.steps.some((s) => s.includes("no configured weight directory")));
  assert.equal(r.readOnly, true);
});

test("scans configured dir, matches weight suffixes, keeps provenance, ignores unrelated files", async () => {
  const dir = fixture();
  touch(dir, "model.gguf", 100);
  touch(dir, "model-00001-of-00002.safetensors");
  touch(dir, "model.safetensors.index.json");
  touch(dir, "notes.txt");
  const svc = new WeightsScanService({ getConfiguredDirs: () => [dir] });

  const r = await svc.scan();
  assert.equal(r.configured, true);
  const names = r.matches.map((m) => m.name).sort();
  assert.deepEqual(names, ["model-00001-of-00002.safetensors", "model.gguf", "model.safetensors.index.json"]);
  assert.equal(r.matches.every((m) => m.provenance === "configured"), true);
  assert.equal(r.matches.find((m) => m.name === "model.gguf").sizeBytes, 100);
  assert.ok(r.matches.every((m) => m.path.startsWith("/")));
  assert.ok(r.steps.some((s) => s.includes("read-only")));
});

test("descends ONE bounded level into subdirectories (shards)", async () => {
  const root = fixture();
  touch(path.join(root, "qwen-exl3"), "shard-00001.safetensors");
  const svc = new WeightsScanService({ getConfiguredDirs: () => [root] });
  const r = await svc.scan();
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].name, "shard-00001.safetensors");
  assert.equal(r.matches[0].dir, path.join(root, "qwen-exl3"));
});

test("a configured weightPath pointing at a FILE is reported directly", async () => {
  const file = touch(fixture(), "direct.bin");
  const svc = new WeightsScanService({ getConfiguredDirs: () => [file] });
  const r = await svc.scan();
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].path, file);
});

test("missing dir degrades gracefully — reported missing, never fabricated", async () => {
  const svc = new WeightsScanService({ getConfiguredDirs: () => ["/definitely/not/here-xyz"] });
  const r = await svc.scan();
  assert.equal(r.configured, true);
  assert.deepEqual(r.matches, []);
  assert.deepEqual(r.missingDirs, ["/definitely/not/here-xyz"]);
  assert.ok(r.notes.some((n) => n.includes("not readable")));
});

test("operator-typed dirs are bounded, absolute-only, provenance 'user'", async () => {
  const dir = fixture();
  touch(dir, "extra.safetensors");
  const svc = new WeightsScanService({ getConfiguredDirs: () => [] });
  const r = await svc.scan({ dirs: [dir, "relative/path", ...Array.from({ length: 12 }, (_, i) => `/m/${i}`)] });
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].provenance, "user");
  assert.ok(r.scannedDirs.length <= 8);
});

test("bounds matches and flags truncation on a wide directory", async () => {
  const dir = fixture();
  for (let i = 0; i < 260; i++) touch(dir, `m-${String(i).padStart(4, "0")}.gguf`);
  const svc = new WeightsScanService({ getConfiguredDirs: () => [dir] });
  const r = await svc.scan();
  assert.ok(r.matches.length <= 200);
  assert.equal(r.truncated, true);
});

test("isWeightFile recognises weight artifacts, rejects text", () => {
  assert.equal(isWeightFile("a.gguf"), true);
  assert.equal(isWeightFile("a.safetensors"), true);
  assert.equal(isWeightFile("a.safetensors.index.json"), true);
  assert.equal(isWeightFile("a.txt"), false);
});
