import { describe, expect, it, vi } from "vitest";
import { act } from "react";
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

  it("has an obvious '+ Add compute' entry on the Lab Fabric surface", () => {
    cleanupRenders();
    const onAddCompute = vi.fn();
    const { container } = render(<FabricPanel sparks={[spark()]} views={[]} navigate={() => {}} onAddCompute={onAddCompute} />);
    const btn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add compute"))!;
    expect(btn).toBeTruthy();
    act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onAddCompute).toHaveBeenCalled();
  });

  it("keeps physical and deployment as SEPARATE visual modes with a legend", () => {
    cleanupRenders();
    const nodes = [spark({ id: "a", cx7Ip: "10.0.0.1" }), spark({ id: "b", cx7Ip: "10.0.0.2" })];
    const { container } = render(<FabricPanel sparks={nodes} views={[view("Llama 3", "a")]} navigate={() => {}} />);
    // physical default: one discovered (dashed) edge, marked by provenance
    expect(container.querySelectorAll(".cp-fabric-link")).toHaveLength(1);
    expect(container.querySelector(".cp-fabric-link")?.getAttribute("data-provenance")).toBe("discovered");
    expect(container.querySelector(".cp-fabric-legend")?.textContent).toContain("configured link");

    const dep = [...container.querySelectorAll<HTMLButtonElement>(".cp-fabric-modes button")].find((b) => b.textContent === "Deployment")!;
    act(() => dep.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    // deployment mode: no physical links at all, placements instead
    expect(container.querySelectorAll(".cp-fabric-link")).toHaveLength(0);
    expect(container.querySelector(".cp-fabric-legend")?.textContent).toContain("no physical edges");
    expect(container.textContent).toContain("Llama 3");
  });

  it("marks CONFIGURED links as solid provenance and DISCOVERED as dashed", () => {
    cleanupRenders();
    const nodes = [
      spark({ id: "a", fabricLinks: [{ to: "b", medium: "cx7" }] }),
      spark({ id: "b", cx7Ip: "10.0.0.9" }),
      spark({ id: "c", cx7Ip: "10.0.0.10" }),
    ];
    const { container } = render(<FabricPanel sparks={nodes} views={[]} navigate={() => {}} />);
    const links = [...container.querySelectorAll(".cp-fabric-link")];
    const configured = links.filter((l) => l.getAttribute("data-provenance") === "configured");
    const disc = links.filter((l) => l.getAttribute("data-provenance") === "discovered");
    expect(configured.length).toBe(1);
    expect(disc.length).toBe(1);
    expect(configured[0].querySelector("line")?.getAttribute("stroke-dasharray")).toBeNull();
    expect(disc[0].querySelector("line")?.getAttribute("stroke-dasharray")).toBe("6 5");
  });

  it("is honest when no placement exists in deployment mode", () => {
    cleanupRenders();
    const { container } = render(<FabricPanel sparks={[spark()]} views={[]} navigate={() => {}} />);
    const dep = [...container.querySelectorAll<HTMLButtonElement>(".cp-fabric-modes button")].find((b) => b.textContent === "Deployment")!;
    act(() => dep.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.querySelector(".cp-fabric-note")?.textContent).toContain("No deployment placement");
    expect(container.textContent).toContain("no model placed");
  });

  it("handles 1..8 nodes data-driven without triangulating", () => {
    cleanupRenders();
    for (const n of [1, 4, 8]) {
      const nodes = [...Array(n).keys()].map((i) => spark({ id: `n${i}` }));
      const { container } = render(<FabricPanel sparks={nodes} views={[]} navigate={() => {}} />);
      expect(container.querySelectorAll(".cp-fabric-node")).toHaveLength(n);
      expect(container.querySelectorAll(".cp-fabric-link")).toHaveLength(0);
    }
  });
});
