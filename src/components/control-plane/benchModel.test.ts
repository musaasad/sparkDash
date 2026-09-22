import { describe, expect, it } from "vitest";
import type { DecodeBenchJob, PrefillBenchJob } from "../../api/types";
import {
  anchorTiles,
  comparableGroups,
  comparisonOf,
  fmtDuration,
  percentile,
  signedDelta,
  tokenComposition,
  type BenchEntry,
} from "./benchModel";

function level(over: Partial<DecodeBenchJob["results"][number]> = {}) {
  return {
    concurrency: 1,
    streamsOk: 1,
    streamsFailed: 0,
    meanDecodeTps: 100,
    medianDecodeTps: 100,
    minDecodeTps: 90,
    maxDecodeTps: 110,
    meanTtftMs: 200,
    medianTtftMs: 200,
    aggregateDecodeTps: 100,
    meanPrefillTps: 500,
    medianPrefillTps: 500,
    aggregatePrefillTps: 500,
    totalPrefillTokens: 1000,
    totalDecodeTokens: 2000,
    totalCompletionTokens: 2000,
    durationMs: 1000,
    error: null,
    streams: [],
    model: null,
    ...over,
  };
}

function job(over: Partial<DecodeBenchJob> = {}): DecodeBenchJob {
  return {
    benchId: "b1",
    sparkId: "n1",
    status: "completed",
    startedAt: Date.now() - 60_000,
    completedAt: Date.now(),
    config: { port: 1, modelId: "m1", concurrencies: [1, 2], maxTokens: 64, promptType: "structured" },
    progress: { currentConcurrency: null, completedLevels: 2, totalLevels: 2, message: "" },
    results: [level({ concurrency: 1 }), level({ concurrency: 2 })],
    error: null,
    durationMs: 2000,
    ...over,
  };
}

function entry(over: Partial<BenchEntry> = {}): BenchEntry {
  const j = job();
  return {
    key: "d-b1",
    kind: "decode",
    job: j,
    sparkId: "n1",
    sparkName: "Spark A",
    recipeId: "r1",
    modelId: "m1",
    status: "completed",
    startedAt: j.startedAt,
    durationMs: j.durationMs,
    shape: "structured · c1/2",
    ...over,
  };
}

describe("signedDelta formatting", () => {
  it("renders signed percentages and marks throughput improvements green", () => {
    expect(signedDelta(100, 112, true)).toEqual({ text: "+12%", direction: "improvement" });
    expect(signedDelta(100, 80, true)).toEqual({ text: "-20%", direction: "regression" });
  });

  it("flips direction for TTFT where lower is better", () => {
    expect(signedDelta(100, 112, false).direction).toBe("regression");
    expect(signedDelta(100, 80, false).direction).toBe("improvement");
  });

  it("stays flat on zero and missing baselines", () => {
    expect(signedDelta(100, 100, true)).toEqual({ text: "±0%", direction: "flat" });
    expect(signedDelta(null, 50, true)).toEqual({ text: "—", direction: "flat" });
    expect(signedDelta(0, 50, true).direction).toBe("flat");
  });
});

describe("benchModel derivations", () => {
  it("computes percentiles and anchor tiles from stored levels", () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    const tiles = anchorTiles(job(), "decode");
    expect(tiles.throughput.p50).toBeCloseTo(100);
    expect(tiles.ttft.p90).toBeCloseTo(200);
    expect(anchorTiles(job({ results: [] }), "decode").throughput.p50).toBeNull();
  });

  it("returns proportional token composition bars", () => {
    const comp = tokenComposition(job(), "decode");
    expect(comp.prefill + comp.decode).toBeCloseTo(100);
    expect(comp.prefill).toBeCloseTo(33.33, 1);
  });

  it("groups only truly comparable completed runs", () => {
    const a = entry({ key: "a", startedAt: 100 });
    const b = entry({ key: "b", startedAt: 200 });
    const other = entry({ key: "c", startedAt: 300, recipeId: "r2" });
    expect(comparableGroups([a, b, other])).toHaveLength(1);
    expect(comparableGroups([a, b, other])[0].map((e) => e.key)).toEqual(["a", "b"]);
    expect(comparisonOf(comparableGroups([a, b])[0])?.throughput.direction).toBe("flat");
  });

  it("formats durations", () => {
    expect(fmtDuration(1500)).toBe("1.5s");
    expect(fmtDuration(65000)).toBe("1m 5s");
    expect(fmtDuration(0)).toBe("—");
  });

  it("handles prefill jobs without decode fields", () => {
    const p: PrefillBenchJob = {
      benchId: "p1",
      sparkId: "n1",
      status: "completed",
      startedAt: 0,
      completedAt: 1,
      config: { port: 1, modelId: null, contextSizes: [1024] },
      progress: { currentContext: null, completedLevels: 1, totalLevels: 1, message: "" },
      results: [{ targetTokens: 1024, promptTokens: 900, promptChars: 10, prefillTps: 400, ttftMs: 250, ttftContentMs: null, completionTokens: 100, durationMs: 500, model: null, error: null }],
      error: null,
      durationMs: 500,
    };
    expect(anchorTiles(p, "prefill").throughput.p50).toBe(400);
    expect(tokenComposition(p, "prefill").prefill).toBeCloseTo(90);
  });
});
