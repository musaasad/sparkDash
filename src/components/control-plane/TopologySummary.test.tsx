import { describe, expect, it } from "vitest";
import { TopologySummary, topologySummaryLine } from "./TopologySummary";
import type { DeploymentView } from "./fleetModel";
import type { RecipePublic, SparkSnapshot, DeploymentStatus } from "../../api/types";
import { render } from "../../testing/render";

function spark(id: string, name: string): SparkSnapshot {
  return { id, name, online: true, uptime: 1, disabledDevices: [], disabledInterfaces: [], llmPort: 8888, llmPorts: [8888], hardware: {} as SparkSnapshot["hardware"], metrics: {} as SparkSnapshot["metrics"] };
}

function view(nodeIds: string[], topologyBlock: RecipePublic["topologyBlock"]): DeploymentView {
  return {
    deployment: { nodeIds, display: "running", lastError: null } as DeploymentStatus,
    key: "d1",
    recipe: { topologyBlock } as RecipePublic,
    modelName: "Llama",
    rawModelId: "m1",
    nodes: nodeIds.map((id) => spark(id, id.replace("n", "DGX "))),
    uptime: null,
  } as DeploymentView;
}

describe("topologySummaryLine", () => {
  it("renders explicit degrees beside the node labels", () => {
    expect(topologySummaryLine(view(["n1", "n2"], { tp: 2 }))).toBe("TP2 · DGX 1+DGX 2");
    expect(topologySummaryLine(view(["n1", "n2"], { tp: 2, pp: 2 }))).toBe("TP2 · PP2 · DGX 1+DGX 2");
  });

  it("renders single for a lone configured-single node", () => {
    expect(topologySummaryLine(view(["n3"], { mode: "single" }))).toBe("Single · DGX 3");
  });

  it("NEVER infers a degree from node count — renders unknown", () => {
    expect(topologySummaryLine(view(["n1", "n2"], undefined))).toBe("2 nodes · topology unknown");
    expect(topologySummaryLine(view(["n1", "n2"], { mode: "single", parallelism: 1, unknown: true }))).toBe("2 nodes · topology unknown");
  });
});

describe("TopologySummary", () => {
  it("marks the unknown state and carries the line as title", () => {
    const { container } = render(<TopologySummary view={view(["n1", "n2"], undefined)} />);
    expect(container.textContent).toBe("2 nodes · topology unknown");
    const chip = container.querySelector(".cp-topo-summary");
    expect(chip?.className).toContain("is-unknown");
    expect(chip?.getAttribute("title")).toBe("2 nodes · topology unknown");
  });

  it("renders a configured topology without the unknown marker", () => {
    const { container } = render(<TopologySummary view={view(["n1", "n2"], { tp: 2 })} />);
    expect(container.textContent).toBe("TP2 · DGX 1+DGX 2");
    expect(container.querySelector(".is-unknown")).toBeNull();
  });
});
