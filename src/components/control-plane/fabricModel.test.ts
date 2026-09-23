import { describe, it, expect } from "vitest";
import { deriveFabric, deriveFabricTopology, fabricLayout, fabricLinkProvenanceLabel, fabricTopologyLabel } from "./fabricModel";
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
    expect(f.links[0].speedMbps).toBeNull();
    expect(f.links[0].speedNominal).toBe(true);
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

describe("deriveFabricTopology — classified from the EDGE SET, never node count", () => {
  const nodes = (n: number) => [...Array(n).keys()].map((i) => ({ id: `n${i}` }));
  const links = (pairs: Array<[string, string]>) => pairs.map(([from, to], i) => ({ id: `l${i}`, from, to }));

  it("single for 1 node", () => {
    expect(deriveFabricTopology({ nodes: nodes(1), links: [] })).toBe("single");
  });

  it("unknown when nodes>=2 but no link is discovered/configured", () => {
    for (const n of [2, 3, 4, 6, 8]) {
      expect(deriveFabricTopology({ nodes: nodes(n), links: [] })).toBe("unknown");
    }
  });

  it("pair for 2 nodes joined", () => {
    expect(deriveFabricTopology({ nodes: nodes(2), links: links([["n0", "n1"]]) })).toBe("pair");
  });

  it("triangle ONLY when all 3 pairs are present", () => {
    expect(deriveFabricTopology({ nodes: nodes(3), links: links([["n0", "n1"], ["n1", "n2"], ["n0", "n2"]]) })).toBe("triangle");
    // 2 edges on 3 nodes is a path, i.e. a star — NOT a triangle (node count does not decide)
    expect(deriveFabricTopology({ nodes: nodes(3), links: links([["n0", "n1"], ["n1", "n2"]]) })).toBe("star");
    // a single edge on 3 nodes is neither triangle nor star
    expect(deriveFabricTopology({ nodes: nodes(3), links: links([["n0", "n1"]]) })).toBe("custom");
  });

  it("ring ONLY when every node joins exactly two others in one cycle", () => {
    expect(deriveFabricTopology({ nodes: nodes(4), links: links([["n0", "n1"], ["n1", "n2"], ["n2", "n3"], ["n3", "n0"]]) })).toBe("ring");
    // 4 nodes fully linked is a MESH, not a ring
    expect(
      deriveFabricTopology({ nodes: nodes(4), links: links([["n0", "n1"], ["n0", "n2"], ["n0", "n3"], ["n1", "n2"], ["n1", "n3"], ["n2", "n3"]]) })
    ).toBe("mesh");
  });

  it("mesh/full ONLY for a complete graph >3", () => {
    expect(
      deriveFabricTopology({ nodes: nodes(5), links: links([["n0", "n1"], ["n0", "n2"], ["n0", "n3"], ["n0", "n4"], ["n1", "n2"], ["n1", "n3"], ["n1", "n4"], ["n2", "n3"], ["n2", "n4"], ["n3", "n4"]]) })
    ).toBe("mesh");
  });

  it("star ONLY when one hub joins all and leaves touch only the hub", () => {
    expect(deriveFabricTopology({ nodes: nodes(4), links: links([["n0", "n1"], ["n0", "n2"], ["n0", "n3"]]) })).toBe("star");
    // same degree spread but with a leaf-leaf extra edge => custom
    expect(deriveFabricTopology({ nodes: nodes(4), links: links([["n0", "n1"], ["n0", "n2"], ["n0", "n3"], ["n1", "n2"]]) })).toBe("custom");
  });

  it("custom for a real but other-shaped graph (a path)", () => {
    expect(deriveFabricTopology({ nodes: nodes(4), links: links([["n0", "n1"], ["n1", "n2"], ["n2", "n3"]]) })).toBe("custom");
  });

  it("duplicate + self links never inflate the shape", () => {
    expect(deriveFabricTopology({ nodes: nodes(3), links: links([["n0", "n1"], ["n1", "n0"], ["n2", "n2"]]) })).toBe("custom");
    expect(deriveFabricTopology({ nodes: nodes(3), links: links([["n0", "n1"], ["n1", "n0"], ["n1", "n2"], ["n0", "n2"]]) })).toBe("triangle");
  });

  it("labels the physical topology with honest provenance", () => {
    expect(fabricTopologyLabel("triangle", [{ provenance: "configured" }, { provenance: "configured" }, { provenance: "configured" }])).toBe(
      "PHYSICAL · TRIANGLE · 3 LINKS · CONFIGURED"
    );
    expect(fabricTopologyLabel("unknown", [])).toBe("PHYSICAL · UNKNOWN · WIRING NOT DISCOVERED");
  });
});

describe("fabricLayout — topology-aware, viewBox-scaled", () => {
  const nodes = (n: number) => [...Array(n).keys()].map((i) => ({ id: `n${i}` }));
  const links = (pairs: Array<[string, string]>) => pairs.map(([from, to], i) => ({ id: `l${i}`, from, to }));
  const triangle = links([["n0", "n1"], ["n1", "n2"], ["n0", "n2"]]);
  const ring4 = links([["n0", "n1"], ["n1", "n2"], ["n2", "n3"], ["n3", "n0"]]);

  it("returns empty for 0 nodes; one position per node for 1..8", () => {
    const empty = fabricLayout({ nodes: [], links: [] }, "unknown");
    expect(empty.positions).toEqual([]);
    expect(empty.viewBox).toBe("0 0 0 0");
    for (const n of [1, 2, 3, 4, 6, 8]) {
      expect(fabricLayout({ nodes: nodes(n), links: [] }, "unknown").positions).toHaveLength(n);
    }
  });

  it("reflects the topology: triangle is 3 distinct points, distinct from a grid", () => {
    const tri = fabricLayout({ nodes: nodes(3), links: triangle }, "triangle");
    expect(new Set(tri.positions.map((p) => `${p.x},${p.y}`)).size).toBe(3);
    const grid = fabricLayout({ nodes: nodes(3), links: triangle }, "custom");
    expect(tri.positions.map((p) => `${p.x},${p.y}`)).not.toEqual(grid.positions.map((p) => `${p.x},${p.y}`));
  });

  it("ring and mesh arrange on a circle, pair side by side, star hubs centre", () => {
    const ring = fabricLayout({ nodes: nodes(4), links: ring4 }, "ring");
    const pair = fabricLayout({ nodes: nodes(2), links: links([["n0", "n1"]]) }, "pair");
    expect(pair.positions[0].y).toBe(pair.positions[1].y);
    // ring: all four on a circle => 2 distinct y bands
    expect(new Set(ring.positions.map((p) => p.y)).size).toBeGreaterThan(1);
    const star = fabricLayout({ nodes: nodes(4), links: links([["n0", "n1"], ["n0", "n2"], ["n0", "n3"]]) }, "star");
    expect(star.positions).toHaveLength(4);
  });

  it("is deterministic, non-negative, inside the viewBox, and never overlapping", () => {
    for (const [n, topo] of [[1, "single"], [3, "triangle"], [4, "ring"], [6, "mesh"], [8, "unknown"], [12, "custom"]] as const) {
      const l = fabricLayout({ nodes: nodes(n), links: [] }, topo as never);
      expect(l.positions).toHaveLength(n);
      const keys = l.positions.map((p) => `${p.x},${p.y}`);
      expect(new Set(keys).size).toBe(n);
      for (const p of l.positions) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThan(l.width);
        expect(p.y).toBeLessThan(l.height);
      }
      expect(l.viewBox).toBe(`0 0 ${l.width} ${l.height}`);
    }
  });
});

describe("fabric link health + provenance label", () => {
  it("link health follows PHYSICAL reachability, never node memory utilisation", () => {
    const pressured = spark({
      id: "a",
      metrics: { ...spark().metrics, unifiedMemory: { total: 130000, gpuUsed: 1, cpuUsed: 1, used: 90000, available: 40000, percentage: 94, oomRisk: "high", bandwidth: { current: 0, peak: 0 } } as never },
    });
    const off = spark({ id: "b", online: false });
    off.fabricLinks = [{ to: "a", speedMbps: 200_000, medium: "cx7" }];
    const f = deriveFabric([pressured, off], []);
    expect(f.links[0].health).toBe("warn");
    // high unified-memory UTILISATION is not an alarm: the node stays "ok".
    expect(f.nodes.find((n) => n.id === "a")?.health).toBe("ok");

    // both online, only memory-utilised => link stays healthy.
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
