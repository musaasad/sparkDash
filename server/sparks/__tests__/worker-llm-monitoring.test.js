/**
 * P0 TRUTH-DEFECT: a worker node with an explicit `llmMonitoring` opt-in must
 * own an LlmProbe so its (worker-hosted) open endpoint is observable, instead
 * of being silently unobserved. Defaults stay worker-off.
 *
 * Hermetic: no network — the probe is never awaited.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { SparkRegistry } from "../SparkRegistry.js";
import { SparkMonitor } from "../SparkMonitor.js";
import { llmMonitoringEnabled } from "../../../src/shared/runtimeState.js";

const r = Object.create(SparkRegistry.prototype);
const n = (partial) => r._normalizeConfig({ id: "w1", name: "W1", lanIp: "10.0.0.7", ...partial });

test("worker default stays llmMonitoring=false", () => {
  assert.equal(n({ role: "worker" }).llmMonitoring, false);
});

test("worker with an EXPLICIT llmMonitoring opt-in is honoured", () => {
  assert.equal(n({ role: "worker", llmMonitoring: true }).llmMonitoring, true);
});

test("explicit llmMonitoring=false wins for head/standalone", () => {
  assert.equal(n({ role: "head", llmMonitoring: false }).llmMonitoring, false);
  assert.equal(n({ role: "standalone", llmMonitoring: false }).llmMonitoring, false);
});

test("head always on; standalone defaults on", () => {
  assert.equal(n({ role: "head" }).llmMonitoring, true);
  assert.equal(n({ role: "standalone" }).llmMonitoring, true);
});

test("shared canonical rule agrees with the registry + monitor", () => {
  const workerOptIn = { role: "worker", workerNode: true, llmMonitoring: true };
  assert.equal(llmMonitoringEnabled(workerOptIn), true);
  assert.equal(llmMonitoringEnabled({ role: "worker", workerNode: true }), false);
  assert.equal(llmMonitoringEnabled({ role: "head", llmMonitoring: false }), false);

  const monitor = new SparkMonitor(workerOptIn);
  assert.equal(monitor._llmMonitoringEnabled(), true);
  assert.deepEqual([...monitor.llmProbes.keys()], [8888]);

  // Snapshot must publish the ports so the worker telemetry is observable.
  const snap = monitor.snapshot();
  assert.deepEqual(snap.llmPorts, [8888]);
  assert.equal(snap.llmMonitoring, true);

  // A default worker still owns no probe.
  const defaultWorker = new SparkMonitor({ role: "worker", workerNode: true, id: "w2", name: "W2", lanIp: "10.0.0.8" });
  assert.equal(defaultWorker.llmProbes.size, 0);
  assert.deepEqual(defaultWorker.snapshot().llmPorts, []);
});
