import { describe, expect, it } from "vitest";
import type { DeploymentView, DeploymentTelemetry } from "./fleetModel";
import { HISTORY_CAP, observedRange, recordTelemetry } from "./useTelemetryHistory";

function telem(over: Partial<DeploymentTelemetry> = {}): DeploymentTelemetry {
  return {
    generationTps: 100, prefillTps: null, ttftSeconds: null, requestsRunning: null, requestsWaiting: null,
    kvCacheUsage: null, prefixCacheHitRate: null, mtpAcceptanceRate: null, contextLength: null,
    gpuMemoryUtilization: null, slotsActive: null, slotsTotal: null, totalOutputTokens: null,
    backend: null, modelId: null, available: true, error: null,
    aggregation: null, membersReporting: 1, membersMissingTelemetry: [],
    ...over,
  };
}

function view(key: string, telemetry: DeploymentTelemetry | null): DeploymentView {
  return { key, telemetry } as unknown as DeploymentView;
}

describe("recordTelemetry ring buffer", () => {
  it("appends samples and caps the window", () => {
    let h = recordTelemetry({}, [view("a", telem({ generationTps: 1 }))], 0);
    for (let i = 0; i < HISTORY_CAP + 10; i++) {
      h = recordTelemetry(h, [view("a", telem({ generationTps: i }))], i);
    }
    expect(h.a.samples).toHaveLength(HISTORY_CAP);
    expect(h.a.samples.at(-1)).toBe(HISTORY_CAP + 9);
  });

  it("records recency only when the output-token counter increases", () => {
    let h = recordTelemetry({}, [view("a", telem({ totalOutputTokens: 100 }))], 1_000);
    expect(h.a.lastRequestAt).toBeNull(); // first sight is not a "request"
    h = recordTelemetry(h, [view("a", telem({ totalOutputTokens: 150 }))], 2_000);
    expect(h.a.lastRequestAt).toBe(2_000);
    h = recordTelemetry(h, [view("a", telem({ totalOutputTokens: 150 }))], 3_000);
    expect(h.a.lastRequestAt).toBe(2_000); // flat counter keeps the last change
  });

  it("keeps only keys still present", () => {
    let h = recordTelemetry({}, [view("a", telem()), view("b", telem())], 0);
    h = recordTelemetry(h, [view("a", telem())], 1);
    expect(Object.keys(h)).toEqual(["a"]);
  });

  it("tolerates a null telemetry without inventing a sample", () => {
    const h = recordTelemetry({}, [view("a", null)], 0);
    expect(h.a.samples).toEqual([]);
    expect(h.a.lastRequestAt).toBeNull();
  });
});

describe("observedRange", () => {
  it("needs 2 samples and returns peak + avg", () => {
    expect(observedRange([5])).toBeNull();
    expect(observedRange([10, 20, 30])).toEqual({ min: 10, max: 30, peak: 30, avg: 20 });
  });
});
