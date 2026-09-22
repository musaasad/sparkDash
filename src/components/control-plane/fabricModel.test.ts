import { describe, it, expect } from "vitest";
import { deriveFabric, fabricLayout, fabricLinkProvenanceLabel } from "./fabricModel";
import type { DeploymentView } from "./fleetModel";
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

function deployment(over: Partial<DeploymentStatus> = {}): DeploymentStatus {
  return {
    deploymentId: "d1",
    recipeId: "r1",
    modelId: "m1",
    nodeIds: ["n1"],
    apiPort: 8888,
    managedBy: "sparkdash",
    dryRun: true,
    state: "running",
    desired: "running",
    observed: "healthy",
    discovered: true,
    display: "running",
    lastOp: null,
    lastError: null,
    startedAt: 1,
    updatedAt: 1,
    ...over,
  } as DeploymentStatus;
}

function view(over: Partial<DeploymentView> = {}): DeploymentView {
  return {
    deployment: deployment(),
    key: "d1",
    recipe: null,
    modelName: "Llama 3",
    rawModelId: "m1",
    nodes: [],
    runtime: "vllm",
    topology: "single",
    lifecycleState: null,
    contextLength: null,
    port: 8888,
    decodeTps: null,
    telemetry: null,
    uptime: null,
    ...over,
  } as DeploymentView;
}

describe("deriveFabric", () => {
  it("describes nodes but draws NO edges when wiring is undiscovered", () => {
    const sparks = [spark({ id: "a", name: "DGX 1" }), spark({ id: "b", name: "DGX 2" }), spark({ id: "c", name: "DGX 3" })];
    const f = deriveFabric(sparks, []);
    expect(f.nodes).toHaveLength(3);
    expect(f.links).toHaveLength(0);
    expect(f.wiringDiscovered).toBe(false);
    // three nodes never become a triangle
    expect(f.nodes.map((n) => n.label)).toEqual(["DGX 1", "DGX 2", "DGX 3"]);
  });

  it("links only nodes sharing a discovered cx7 /24 segment", () => {
    const sparks = [
      spark({ id: "a", cx7Ip: "10.10.0.1", metrics: { ...spark().metrics, network: { primaryInterface: "enP7s7", linkSpeedMbps: 100_000, interfaces: [] } } }),
      spark({ id: "b", cx7Ip: "10.10.0.2" }),
      spark({ id: "c", cx7Ip: "10.99.0.9" }),
    ];
    const f = deriveFabric(sparks, []);
    expect(f.wiringDiscovered).toBe(true);
    expect(f.links).toHaveLength(1);
    expect(f.links[0].kind).toBe("cx7");
    expect(f.links[0].provenance).toBe("discovered");
    expect([f.links[0].from, f.links[0].to].sort()).toEqual(["a", "b"]);
    expect(f.links[0].speedMbps).toBe(100_000);
  });

  it("links nodes sharing a configured fabric id and marks offline links degraded", () => {
    const sparks = [spark({ id: "a", fabric: "rack-1" }), spark({ id: "b", fabric: "rack-1", online: false })];
    const f = deriveFabric(sparks, []);
    expect(f.links).toHaveLength(1);
    expect(f.links[0].kind).toBe("fabric");
    expect(f.links[0].provenance).toBe("discovered");
    expect(f.links[0].degraded).toBe(true);
    expect(f.links[0].speedMbps).toBe(200_000);
    expect(f.nodes.find((n) => n.id === "b")?.health).toBe("offline");
  });

  it("emits CONFIGURED links from fabricLinks with configured provenance + speed", () => {
    const sparks = [
      spark({ id: "a", fabricLinks: [{ to: "b", speedMbps: 200_000, medium: "cx7" }] }),
      spark({ id: "b" }),
      spark({ id: "c" }), // peer-less / no links → no fabricated triangle
    ];
    const f = deriveFabric(sparks, []);
    expect(f.links).toHaveLength(1);
    expect(f.links[0].provenance).toBe("configured");
    expect(f.links[0].kind).toBe("cx7");
    expect(f.links[0].speedMbps).toBe(200_000);
    expect([f.links[0].from, f.links[0].to].sort()).toEqual(["a", "b"]);
    expect(f.wiringDiscovered).toBe(true);
  });

  it("configured beats discovered on the same pair (no duplicate)", () => {
    const sparks = [
      spark({ id: "a", cx7Ip: "10.0.0.1", fabricLinks: [{ to: "b" }] }),
      spark({ id: "b", cx7Ip: "10.0.0.2" }),
    ];
    const f = deriveFabric(sparks, []);
    expect(f.links).toHaveLength(1);
    expect(f.links[0].provenance).toBe("configured");
  });

  it("emits a full configured triangle only from config, for 1..N nodes", () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const ids = [...Array(n).keys()].map((i) => `n${i}`);
      const sparks = ids.map((id) =>
        spark({ id, fabricLinks: ids.filter((o) => o !== id).map((to) => ({ to, speedMbps: 100_000, medium: "cx7" as const })) })
      );
      const f = deriveFabric(sparks, []);
      expect(f.links).toHaveLength((n * (n - 1)) / 2);
      expect(f.links.every((l) => l.provenance === "configured")).toBe(true);
    }
  });

  it("fabricLinks pointing at an absent peer are skipped", () => {
    const sparks = [spark({ id: "a", fabricLinks: [{ to: "ghost" }] })];
    const f = deriveFabric(sparks, []);
    expect(f.links).toHaveLength(0);
    expect(f.wiringDiscovered).toBe(false);
  });

  it("places deployment names on nodes and flags a degraded deployment", () => {
    const sparks = [spark({ id: "a" }), spark({ id: "b" })];
    const views = [view({ deployment: deployment({ nodeIds: ["a"], display: "degraded" }) })];
    const f = deriveFabric(sparks, views);
    expect(f.nodes.find((n) => n.id === "a")?.placedModels).toEqual(["Llama 3"]);
    expect(f.nodes.find((n) => n.id === "a")?.health).toBe("error");
    expect(f.nodes.find((n) => n.id === "b")?.placedModels).toEqual([]);
  });

  it("resolves role and carries discovered link speed", () => {
    const sparks = [spark({ id: "w", role: "worker", workerNode: true, metrics: { ...spark().metrics, network: { primaryInterface: "enP7s7", linkSpeedMbps: 25_000, interfaces: [] } } })];
    const f = deriveFabric(sparks, []);
    expect(f.nodes[0].role).toBe("worker");
    expect(f.nodes[0].linkSpeedMbps).toBe(25_000);
  });
});

describe("fabricLayout", () => {
  it("returns [] for 0 and one position per node for 1..5", () => {
    expect(fabricLayout(0)).toEqual([]);
    for (const n of [1, 2, 3, 4, 5]) expect(fabricLayout(n)).toHaveLength(n);
  });

  it("keeps 1..5 coherent — distinct, deterministic, capped at 2 columns", () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const pos = fabricLayout(n);
      expect(pos.map((p) => `${p.x},${p.y}`).length).toBe(new Set(pos.map((p) => `${p.x},${p.y}`)).size);
      expect(pos.map((p) => p.index)).toEqual([...Array(n).keys()]);
      for (const p of pos) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeGreaterThanOrEqual(0);
      }
      // never more than two nodes share a row
      const rows = new Map<number, number>();
      for (const p of pos) rows.set(p.y, (rows.get(p.y) ?? 0) + 1);
      for (const count of rows.values()) expect(count).toBeLessThanOrEqual(2);
    }
  });
});

describe("fabric link health + provenance label", () => {
  it("link health follows PHYSICAL reachability, never node memory pressure", () => {
    const pressured = spark({
      id: "a",
      metrics: { ...spark().metrics, unifiedMemory: { total: 130000, gpuUsed: 1, cpuUsed: 1, used: 90000, available: 40000, percentage: 69, oomRisk: "high", bandwidth: { current: 0, peak: 0 } } as never },
    });
    const off = spark({ id: "b", online: false });
    off.fabricLinks = [{ to: "a", speedMbps: 200_000, medium: "cx7" }];
    const f = deriveFabric([pressured, off], []);
    expect(f.links[0].health).toBe("warn");
    expect(f.nodes.find((n) => n.id === "a")?.health).toBe("warn");

    // both online, only memory-warned => link stays healthy.
    const healthy = deriveFabric([pressured, spark({ id: "c" })], []);
    expect(healthy.links).toHaveLength(0); // no wiring between them
  });

  it("labels CONFIGURED vs DISCOVERED provenance honestly", () => {
    const configured = [{ provenance: "configured" as const }, { provenance: "configured" as const }];
    const discovered = [{ provenance: "discovered" as const }];
    expect(fabricLinkProvenanceLabel(configured)).toBe("2 LINKS · CONFIGURED");
    expect(fabricLinkProvenanceLabel(discovered)).toBe("1 LINK · DISCOVERED");
    expect(fabricLinkProvenanceLabel([...configured, ...discovered])).toContain("2 CONFIGURED");
    expect(fabricLinkProvenanceLabel([...configured, ...discovered])).toContain("1 DISCOVERED");
    expect(fabricLinkProvenanceLabel([])).toBeNull();
  });
});
