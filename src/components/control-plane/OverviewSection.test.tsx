import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { OverviewSection } from "./OverviewSection";
import type { DeploymentStatus, SparkSnapshot, RecipePublic } from "../../api/types";
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
    expect(container.querySelector(".cp-labhead-counts")?.textContent).toContain("1 WARN");
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

  it("F4: window RANKS, never drops — offline nodes stay and the count matches rows", () => {
    cleanupRenders();
    const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const offline = spark({ id: "n-off", name: "Offline Node", online: false });
    const activity = [{ seq: 1, kind: "node", subject: "n-off", summary: "off", ts: old, attribution: null, meta: null }] as never;
    const { container } = render(
      <OverviewSection sparks={[spark(), offline]} deployments={[]} recipes={[]} activity={activity} navigate={() => {}} loaded />
    );
    // The offline node is older than the window but must NOT vanish.
    expect(container.querySelector(".cp-nodestrip")?.textContent).toContain("Offline Node");
    const rows = container.querySelectorAll(".cp-nodestrip-row");
    expect(rows).toHaveLength(2);
    const band = [...container.querySelectorAll(".cp-section-band")].find((b) => b.textContent?.includes("Node telemetry"))!;
    expect(band.querySelector(".cp-section-band-count")?.textContent?.trim()).toBe("2");
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

  it("keeps the status strip a compact annunciator with key counters", () => {
    cleanupRenders();
    const { container } = render(<OverviewSection sparks={[spark()]} deployments={[]} recipes={[]} navigate={() => {}} loaded />);
    const strip = container.querySelector(".cp-annunciator")!;
    expect(strip.querySelector(".cp-verdict-pill")?.textContent).toBe("NOMINAL");
    const brief = strip.querySelector(".cp-labhead-brief")!.textContent ?? "";
    expect(brief).toContain("COMPUTE ONLINE");
    expect(brief).toContain("DEPLOYMENTS ACTIVE");
    expect(brief).toContain("FABRIC:");
    // compact: no prose sentence paragraph inside the strip.
    expect(strip.querySelectorAll("p")).toHaveLength(0);
  });

  it("orders sections single-purpose: instruments, deployments, nodes, activity", () => {
    cleanupRenders();
    const { container } = render(<OverviewSection sparks={[spark()]} deployments={[dep()]} recipes={[]} navigate={() => {}} loaded />);
    const titles = [...container.querySelectorAll(".cp-section-band-title")].map((t) => t.firstChild?.textContent);
    expect(titles).toEqual(["Model instruments", "Deployments", "Node telemetry", "Runtime activity"]);
    // Lab fabric carries its own head band.
    expect(container.querySelector(".cp-fabric-title")?.textContent).toBe("LAB FABRIC");
  });

  it("keeps Deployments an operational list — no instrument readout duplication", () => {
    cleanupRenders();
    const { container } = render(<OverviewSection sparks={[spark()]} deployments={[dep()]} recipes={[]} navigate={() => {}} loaded />);
    const row = container.querySelector(".cp-deploy-row")!;
    expect(row.querySelector(".cp-deploy-role")).not.toBeNull();
    expect(row.querySelector(".cp-deploy-nodes")).not.toBeNull();
    // tok/s + runtime-chip readouts live on the instrument, not repeated here.
    expect(row.textContent).not.toMatch(/tok\/s/);
    // but the model identity is still present for navigation/acceptance.
    expect(row.textContent).toContain("m1");
  });

  it("puts lifecycle actions in ONE home — Deployments, never the instruments", () => {
    cleanupRenders();
    const recipe = { id: "r1", name: "Recipe", modelId: "m1" } as RecipePublic;
    const { container } = render(<OverviewSection sparks={[spark()]} deployments={[dep()]} recipes={[recipe]} navigate={() => {}} loaded />);
    // The instrument is a pure readout.
    expect(container.querySelector(".cp-inst .cp-inst-controls")).toBeNull();
    // The Deployments row owns the lifecycle controls.
    expect(container.querySelector(".cp-deploy-row .cp-deploy-controls")).not.toBeNull();
    const start = [...container.querySelectorAll("button")].filter((b) => b.textContent === "Start");
    expect(start).toHaveLength(1);
    const remove = [...container.querySelectorAll("button")].filter((b) => b.textContent === "Remove binding");
    expect(remove).toHaveLength(1);
  });

  it("keeps both instrument cards classed as equal-weight grid cells (no span)", () => {
    cleanupRenders();
    const { container } = render(<OverviewSection sparks={[spark()]} deployments={[dep(), dep({ recipeId: "r2", modelId: "m2" })]} recipes={[]} navigate={() => {}} loaded />);
    const insts = [...container.querySelectorAll(".cp-inst")];
    expect(insts).toHaveLength(2);
    expect(insts[0].classList.contains("is-primary")).toBe(true);
    expect(insts[1].classList.contains("is-primary")).toBe(false);
  });

  it("does not raise high unified-memory utilisation as an alert", () => {
    cleanupRenders();
    const pressured = spark({
      metrics: { ...spark().metrics, unifiedMemory: { total: 128, used: 120, gpuUsed: 100, cpuUsed: 20, available: 8, percentage: 94, oomRisk: "high", bandwidth: { current: 0, peak: 0 } } as never },
    });
    const { container } = render(<OverviewSection sparks={[pressured]} deployments={[]} recipes={[]} navigate={() => {}} loaded />);
    expect(container.querySelector(".cp-alerts")).toBeNull();
    expect(container.querySelector(".cp-strip-text")?.textContent).toContain("No actionable alerts");
    expect(container.querySelector(".cp-verdict-pill")?.textContent).toBe("NOMINAL");
    // ...but it is still surfaced neutrally on the node instrument.
    expect(container.querySelector(".cp-nodestrip")?.textContent).toContain("UNIFIED MEM");
  });

  it("does raise a genuine oom EVENT (NV_ERR_NO_MEMORY) as attention", () => {
    cleanupRenders();
    const ev = spark({ metrics: { ...spark().metrics, gpu: { temperature: 50, nvErrNoMemory: 14 } as never } });
    const { container } = render(<OverviewSection sparks={[ev]} deployments={[]} recipes={[]} navigate={() => {}} loaded />);
    expect(container.querySelector(".cp-verdict-pill")?.textContent).toBe("ATTENTION");
    expect(container.querySelector(".cp-alerts")?.textContent).toContain("memory pressure");
    expect(container.querySelector(".cp-nodestrip")?.textContent).toContain("NV_ERR_NO_MEM");
  });
});
