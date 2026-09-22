import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { NodeDetail } from "./NodeDetail";
import type { SparkSnapshot, RecipePublic, DeploymentStatus } from "../../api/types";
import { render, cleanupRenders } from "../../testing/render";

// Hermetic: the runtime registry + embedded DiscoveredRuntimes must not hit the
// live :5556 API.
vi.mock("../../api/client", () => ({
  fetchRuntimes: vi.fn(async () => ({ runtimes: [] })),
  fetchActivity: vi.fn(async () => ({ events: [] })),
  fetchDiscovery: vi.fn(async () => ({ discovered: [], readOnly: true })),
  fetchModels: vi.fn(async () => ({ models: [] })),
  fetchRecipes: vi.fn(async () => ({ recipes: [] })),
  fetchSparks: vi.fn(async () => ({ sparks: [] })),
  fetchSettings: vi.fn(async () => ({})),
  fetchModel: vi.fn(),
  adoptDiscovered: vi.fn(),
  archiveModel: vi.fn(),
  restoreModel: vi.fn(),
}));

function spark(over: Partial<SparkSnapshot> = {}): SparkSnapshot {
  return {
    id: "dgx-2", name: "DGX 2", online: false, lanIp: "10.0.0.7", uptime: null, disabledDevices: [], disabledInterfaces: [],
    llmPort: 8888, llmPorts: [8888],
    hardware: { device: "x", cpuModel: "x", cpuCores: 8, totalMemoryGB: 128, gpuChip: "GB10", cudaDriver: null, storageModel: null },
    metrics: { gpu: null, cpu: null, ram: null, storage: [], network: null, unifiedMemory: null, llm: [], comfy: null, tailscale: null },
    ...over,
  } as SparkSnapshot;
}

const recipe: RecipePublic = {
  id: "r1", modelId: "m1", name: "R", runtime: "vllm", topology: "single", nodeIds: ["dgx-2"],
  modelPath: "/x", workdir: "/x", logDir: null, apiPort: 8889, healthPath: "/h", contextLength: null,
  cpuAffinity: null, launcher: null, metadata: {}, notes: "", env: [], archived: false, createdAt: 0, updatedAt: 0,
};

const dep: DeploymentStatus = {
  recipeId: "r1", modelId: "m1", nodeIds: ["dgx-2"], apiPort: 8889, managedBy: "sparkdash", dryRun: true,
  state: "stopped", desired: "stopped", observed: "not-detected", discovered: false, display: "stopped",
  lastOp: null, lastError: null, startedAt: null, updatedAt: 0,
};

function props(over: Partial<SparkSnapshot> = {}) {
  const s = spark(over);
  return {
    spark: s,
    allSparks: [s],
    recipes: [recipe],
    deployments: [dep],
    temperatureUnit: "celsius" as const,
    navigate: () => {},
    onEdit: () => {},
    onAddNode: () => {},
  };
}

describe("NodeDetail", () => {
  it("shows the header breadcrumb, copyable host and offline pill", () => {
    cleanupRenders();
    const { container } = render(<NodeDetail {...props()} />);
    expect(container.querySelector(".cp-crumb")?.textContent).toContain("Fleet");
    expect(container.querySelector(".cp-host")?.textContent).toContain("10.0.0.7");
    expect(container.querySelector(".cp-pill")?.textContent).toContain("Offline");
  });

  it("never blanks an SSH-unreachable node: amber banner with last contact", () => {
    cleanupRenders();
    const { container } = render(<NodeDetail {...props()} />);
    expect(container.querySelector(".cp-banner.is-amber")?.textContent).toContain("SSH unreachable");
    expect(container.querySelector(".cp-banner.is-amber")?.textContent).toContain("Last contact");
  });

  it("exposes underline tabs Overview | GPUs | Models | Logs | Settings", () => {
    cleanupRenders();
    const { container } = render(<NodeDetail {...props()} />);
    const tabs = [...container.querySelectorAll<HTMLButtonElement>(".cp-tab")].map((t) => t.textContent);
    expect(tabs).toEqual(["Overview", "GPUs", "Models", "Logs", "Settings"]);
  });

  it("uses the cp node rail instead of the legacy pill-nav", () => {
    cleanupRenders();
    const { container } = render(<NodeDetail {...props()} />);
    expect(container.querySelector(".cp-node-rail")).not.toBeNull();
    expect(container.querySelector(".pill-nav")).toBeNull();
    expect(container.querySelector(".cp-node-tab.is-active")?.textContent).toContain("DGX 2");
  });

  it("switches to the Models tab showing the node deployment row", () => {
    cleanupRenders();
    const { container } = render(<NodeDetail {...props()} />);
    const modelsTab = [...container.querySelectorAll<HTMLButtonElement>(".cp-tab")].find((t) => t.textContent === "Models");
    act(() => modelsTab!.click());
    expect(container.querySelector(".cp-deploy-row")).not.toBeNull();
    expect(container.textContent).toContain("View logs");
  });
});
