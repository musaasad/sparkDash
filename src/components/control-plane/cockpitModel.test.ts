import { describe, expect, it } from "vitest";
import type { DeploymentStatus, RecipePublic, SparkSnapshot } from "../../api/types";
import type { DeploymentView } from "./fleetModel";
import {
  labSummary,
  labVerdict,
  lastRequestAgo,
  rankViews,
  roleOf,
  secondaryInstruments,
  stateLabel,
  stateTone,
  verdictLabel,
  type StateTone,
} from "./cockpitModel";

function spark(over: Partial<SparkSnapshot> = {}): SparkSnapshot {
  return {
    id: "n1", name: "Node 1", online: true, uptime: 100, disabledDevices: [], disabledInterfaces: [],
    llmPort: 8888, llmPorts: [8888],
    hardware: { device: "x", cpuModel: "x", cpuCores: 8, totalMemoryGB: 128, gpuChip: "GB10", cudaDriver: null, storageModel: null },
    metrics: { gpu: null, cpu: null, ram: null, storage: [], network: null, unifiedMemory: null, llm: [], comfy: null, tailscale: null },
    ...over,
  } as SparkSnapshot;
}

function dep(recipeId: string, modelId: string, over: Partial<DeploymentStatus> = {}): DeploymentStatus {
  return {
    recipeId, modelId, nodeIds: ["n1"], apiPort: 8889,
    managedBy: "sparkdash", dryRun: true, state: "running", desired: "running", observed: "running",
    discovered: false, display: "running", lastOp: null, lastError: null, startedAt: null, updatedAt: 0,
    ...over,
  };
}

function view(over: Partial<DeploymentView> = {}): DeploymentView {
  const d = over.deployment ?? dep("r1", "m1");
  return {
    deployment: d,
    key: d.deploymentId ?? d.recipeId,
    recipe: null as RecipePublic | null,
    modelName: d.modelId,
    rawModelId: d.modelId,
    nodes: [spark()],
    runtime: "tabbyapi",
    topology: "single",
    lifecycleState: null,
    contextLength: 32000,
    port: d.apiPort,
    decodeTps: null,
    telemetry: null,
    uptime: null,
    ...over,
  };
}

describe("lab verdict + summary", () => {
  it("is nominal when healthy, degrades on warnings, alerts on a hard failure", () => {
    expect(labVerdict(3, 3, 0, [], ["serving", "idle"])).toBe("nominal");
    expect(labVerdict(3, 3, 2, [], ["idle"])).toBe("degraded");
    expect(labVerdict(3, 3, 0, [], ["degraded"])).toBe("alert");
    expect(labVerdict(2, 3, 0, [], ["idle"])).toBe("alert");
  });

  it("renders verdict labels", () => {
    expect(verdictLabel("nominal")).toBe("NOMINAL");
    expect(verdictLabel("alert")).toBe("ALERT");
  });

  it("builds an all-caps data-driven summary with singular/plural", () => {
    expect(labSummary(3, 3, 2, 0)).toBe("3 OF 3 NODES ONLINE · 2 MODELS ACTIVE · NO ALERTS");
    expect(labSummary(1, 1, 1, 1)).toBe("1 OF 1 NODE ONLINE · 1 MODEL ACTIVE · 1 ALERT");
  });
});

describe("primary/worker role", () => {
  it("makes a deployment on a head node PRIMARY regardless of rank", () => {
    const head = spark({ id: "h", role: "head" });
    const a = view({ deployment: dep("r1", "m1", { display: "stopped" }), nodes: [spark({ id: "w", role: "worker" })] });
    const b = view({ deployment: dep("r2", "m2"), nodes: [head] });
    expect(roleOf(b, [a, b])).toBe("PRIMARY");
    expect(roleOf(a, [a, b])).toBe("WORKER");
  });

  it("falls back to the top-ranked active deployment as PRIMARY", () => {
    const a = view({ deployment: dep("r1", "m1"), key: "a" });
    const b = view({ deployment: dep("r2", "m2"), key: "b" });
    expect(roleOf(a, [a, b])).toBe("PRIMARY");
    expect(roleOf(b, [a, b])).toBe("WORKER");
  });

  it("honours an explicit config role FIRST, overriding node + rank heuristics", () => {
    const head = spark({ id: "h", role: "head" });
    const declaredPrimary = view({ deployment: dep("r1", "m1", { role: "primary" }), key: "p", nodes: [spark({ id: "w", role: "worker" })] });
    const declaredWorker = view({ deployment: dep("r2", "m2", { role: "worker" }), key: "w", nodes: [head] });
    expect(roleOf(declaredPrimary, [declaredPrimary, declaredWorker])).toBe("PRIMARY");
    expect(roleOf(declaredWorker, [declaredPrimary, declaredWorker])).toBe("WORKER");
    const edge = view({ deployment: dep("r3", "m3", { role: "edge" }), key: "e" });
    expect(roleOf(edge, [edge])).toBe("WORKER");
  });

  it("keeps the heuristic when no role is configured (backward compatible)", () => {
    const a = view({ deployment: dep("r1", "m1", { role: null }), key: "a" });
    const b = view({ deployment: dep("r2", "m2", { role: null }), key: "b" });
    expect(roleOf(a, [a, b])).toBe("PRIMARY");
  });

  it("ranks live states ahead of idle and never hard-codes a model", () => {
    const idle = view({ key: "idle", modelName: "zzz", deployment: dep("r1", "zzz") });
    const busy = view({ key: "busy", modelName: "aaa", deployment: dep("r2", "aaa") });
    const ranked = rankViews([idle, busy], ["idle", "busy"]);
    expect(ranked[0].key).toBe("busy");
  });
});

describe("state pill selection", () => {
  it("maps every state to a label + tone", () => {
    expect(stateLabel("serving")).toBe("SERVING");
    expect(stateLabel("idle")).toBe("IDLE");
    const tones: StateTone[] = ["serving", "busy", "ready", "idle", "unknown", "degraded", "offline"].map((s) =>
      stateTone(s as Parameters<typeof stateTone>[0])
    );
    expect(tones).toEqual(["live", "live", "calm", "calm", "off", "warn", "alert"]);
  });
});

describe("secondary instruments", () => {
  const telemetry = {
    generationTps: 100, prefillTps: 500, ttftSeconds: 0.3, requestsRunning: 2, requestsWaiting: 5,
    kvCacheUsage: 0.5, prefixCacheHitRate: 0.9, mtpAcceptanceRate: 0.7, contextLength: 32000,
    gpuMemoryUtilization: 0.8, slotsActive: 2, slotsTotal: 4, totalOutputTokens: 10, backend: "" as never,
    modelId: "m", available: true, error: null,
  };

  it("only surfaces metrics the runtime actually declares", () => {
    const out = secondaryInstruments(["mtpAcceptanceRate", "ttftSeconds"], telemetry);
    expect(out.map((s) => s.key)).toEqual(["mtpAcceptanceRate", "ttftSeconds"]);
  });

  it("omits null values and never fabricates", () => {
    const out = secondaryInstruments(["kvCacheUsage", "requestsWaiting"], { ...telemetry, kvCacheUsage: null });
    expect(out.map((s) => s.key)).toEqual(["requestsWaiting"]);
  });

  it("returns nothing when the runtime declares nothing or telemetry is absent", () => {
    expect(secondaryInstruments([], telemetry)).toEqual([]);
    expect(secondaryInstruments(["ttftSeconds"], null)).toEqual([]);
  });
});

describe("recency", () => {
  it("formats seconds/minutes/hours or null when unknown", () => {
    const now = 1_000_000;
    expect(lastRequestAgo(now - 30_000, now)).toBe("30s ago");
    expect(lastRequestAgo(now - 5 * 60_000, now)).toBe("5m ago");
    expect(lastRequestAgo(null, now)).toBeNull();
  });
});
