/**
 * SparkMonitor integration for the READ-ONLY TabbyAPI log-tail probe.
 *
 * Hermetic: the probe is monkeypatched with fixture log text; no SSH/timers.
 */
import test from "node:test";
import { strict as assert } from "node:assert";
import { SparkMonitor } from "../SparkMonitor.js";
import { parseTabbyLog } from "../../collectors/TabbyLogProbe.js";

const COMPLETION =
  "2026-09-23 08:43:06.141 | INFO     | #67897 chat/completions (stream): 1,893 tokens generated at 59.9 T/s · prompt 191,844 tokens, 99% cached, 2,660 new in 6.33 s (420 T/s) · first token 6.34 s, total 37.9 s · draft 1269/2077 accepted (61%)";
const START =
  "2026-09-23 08:43:00.000 | INFO     | #67897 chat/completions (stream): 191,844 tokens · temperature: 0.8 (preset)";
const START_OPEN =
  "2026-09-23 08:43:10.500 | INFO     | #67898 chat/completions (stream): 12,000 tokens · temperature: 0.8 (preset)";

function tabbyEntry() {
  return {
    available: true,
    backend: "tabbyapi",
    modelId: "Qwen3.8-Flash-Next-EXL3",
    slotsTotal: 4,
    generationTps: null,
    prefillTps: null,
    requestsRunning: null,
    slotsActive: null,
    prefixCacheHitRate: null,
    mtpAcceptanceRate: null,
    totalOutputTokens: null,
  };
}

function monitor(spark) {
  const m = new SparkMonitor({ id: "dgx-3", name: "DGX 3", lanIp: "192.168.1.246", llmPorts: [8889], ...spark });
  m._running = true;
  return m;
}

test("absent tabbyLogDir => no probe + honest snapshot state", () => {
  const m = monitor({});
  assert.equal(m.tabbyLogProbe, null);
  assert.equal(m._tabbyLogEnabled(), false);
  const snap = m.snapshot();
  assert.equal(snap.tabbyLogMonitoring, false);
  assert.equal(snap.tabbyLogDir, null);
  assert.equal(snap.metrics.tabbyLog, null);
});

test("configured tabbyLogDir => probe exists, snapshot publishes dir (not secret)", () => {
  const m = monitor({ tabbyLogDir: "/home/musaasad/tabbyAPI/logs" });
  assert.ok(m.tabbyLogProbe);
  const snap = m.snapshot();
  assert.equal(snap.tabbyLogMonitoring, true);
  assert.equal(snap.tabbyLogDir, "/home/musaasad/tabbyAPI/logs");
  // No llmApiKeys object leaked onto the snapshot (token stays in the store).
  assert.equal(Object.prototype.hasOwnProperty.call(snap, "llmApiKeys"), false);
});

test("tabbyLog poll merges REAL log metrics onto the tabbyapi llm entry", async () => {
  const m = monitor({ tabbyLogDir: "/tmp/logs" });
  m.tabbyLogProbe.probe = async () => ({
    configured: true,
    available: true,
    dir: "/tmp/logs",
    file: "2026-09-20_23-11-54_537787.log",
    error: null,
    collectedAt: Date.now(),
    ...parseTabbyLog([START, COMPLETION, START_OPEN].join("\n")),
  });
  m._metrics.llm = [tabbyEntry()];

  await m._pollDomain("tabbyLog");

  const entry = m._metrics.llm[0];
  assert.equal(entry.generationTps, 59.9);
  assert.equal(entry.prefillTps, 420);
  assert.equal(entry.ttftSeconds, 6.34);
  assert.equal(entry.prefixCacheHitRate, 0.99);
  assert.equal(entry.slotsActive, 1);
  assert.equal(entry.slotsTotal, 4);
  assert.match(entry.provenance, /^TabbyAPI log \(/);
  assert.ok(entry.lastRequestAtMs);

  const snap = m.snapshot();
  assert.equal(snap.metrics.tabbyLog.available, true);
  assert.equal(snap.metrics.tabbyLog.file, "2026-09-20_23-11-54_537787.log");
});

test("failed tail leaves the entry honest (null perf, no provenance)", async () => {
  const m = monitor({ tabbyLogDir: "/tmp/logs" });
  m.tabbyLogProbe.probe = async () => ({
    configured: true,
    available: false,
    dir: "/tmp/logs",
    file: null,
    error: "SSH refused",
    collectedAt: Date.now(),
    ...parseTabbyLog(""),
  });
  m._metrics.llm = [tabbyEntry()];
  await m._pollDomain("tabbyLog");
  assert.equal(m._metrics.llm[0].generationTps, null);
  assert.equal(m._metrics.llm[0].provenance, undefined); // untouched via applyTabbyLog only when available
});
