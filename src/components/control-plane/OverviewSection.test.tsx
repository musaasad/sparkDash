import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { OverviewSection } from "./OverviewSection";
import type { DeploymentStatus, SparkSnapshot } from "../../api/types";
import { render, cleanupRenders } from "../../testing/render";

// Hermetic: the runtime registry hook must not hit the live :5556 API.
vi.mock("../../api/client", () => ({
  fetchRuntimes: vi.fn(async () => ({ runtimes: [] })),
  fetchActivity: vi.fn(async () => ({ events: [] })),
}));

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
    managedBy: "external", dryRun: true, state: "running", desired: "unknown", observed: "auth-gated",
    discovered: false, display: "running-external", lastOp: null, lastError: null, startedAt: null, updatedAt: 0,
    ...over,
  };
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

  it("reads ATTENTION (not DEGRADED) for a warning-only lab, with consistent wording", () => {
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
    // Every node is online — a disk warning is ATTENTION, never a degradation.
    expect(container.querySelector(".cp-verdict-pill")?.textContent).toBe("ATTENTION");
    expect(container.querySelector(".cp-verdict")?.classList.contains("is-attention")).toBe(true);
    expect(container.querySelector(".cp-verdict")?.classList.contains("is-degraded")).toBe(false);
    // Pill, headline and summary all use the same "warning" wording — no ALERT mixing.
    expect(container.querySelector(".cp-verdict-text")?.textContent).toContain("1 warning to review");
    expect(container.querySelector(".cp-verdict-summary")?.textContent).toContain("1 WARNING");
    // Two disks on one node collapse into one digest row carrying ×2.
    expect(container.querySelector(".cp-alerts")?.textContent).toContain("×2");
    expect(container.querySelectorAll(".cp-alert")).toHaveLength(1);
  });

  it("reads DEGRADED when a node is genuinely offline", () => {
    cleanupRenders();
    const { container } = render(
      <OverviewSection sparks={[spark({ id: "n1", name: "n1", online: false })]} deployments={[]} recipes={[]} navigate={() => {}} loaded />
    );
    expect(container.querySelector(".cp-verdict-pill")?.textContent).toBe("DEGRADED");
    expect(container.querySelector(".cp-verdict")?.classList.contains("is-degraded")).toBe(true);
  });

  it("gives each section a real, independently filtering window picker", () => {
    cleanupRenders();
    const { container } = render(<OverviewSection sparks={[spark()]} deployments={[]} recipes={[]} navigate={() => {}} loaded />);
    expect(container.textContent).toContain("Node telemetry");
    expect(container.textContent).toContain("Runtime activity");
    const nodeWindow = container.querySelector<HTMLElement>('[aria-label="Node window"]');
    const activityWindow = container.querySelector<HTMLElement>('[aria-label="Activity window"]');
    expect(nodeWindow).not.toBeNull();
    expect(activityWindow).not.toBeNull();
    const act24 = [...activityWindow!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Last 24h")!;
    act(() => act24.click());
    // Activity window switched; node window keeps its own "Last 15m".
    expect(act24.getAttribute("aria-pressed")).toBe("true");
    expect(nodeWindow!.querySelector('[aria-pressed="true"]')?.textContent).toBe("Last 15m");
  });

  it("shows a getting-started checklist for a fresh lab", () => {
    cleanupRenders();
    const { container } = render(<OverviewSection sparks={[]} deployments={[]} recipes={[]} navigate={() => {}} loaded />);
    expect(container.querySelector(".cp-getstarted-overline")?.textContent).toContain("GET STARTED");
    expect(container.querySelectorAll(".cp-getstarted-card")).toHaveLength(4);
  });

  it("shows first-paint skeletons matching final geometry while unloaded", () => {
    cleanupRenders();
    const { container } = render(<OverviewSection sparks={[]} deployments={[]} recipes={[]} navigate={() => {}} loaded={false} />);
    expect(container.querySelectorAll(".cp-skeleton")).toHaveLength(3);
  });

  it("drops the standalone bottom Topology band — placement lives in the instrument", () => {
    cleanupRenders();
    const { container } = render(<OverviewSection sparks={[spark()]} deployments={[dep()]} recipes={[]} navigate={() => {}} loaded />);
    expect(container.querySelector(".cp-topology")).toBeNull();
    // placement still expressed per-instrument + the fabric panel
    expect(container.querySelector(".cp-topo-summary")).not.toBeNull();
    expect(container.querySelector(".cp-fabric")).not.toBeNull();
  });

  it("reads an auth-gated external runtime as calm tight, not degraded", () => {
    cleanupRenders();
    const { container } = render(<OverviewSection sparks={[spark()]} deployments={[dep()]} recipes={[]} navigate={() => {}} loaded />);
    expect(container.querySelector(".cp-inst-state")?.textContent).toContain("READY");
    expect(container.querySelector(".cp-inst-state")?.classList.contains("tone-warn")).toBe(false);
  });

  it("renders a compact lab identity header with a data-driven briefing", () => {
    cleanupRenders();
    const { container } = render(<OverviewSection sparks={[spark()]} deployments={[]} recipes={[]} navigate={() => {}} loaded />);
    const head = container.querySelector(".cp-labhead")!;
    expect(head.textContent).toContain("ASAD");
    expect(head.querySelector(".cp-labhead-brief")?.textContent).toContain("1/1 COMPUTE ONLINE");
    expect(head.querySelector(".cp-labhead-brief")?.textContent).toContain("FABRIC:");
    expect(head.querySelector(".cp-labhead-counts")?.textContent).toContain("0 CRITICAL");
  });

  it("emphasizes the CONFIG PRIMARY first and keeps it visible when OFFLINE", () => {
    cleanupRenders();
    const primary = dep({ recipeId: "rp", modelId: "primary-model", role: "primary", display: "stopped", observed: "not-detected" });
    const worker = dep({ recipeId: "rw", modelId: "worker-model", role: "worker" });
    const { container } = render(<OverviewSection sparks={[spark()]} deployments={[primary, worker]} recipes={[]} navigate={() => {}} loaded />);
    const insts = [...container.querySelectorAll(".cp-inst")];
    expect(insts[0].classList.contains("is-primary")).toBe(true);
    expect(insts[0].querySelector(".cp-inst-state")?.textContent).toContain("OFFLINE");
    expect(insts[0].querySelector(".cp-inst-name")?.textContent).toContain("primary-model");
    const brief = container.querySelector(".cp-labhead-brief")?.textContent ?? "";
    expect(brief).toContain("PRIMARY: primary-model");
  });

  it("renders a compact node telemetry strip, not giant cards", () => {
    cleanupRenders();
    const { container } = render(<OverviewSection sparks={[spark()]} deployments={[]} recipes={[]} navigate={() => {}} loaded />);
    expect(container.querySelector(".cp-nodestrip")).not.toBeNull();
    expect(container.querySelector(".cp-nodestrip-row")).not.toBeNull();
    expect(container.querySelector(".cp-nodestrip-name")?.textContent).toBe("Node 1");
  });
});
