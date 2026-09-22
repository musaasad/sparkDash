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
import { deploymentViews, deploymentDecodeTps, friendlyName, allNodes } from "./fleetModel";
import type { RecipePublic, ModelEntry } from "../../api/types";

function recipe(over: Partial<RecipePublic> = {}): RecipePublic {
  return {
    id: "r1", modelId: "m", name: "R1", runtime: "vllm", topology: "tp2", nodeIds: ["a", "b"],
    modelPath: "/x", workdir: "/x", logDir: null, apiPort: 8888, healthPath: "/v1/models",
    contextLength: 600000, cpuAffinity: null, launcher: null, metadata: {}, notes: "", env: [],
    archived: false, createdAt: 0, updatedAt: 0, ...over,
  } as RecipePublic;
}

describe("council-pass helpers", () => {
  it("friendlyName prefers the registry name", () => {
    const models: ModelEntry[] = [{ id: "m", name: "DeepSeek V4.1 Flash", family: null, notes: "", archived: false, createdAt: 0, updatedAt: 0 }];
    expect(friendlyName("m", models)).toBe("DeepSeek V4.1 Flash");
    expect(friendlyName("unknown", models)).toBe("unknown");
  });

  it("allNodes never drops workers", () => {
    const sparks = [spark({ id: "w", role: "worker", workerNode: true } as never), spark({ id: "h" })];
    expect(allNodes(sparks).map((s) => s.id)).toEqual(["w", "h"]);
  });

  it("deploymentDecodeTps matches llm series by apiPort index only", () => {
    const node = spark({
      id: "a",
      llmPorts: [8888, 8889],
      metrics: {
        ...spark().metrics,
        llm: [
          { available: true, generationTps: 64 } as never,
          { available: true, generationTps: 999 } as never,
        ],
      },
    });
    const d = { ...dep("r1", "running", "m"), nodeIds: ["a"], apiPort: 8888 }; // → index 0
    expect(deploymentDecodeTps([node], d)).toBe(64);
    const wrong = { ...d, apiPort: 7777 };
    expect(deploymentDecodeTps([node], wrong)).toBeNull();
  });

  it("deploymentViews joins recipe, friendly name and member nodes", () => {
    const sparks = [spark({ id: "a", name: "Spark A" }), spark({ id: "b", name: "Spark B", role: "worker" } as never)];
    const models: ModelEntry[] = [{ id: "m", name: "DeepSeek V4.1 Flash", family: null, notes: "", archived: false, createdAt: 0, updatedAt: 0 }];
    const views = deploymentViews(sparks, [{ ...dep("r1", "running"), nodeIds: ["a", "b"] }], [recipe()], models);
    expect(views).toHaveLength(1);
    expect(views[0].modelName).toBe("DeepSeek V4.1 Flash");
    expect(views[0].nodes.map((n) => n.name)).toEqual(["Spark A", "Spark B"]);
    expect(views[0].topology).toBe("tp2");
    expect(views[0].contextLength).toBe(600000);
  });

  it("aggregates unified-memory pressure into one deployment-targeted alert", () => {
    const mk = (id: string, name: string) =>
      spark({ id, name, metrics: { ...spark().metrics, unifiedMemory: { total: 128, used: 120, gpuUsed: 100, cpuUsed: 20, available: 8, percentage: 94, oomRisk: "high", bandwidth: { current: 0, peak: 0 } } } as never });
    const alerts = computeFleetAlerts([mk("a", "Spark A"), mk("b", "Spark B")], [{ ...dep("r1", "running"), nodeIds: ["a", "b"] }]);
    const oom = alerts.filter((x) => x.id === "oom-pressure");
    expect(oom).toHaveLength(1);
    expect(oom[0].message).toContain("Spark A, Spark B");
    expect(oom[0].target).toEqual({ section: "model", modelId: "m" });
  });

  it("surfaces stopped deployments with lastError context", () => {
    const d = { ...dep("r1", "stopped"), lastError: "probe auth failed" };
    const alerts = computeFleetAlerts([], [d]);
    expect(alerts[0].message).toContain("probe auth failed");
    expect(alerts[0].severity).toBe("warn");
  });
});
