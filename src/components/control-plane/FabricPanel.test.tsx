import { describe, expect, it } from "vitest";
import type { DeploymentStatus, RecipePublic, SparkSnapshot } from "../../api/types";
import type { DeploymentView } from "./fleetModel";
import { FabricPanel } from "./FabricPanel";
import { render, cleanupRenders } from "../../testing/render";

function view(modelName: string, nodeId = "n1"): DeploymentView {
  const d = { recipeId: "r1", modelId: "m1", nodeIds: [nodeId], apiPort: 8889, display: "running" } as DeploymentStatus;
  return {
    deployment: d,
    key: "r1",
    recipe: null as RecipePublic | null,
    modelName,
    rawModelId: d.modelId,
    nodes: [spark({ id: nodeId })],
    runtime: "tabbyapi",
    topology: "single",
    lifecycleState: null,
    contextLength: 32000,
    port: d.apiPort,
    decodeTps: null,
    telemetry: null,
    uptime: null,
  };
}

function spark(over: Partial<SparkSnapshot> = {}): SparkSnapshot {
  return {
    id: "n1", name: "Node 1", online: true, uptime: 100, disabledDevices: [], disabledInterfaces: [],
    llmPort: 8888, llmPorts: [8888],
    hardware: { device: "x", cpuModel: "x", cpuCores: 8, totalMemoryGB: 128, gpuChip: "GB10", cudaDriver: null, storageModel: null },
    metrics: { gpu: null, cpu: null, ram: null, storage: [], network: null, unifiedMemory: null, llm: [], comfy: null, tailscale: null },
    ...over,
  } as SparkSnapshot;
}

describe("FabricPanel honesty", () => {
  it("draws NO edges and says wiring is not discovered when nothing shares a fabric", () => {
    cleanupRenders();
    const nodes = [spark({ id: "a" }), spark({ id: "b" }), spark({ id: "c" })];
    const { container } = render(<FabricPanel sparks={nodes} views={[]} navigate={() => {}} />);
    expect(container.querySelectorAll(".cp-fabric-node")).toHaveLength(3);
    expect(container.querySelectorAll(".cp-fabric-link")).toHaveLength(0);
    expect(container.querySelector(".cp-fabric-wiring")?.textContent).toContain("WIRING NOT DISCOVERED");
    expect(container.querySelector(".cp-fabric-note")).not.toBeNull();
    // 3 nodes must never become a triangle.
    const lines = container.querySelectorAll(".cp-fabric-links line");
    expect(lines).toHaveLength(0);
  });

  it("draws exactly the discovered links — 2 nodes on one CX7 segment => 1 edge", () => {
    cleanupRenders();
    const nodes = [spark({ id: "a", cx7Ip: "10.0.0.1" }), spark({ id: "b", cx7Ip: "10.0.0.2" })];
    const { container } = render(<FabricPanel sparks={nodes} views={[]} navigate={() => {}} />);
    expect(container.querySelectorAll(".cp-fabric-link")).toHaveLength(1);
    expect(container.querySelector(".cp-fabric-wiring")?.textContent).toContain("1 LINKS DISCOVERED");
    expect(container.querySelector(".cp-fabric-note")).toBeNull();
  });

  it("does not triangulate 3 nodes when only two share a segment", () => {
    cleanupRenders();
    const nodes = [spark({ id: "a", cx7Ip: "10.0.0.1" }), spark({ id: "b", cx7Ip: "10.0.0.2" }), spark({ id: "c", cx7Ip: "10.9.9.9" })];
    const { container } = render(<FabricPanel sparks={nodes} views={[]} navigate={() => {}} />);
    expect(container.querySelectorAll(".cp-fabric-link")).toHaveLength(1);
  });

  it("shows link speed and node health only from live data", () => {
    cleanupRenders();
    const nodes = [spark({ id: "a", cx7Ip: "10.0.0.1", metrics: { ...spark().metrics, network: { linkSpeedMbps: 200_000 } as never } })];
    const { container } = render(<FabricPanel sparks={nodes} views={[]} navigate={() => {}} />);
    expect(container.querySelector(".cp-fabric-node-speed")?.textContent).toContain("Gb/s");
    expect(container.querySelector(".cp-fabric-node-speed")?.textContent).not.toBe("—");
  });

  it("renders faint dashed placeholders between same-row neighbours when undiscovered", () => {
    cleanupRenders();
    const nodes = [spark({ id: "a" }), spark({ id: "b" }), spark({ id: "c" })];
    const { container } = render(<FabricPanel sparks={nodes} views={[]} navigate={() => {}} />);
    expect(container.querySelector(".cp-fabric-links")).toBeNull();
    // a-b share row 0 => 1 placeholder; c sits alone on row 1 => none.
    expect(container.querySelectorAll(".cp-fabric-placeholders line")).toHaveLength(1);
    expect(container.querySelector(".cp-fabric-note")?.textContent).toContain("not discovered");
  });

  it("has no placeholders once wiring is discovered", () => {
    cleanupRenders();
    const nodes = [spark({ id: "a", cx7Ip: "10.0.0.1" }), spark({ id: "b", cx7Ip: "10.0.0.2" })];
    const { container } = render(<FabricPanel sparks={nodes} views={[]} navigate={() => {}} />);
    expect(container.querySelector(".cp-fabric-placeholders")).toBeNull();
  });

  it("adapts to a single node without placeholders or dead links", () => {
    cleanupRenders();
    const { container } = render(<FabricPanel sparks={[spark({ id: "solo" })]} views={[]} navigate={() => {}} />);
    expect(container.querySelectorAll(".cp-fabric-node")).toHaveLength(1);
    expect(container.querySelectorAll(".cp-fabric-placeholders line")).toHaveLength(0);
  });

  it("sizes the card so a placed-model name is fully readable, not clipped", () => {
    cleanupRenders();
    const longName = "deepseek-v4-1-flash-uncensored-exl3";
    const { container } = render(<FabricPanel sparks={[spark()]} views={[view(longName)]} navigate={() => {}} />);
    const card = container.querySelector<HTMLButtonElement>(".cp-fabric-node")!;
    // Tall enough for the model line to wrap onto two lines and still fit.
    expect(parseInt(card.style.height, 10)).toBeGreaterThanOrEqual(112);
    const models = card.querySelector(".cp-fabric-node-models");
    expect(models?.textContent).toContain(longName);
  });
});
