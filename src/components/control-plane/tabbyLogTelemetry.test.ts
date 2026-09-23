/**
 * TabbyAPI log-tail telemetry reaches the deployment readout with provenance +
 * timestamp, and drives honest state (BUSY when in flight, IDLE when only
 * recent history, STALE when historical). Missing => null, never 0.
 */
import { describe, it, expect } from "vitest";
import { deploymentTelemetry, deriveRuntimeState } from "./fleetModel";
import type { DeploymentStatus, LlmMetrics, SparkSnapshot } from "../../api/types";

function spark(over: Partial<SparkSnapshot> = {}): SparkSnapshot {
  return {
    id: "dgx-3",
    name: "DGX Spark 3",
    online: true,
    uptime: 100,
    disabledDevices: [],
    disabledInterfaces: [],
    llmPort: 8889,
    llmPorts: [8889],
    hardware: { device: "x", cpuModel: "x", cpuCores: 0, totalMemoryGB: 0, gpuChip: "x", cudaDriver: null, storageModel: null },
    metrics: {
      gpu: null,
      cpu: null,
      ram: null,
      storage: [],
      network: null,
      unifiedMemory: null,
      llm: [],
      comfy: null,
      tailscale: null,
      tabbyLog: null,
    },
    updatedAt: { llm: Date.now() },
    ...over,
  } as SparkSnapshot;
}

function llm(over: Partial<LlmMetrics> = {}): LlmMetrics {
  return {
    available: true,
    backend: "tabbyapi",
    modelId: "Qwen3.8-Flash-Next-EXL3",
    modelPath: null,
    contextLength: 262144,
    gpuMemoryUtilization: null,
    slotsActive: null,
    slotsTotal: 4,
    generationTps: null,
    prefillTps: null,
    totalOutputTokens: null,
    kvCacheUsage: null,
    requestsRunning: null,
    requestsWaiting: null,
    ttftP95Seconds: null,
    ttftSeconds: null,
    preemptionsTotal: null,
    prefixCacheHitRate: null,
    e2eP95Seconds: null,
    itlP95Seconds: null,
    mtpAcceptanceRate: null,
    posture: null,
    error: null,
    ...over,
  } as LlmMetrics;
}

function dep(): DeploymentStatus {
  return {
    recipeId: "qwen38-tabbyapi-dgx3",
    modelId: "qwen38",
    nodeIds: ["dgx-3"],
    apiPort: 8889,
    managedBy: "external",
    dryRun: false,
    state: "running",
    desired: "running",
    observed: "running",
    discovered: true,
    display: "running-external",
    lastOp: null,
    lastError: null,
    startedAt: null,
    updatedAt: 0,
  };
}

describe("tabbyapi log telemetry", () => {
  it("surfaces real last-request values with provenance + timestamp", () => {
    const at = Date.now() - 1000;
    const s = spark({
      metrics: {
        ...spark().metrics,
        llm: [
          llm({
            generationTps: 59.9,
            prefillTps: 420,
            ttftSeconds: 6.34,
            prefixCacheHitRate: 0.99,
            mtpAcceptanceRate: 0.61,
            requestActive: true,
            requestsRunning: 1,
            slotsActive: 1,
            lastRequestAtMs: at,
            provenance: "TabbyAPI log (2026-09-20_23-11-54_537787.log)",
            windowAvgTps: 54.95,
            peakTps: 59.9,
          }),
        ],
      },
    });
    const t = deploymentTelemetry([s], dep());
    expect(t).not.toBeNull();
    expect(t!.generationTps).toBe(60); // SUM-rounded
    expect(t!.prefixCacheHitRate).toBe(0.99);
    expect(t!.mtpAcceptanceRate).toBe(0.61);
    expect(t!.lastRequestAtMs).toBe(at);
    expect(t!.requestActive).toBe(true);
    expect(t!.provenance).toContain("TabbyAPI log");
    expect(t!.perfStale).toBe(false);
    expect(t!.slotsTotal).toBe(4);
  });

  it("active in-flight => BUSY, never READY/no-traffic", () => {
    const s = spark({
      metrics: { ...spark().metrics, llm: [llm({ requestActive: true, requestsRunning: 1, generationTps: 59.9, lastRequestAtMs: Date.now() })] },
    });
    const t = deploymentTelemetry([s], dep());
    expect(deriveRuntimeState(dep(), t, { reachable: true })).toBe("busy");
  });

  it("recent completion, nothing in flight => IDLE", () => {
    const s = spark({
      metrics: { ...spark().metrics, llm: [llm({ requestActive: false, requestsRunning: 0, generationTps: 59.9, perfFromLastRequest: true, lastRequestAtMs: Date.now() })] },
    });
    const t = deploymentTelemetry([s], dep());
    expect(deriveRuntimeState(dep(), t, { reachable: true })).toBe("idle");
  });

  it("stale historical perf => idle + STALE-safe state, still reachable", () => {
    const s = spark({
      metrics: { ...spark().metrics, llm: [llm({ perfStale: true, perfFromLastRequest: true, requestActive: false, generationTps: 12, lastRequestAtMs: Date.now() - 10 * 60_000 })] },
    });
    const t = deploymentTelemetry([s], dep());
    const state = deriveRuntimeState(dep(), t, { reachable: true, telemetryAgeMs: t!.telemetryAgeMs });
    expect(state).toBe("idle");
    expect(state).not.toBe("serving");
    expect(state).not.toBe("offline");
  });

  it("no log numbers => null, never a fabricated 0", () => {
    const s = spark({ metrics: { ...spark().metrics, llm: [llm()] } });
    const t = deploymentTelemetry([s], dep());
    expect(t!.generationTps).toBeNull();
    expect(t!.prefillTps).toBeNull();
    expect(t!.lastRequestAtMs).toBeNull();
    expect(t!.provenance).toBeNull();
    expect(t!.requestActive).toBeNull();
  });
});
