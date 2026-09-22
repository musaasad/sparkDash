import { describe, expect, it, vi } from "vitest";
import type { DeploymentStatus, SparkSnapshot } from "../../api/types";
import { NodeTelemetryStrip } from "./NodeTelemetryStrip";
import { render, cleanupRenders } from "../../testing/render";

function spark(over: Partial<SparkSnapshot> = {}): SparkSnapshot {
  return {
    id: "n1", name: "Node 1", online: true, uptime: 100, disabledDevices: [], disabledInterfaces: [],
    llmPort: 8888, llmPorts: [8888],
    hardware: { device: "x", cpuModel: "x", cpuCores: 8, totalMemoryGB: 128, gpuChip: "GB10", cudaDriver: null, storageModel: null },
    metrics: { gpu: null, cpu: null, ram: null, storage: [], network: null, unifiedMemory: null, llm: [], comfy: null, tailscale: null },
    ...over,
  } as SparkSnapshot;
}

function dep(over: Partial<DeploymentStatus> = {}): DeploymentStatus {
  return {
    recipeId: "r1", modelId: "m1", nodeIds: ["n1"], apiPort: 8889,
    managedBy: "sparkdash", dryRun: true, state: "running", desired: "running", observed: "running",
    discovered: false, display: "running", lastOp: null, lastError: null, startedAt: null, updatedAt: 0,
    ...over,
  };
}

describe("NodeTelemetryStrip", () => {
  it("renders one compact row per node and keeps N scalable", () => {
    cleanupRenders();
    const { container } = render(
      <NodeTelemetryStrip sparks={[spark({ id: "a", name: "A" }), spark({ id: "b", name: "B" })]} deployments={[]} />
    );
    expect(container.querySelectorAll(".cp-nodestrip-row")).toHaveLength(2);
    expect(container.querySelector(".cp-nodestrip-name")?.textContent).toBe("A");
  });

  it("shows 'no telemetry reported' rather than a forged 0", () => {
    cleanupRenders();
    const { container } = render(<NodeTelemetryStrip sparks={[spark()]} deployments={[]} />);
    expect(container.querySelector(".cp-nodestrip-metrics")?.textContent).toContain("no telemetry reported");
  });

  it("renders measured values and never promotes a missing metric to 0", () => {
    cleanupRenders();
    const node = spark({
      metrics: { ...spark().metrics, gpu: { temperature: 56, usage: 40, power: { draw: 56, limit: 0 }, vram: { used: 0, total: 0, percentage: 0, available: 0 } } },
    });
    const { container } = render(<NodeTelemetryStrip sparks={[node]} deployments={[]} />);
    expect(container.querySelector(".cp-nodestrip-metrics")?.textContent).toContain("GPU TEMP");
    expect(container.querySelector(".cp-nodestrip-metrics")?.textContent).toContain("56");
    // limit unknown => no fabricated "56/..." title
    const power = [...container.querySelectorAll(".cp-nodestrip-cell")].find((c) => c.textContent?.includes("POWER"))!;
    expect(power.querySelector(".cp-nodestrip-cell-value")?.getAttribute("title")).toBeNull();
    // CPU absent entirely => no CPU TEMP cell
    expect(container.querySelector(".cp-nodestrip-metrics")?.textContent).not.toContain("CPU TEMP");
  });

  it("marks an offline node OFFLINE and unclassified, not degraded-for-a-missing-metric", () => {
    cleanupRenders();
    const { container } = render(<NodeTelemetryStrip sparks={[spark({ online: false })]} deployments={[]} />);
    expect(container.querySelector(".cp-nodestrip-state")?.textContent).toBe("OFFLINE");
    expect(container.querySelector(".cp-nodestrip-row")?.classList.contains("tone-off")).toBe(true);
  });

  it("names the deployments a node belongs to", () => {
    cleanupRenders();
    const { container } = render(
      <NodeTelemetryStrip sparks={[spark()]} deployments={[dep({ modelId: "m1" })]} models={[{ id: "m1", name: "Friendly" } as never]} />
    );
    expect(container.querySelector(".cp-nodestrip-deploys")?.textContent).toContain("Friendly");
  });

  it("opens a node on click", () => {
    cleanupRenders();
    const onOpen = vi.fn();
    const { container } = render(<NodeTelemetryStrip sparks={[spark()]} deployments={[]} onOpenNode={onOpen} />);
    (container.querySelector(".cp-nodestrip-row") as HTMLElement).click();
    expect(onOpen).toHaveBeenCalledWith("n1");
  });

  it("shows an empty state for zero nodes", () => {
    cleanupRenders();
    const { container } = render(<NodeTelemetryStrip sparks={[]} deployments={[]} />);
    expect(container.textContent).toContain("No compute nodes registered.");
  });
});
