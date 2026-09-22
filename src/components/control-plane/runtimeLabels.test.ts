import { describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({
  fetchRuntimes: vi.fn(async () => ({
    runtimes: [
      { id: "tabbyapi", label: "TabbyAPI", launchable: true, metrics: ["mtpAcceptanceRate", "ttftSeconds"] },
      { id: "vllm", label: "vLLM", launchable: true, metrics: ["kvCacheUsage", "requestsWaiting"] },
    ],
  })),
}));

describe("runtimeLabels metrics", () => {
  it("exposes label AND declared metrics from the single registry fetch", async () => {
    const { loadRuntimeLabels, loadRuntimeMetrics } = await import("./runtimeLabels");
    const labels = await loadRuntimeLabels();
    const metrics = await loadRuntimeMetrics();
    expect(labels.tabbyapi).toBe("TabbyAPI");
    expect(metrics.tabbyapi).toEqual(["mtpAcceptanceRate", "ttftSeconds"]);
    expect(metrics.vllm).toEqual(["kvCacheUsage", "requestsWaiting"]);
  });

  it("resolves an unknown runtime to its raw id via the caller fallback", async () => {
    const { loadRuntimeLabels } = await import("./runtimeLabels");
    const labels = await loadRuntimeLabels();
    expect(labels["mystery"] ?? "mystery").toBe("mystery");
  });
});
