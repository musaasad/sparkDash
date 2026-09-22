import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { DecodeBenchJob, SparkSnapshot } from "../../api/types";
import { flush, render, cleanupRenders } from "../../testing/render";

function level(medianDecodeTps: number) {
  return {
    concurrency: 1,
    streamsOk: 1,
    streamsFailed: 0,
    meanDecodeTps: medianDecodeTps,
    medianDecodeTps,
    minDecodeTps: medianDecodeTps,
    maxDecodeTps: medianDecodeTps,
    meanTtftMs: 200,
    medianTtftMs: 200,
    aggregateDecodeTps: medianDecodeTps,
    meanPrefillTps: 500,
    medianPrefillTps: 500,
    aggregatePrefillTps: 500,
    totalPrefillTokens: 1000,
    totalDecodeTokens: 2000,
    totalCompletionTokens: 2000,
    durationMs: 1000,
    error: null,
    streams: [],
    model: "m1",
  };
}

function job(benchId: string, startedAt: number, tps: number): DecodeBenchJob {
  return {
    benchId,
    sparkId: "n1",
    status: "completed",
    startedAt,
    completedAt: startedAt + 2000,
    config: { port: 8889, modelId: "m1", concurrencies: [1], maxTokens: 64, promptType: "structured", recipeId: "r1" },
    progress: { currentConcurrency: null, completedLevels: 1, totalLevels: 1, message: "" },
    results: [level(tps)],
    error: null,
    durationMs: 2000,
  };
}

const now = Date.now();
const history = [job("b1", now - 120_000, 100), job("b2", now - 60_000, 120)];

vi.mock("../../api/client", () => ({
  listDecodeBench: vi.fn(async () => ({ active: null, last: null, history, defaults: {} })),
  listPrefillBench: vi.fn(async () => ({ active: null, last: null, history: [], defaults: {} })),
}));

const { BenchmarksSection } = await import("./BenchmarksSection");

const spark: SparkSnapshot = {
  id: "n1",
  name: "Spark A",
  online: true,
  uptime: 1,
  disabledDevices: [],
  disabledInterfaces: [],
  llmPort: 8889,
  llmPorts: [8889],
  hardware: { device: "x", cpuModel: "x", cpuCores: 8, totalMemoryGB: 128, gpuChip: "GB10", cudaDriver: null, storageModel: null },
  metrics: { gpu: null, cpu: null, ram: null, storage: [], network: null, unifiedMemory: null, llm: [], comfy: null, tailscale: null },
} as SparkSnapshot;

describe("BenchmarksSection run rows", () => {
  it("renders pill → mono name → target chip → duration → View results", async () => {
    cleanupRenders();
    const { container } = render(<BenchmarksSection sparks={[spark]} recipes={[]} navigate={() => {}} />);
    await flush();

    const row = container.querySelector(".cp-table tbody tr")!;
    expect(row.querySelector(".cp-pill")?.textContent).toContain("completed");
    expect(row.querySelector(".cp-bench-name")?.textContent).toContain("decode");
    expect(row.textContent).toContain("Spark A");
    expect(row.textContent).toContain("View results");
  });

  it("expands to anchor tiles, composition bars and signed comparison deltas", async () => {
    cleanupRenders();
    const { container } = render(<BenchmarksSection sparks={[spark]} recipes={[]} navigate={() => {}} />);
    await flush();

    const view = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "View results")!;
    act(() => view.click());

    expect(container.querySelectorAll(".cp-bench-tile")).toHaveLength(5);
    expect([...container.querySelectorAll(".cp-bignum-label")].some((l) => l.textContent === "Requests")).toBe(true);
    expect(container.querySelector(".cp-bench-bar")).not.toBeNull();
    const delta = container.querySelector(".cp-delta");
    expect(delta).not.toBeNull();
    expect(delta!.classList.contains("improvement") || delta!.classList.contains("regression") || delta!.classList.contains("flat")).toBe(true);
  });

  it("filters by counted type tab", async () => {
    cleanupRenders();
    const { container } = render(<BenchmarksSection sparks={[spark]} recipes={[]} navigate={() => {}} />);
    await flush();
    expect(container.querySelectorAll(".cp-table tbody tr")).toHaveLength(2);
    const prefillTab = [...container.querySelectorAll<HTMLButtonElement>(".cp-counted-tab")].find((b) => b.textContent?.includes("Prefill"))!;
    act(() => prefillTab.click());
    expect(container.querySelector(".cp-table-empty-box")).not.toBeNull();
  });
});
