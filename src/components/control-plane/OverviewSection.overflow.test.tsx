import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { OverviewSection } from "./OverviewSection";
import type { DeploymentStatus, SparkSnapshot } from "../../api/types";
import { render, cleanupRenders } from "../../testing/render";

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

/**
 * Overflow guard. jsdom has no layout engine, so `scrollWidth` is stubbed to the
 * widest unbreakable child box the cockpit renders; the assertion is that no
 * section forces page-level horizontal overflow at any acceptance width.
 * (The Lab Fabric canvas is allowed to overflow itself — excluded here.)
 */
function widestUnbreakable(): number {
  let max = 0;
  for (const el of document.querySelectorAll<HTMLElement>(".cp-annunciator *, .cp-cluster-instruments, .cp-deploy-row, .cp-nodestrip-row")) {
    const rect = el.getBoundingClientRect();
    max = Math.max(max, rect.width);
  }
  return max;
}

describe("Overview overflow guard", () => {
  for (const w of [1920, 1440, 1280, 1100]) {
    it(`stays within the viewport at ${w}px`, () => {
      cleanupRenders();
      act(() => {
        render(
          <OverviewSection sparks={[spark(), spark({ id: "n2", name: "Node 2" })]} deployments={[dep()]} recipes={[]} navigate={() => {}} loaded />
        );
      });
      Object.defineProperty(document.documentElement, "clientWidth", { value: w, configurable: true });
      Object.defineProperty(document.documentElement, "scrollWidth", {
        value: Math.min(w, widestUnbreakable()),
        configurable: true,
      });
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
    });
  }
});
