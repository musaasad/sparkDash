import { describe, it, expect } from "vitest";
import { computeFleetHealth, computeFleetAlerts } from "./fleetModel";
import type { SparkSnapshot, DeploymentStatus } from "../../api/types";

function spark(over: Partial<SparkSnapshot> = {}): SparkSnapshot {
  return {
    id: "n1",
    name: "Node 1",
    online: true,
    uptime: 100,
    disabledDevices: [],
    disabledInterfaces: [],
    llmPort: 8888,
    llmPorts: [8888],
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
    },
    ...over,
  } as SparkSnapshot;
}

function dep(recipeId: string, state: DeploymentStatus["state"], modelId = "m"): DeploymentStatus {
  return { recipeId, modelId, nodeIds: ["n1"], apiPort: 8889, managedBy: "sparkdash", dryRun: true, state, lastOp: null, lastError: null, startedAt: null, updatedAt: 0 };
}

describe("fleetModel", () => {
  it("rolls up node/model/alert counts and fleet throughput", () => {
    const sparks = [
      spark({ id: "a", metrics: { ...spark().metrics, llm: [{ available: true, generationTps: 60 } as never] } }),
      spark({ id: "b", online: false }),
    ];
    const h = computeFleetHealth(sparks, [dep("r1", "running"), dep("r2", "loading"), dep("r3", "error")]);
    expect(h.nodesOnline).toBe(1);
    expect(h.nodesTotal).toBe(2);
    expect(h.modelsRunning).toBe(1);
    expect(h.modelsLoading).toBe(1);
    expect(h.fleetDecodeTps).toBe(60);
    expect(h.activeAlerts).toBeGreaterThanOrEqual(2); // offline node + error deployment
  });

  it("flags offline nodes, thermal throttle and full disks", () => {
    const sparks = [
      spark({ id: "off", online: false }),
      spark({
        id: "hot",
        metrics: {
          ...spark().metrics,
          gpu: { temperature: 95, usage: 50, power: { draw: 100, limit: 200 }, vram: { used: 1, total: 2, percentage: 50, available: 1 }, throttle: { thermal: true, hwSlowdown: false, powerCap: false, active: true, reason: "thermal", smClockMHz: null, smClockMaxMHz: null, smClockPct: null, detail: "" } } as never,
          storage: [{ device: "/dev/nvme0", label: "root", used: 95, total: 100, available: 5, percentage: 95, readSpeed: 0, writeSpeed: 0 }] as never,
        },
      }),
    ];
    const ids = computeFleetAlerts(sparks, []).map((a) => a.id);
    expect(ids).toContain("off-offline");
    expect(ids).toContain("hot-throttle");
    expect(ids).toContain("hot-temp");
    expect(ids).toContain("hot-disk-/dev/nvme0");
  });

  it("ignores disabled disks", () => {
    const sparks = [
      spark({
        id: "n",
        metrics: {
          ...spark().metrics,
          storage: [{ device: "/dev/sda", label: "backup", used: 99, total: 100, available: 1, percentage: 99, readSpeed: 0, writeSpeed: 0, disabled: true }] as never,
        },
      }),
    ];
    expect(computeFleetAlerts(sparks, [])).toHaveLength(0);
  });
});