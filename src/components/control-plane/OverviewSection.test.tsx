import { describe, expect, it } from "vitest";
import { act } from "react";
import { OverviewSection } from "./OverviewSection";
import type { SparkSnapshot } from "../../api/types";
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

describe("Overview health verdict", () => {
  it("reads 'All systems normal' with a last-updated stamp and auto-refresh toggle", () => {
    cleanupRenders();
    const { container } = render(<OverviewSection sparks={[spark()]} deployments={[]} recipes={[]} navigate={() => {}} loaded />);
    expect(container.querySelector(".cp-verdict")?.textContent).toContain("All systems normal");
    expect(container.querySelector(".cp-verdict")?.textContent).toContain("updated");
    const toggle = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Auto-refresh"));
    expect(toggle).not.toBeUndefined();
    act(() => toggle!.click());
    expect(container.querySelector(".cp-verdict")?.textContent).toContain("paused");
  });

  it("reports an issue count and dedupes repeated conditions with an xN badge", () => {
    cleanupRenders();
    const hot = spark({
      id: "hot",
      name: "Hot Node",
      metrics: {
        ...spark().metrics,
        storage: [
          { device: "/dev/a", label: "a", used: 95, total: 100, available: 5, percentage: 95, readSpeed: 0, writeSpeed: 0 },
          { device: "/dev/b", label: "b", used: 96, total: 100, available: 4, percentage: 96, readSpeed: 0, writeSpeed: 0 },
        ] as never,
      },
    });
    const { container } = render(<OverviewSection sparks={[hot]} deployments={[]} recipes={[]} navigate={() => {}} loaded />);
    expect(container.querySelector(".cp-verdict")?.textContent).toContain("1 issue needs attention");
    // Two disks on one node collapse into one digest row carrying ×2.
    expect(container.querySelector(".cp-alerts")?.textContent).toContain("×2");
    expect(container.querySelectorAll(".cp-alert")).toHaveLength(1);
  });

  it("restates a time window on windowed sections", () => {
    cleanupRenders();
    const { container } = render(<OverviewSection sparks={[spark()]} deployments={[]} recipes={[]} navigate={() => {}} loaded />);
    expect(container.textContent).toContain("Compute nodes (1) · last 15m");
    expect(container.textContent).toContain("Runtime activity · last 5 events");
  });

  it("shows first-paint skeletons matching final geometry while unloaded", () => {
    cleanupRenders();
    const { container } = render(<OverviewSection sparks={[]} deployments={[]} recipes={[]} navigate={() => {}} loaded={false} />);
    expect(container.querySelectorAll(".cp-skeleton")).toHaveLength(3);
  });
});
