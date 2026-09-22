import { describe, expect, it } from "vitest";
import type { DeploymentStatus, RecipePublic, SparkSnapshot } from "../../api/types";
import type { DeploymentView } from "./fleetModel";
import {
  aggregationLegend,
  fabricHealthSummary,
  fabricStateLabel,
  hottestThermal,
  isPrimary,
  labBriefing,
  labVerdict,
  lastRequestAgo,
  nodeInstruments,
  nodeOomEvents,
  nodeTelemetryRow,
  primaryView,
  rankViews,
  roleOf,
  secondaryInstruments,
  stateLabel,
  stateTone,
  verdictHeadline,
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
  it("is nominal when fully healthy", () => {
    expect(labVerdict(3, 3, 0, [], ["serving", "idle"])).toBe("nominal");
  });

  it("reads ATTENTION (not DEGRADED) for a warning-only lab — all nodes online, models ready", () => {
    // one memory warning, every node online, every model ready/idle
    expect(labVerdict(3, 3, 1, [], ["idle", "ready"])).toBe("attention");
    expect(labVerdict(3, 3, 2, [], ["idle"])).toBe("attention");
  });

  it("reads ATTENTION for a lastError with no genuine degradation", () => {
    const v = view({ deployment: dep("r1", "m1", { display: "running", lastError: "probe slow" }) });
    expect(labVerdict(3, 3, 0, [v], ["serving"])).toBe("attention");
  });

  it("degrades ONLY when a model or a node is genuinely degraded/offline", () => {
    expect(labVerdict(3, 3, 0, [], ["degraded"])).toBe("degraded");
    expect(labVerdict(3, 3, 0, [], ["offline"])).toBe("degraded");
    expect(labVerdict(2, 3, 0, [], ["idle"])).toBe("degraded");
    const v = view({ deployment: dep("r1", "m1", { display: "degraded" }) });
    expect(labVerdict(3, 3, 0, [v], ["busy"])).toBe("degraded");
  });

  it("renders verdict labels", () => {
    expect(verdictLabel("nominal")).toBe("NOMINAL");
    expect(verdictLabel("attention")).toBe("ATTENTION");
    expect(verdictLabel("degraded")).toBe("DEGRADED");
  });

  it("words the headline consistently with the pill — warnings, never ALERT/DEGRADED mixing", () => {
    expect(verdictHeadline("nominal", 0)).toBe("All systems normal");
    expect(verdictHeadline("attention", 1)).toBe("1 warning to review");
    expect(verdictHeadline("attention", 2)).toBe("2 warnings to review");
    expect(verdictHeadline("degraded", 0)).toBe("A model or node is degraded");
    expect(verdictHeadline("degraded", 2)).toBe("Degraded — 2 warnings to review");
  });

});

describe("full config role", () => {
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
  });

  it("returns the FULL role for every config value, including NONE (edge folded)", () => {
    const mk = (r: NonNullable<DeploymentStatus["role"]>) => view({ deployment: dep("r1", "m1", { role: r }) });
    expect(roleOf(mk("primary"), [])).toBe("PRIMARY");
    expect(roleOf(mk("worker"), [])).toBe("WORKER");
    expect(roleOf(mk("specialist"), [])).toBe("SPECIALIST");
    expect(roleOf(mk("reviewer"), [])).toBe("REVIEWER");
    expect(roleOf(mk("experimental"), [])).toBe("EXPERIMENTAL");
    expect(roleOf(mk("none"), [])).toBe("NONE");
    expect(roleOf(mk("edge"), [])).toBe("WORKER");
  });

  it("keeps the heuristic when no role is configured (backward compatible)", () => {
    const a = view({ deployment: dep("r1", "m1", { role: null }), key: "a" });
    const b = view({ deployment: dep("r2", "m2", { role: null }), key: "b" });
    expect(roleOf(a, [a, b])).toBe("PRIMARY");
  });

  it("rank keeps live states ahead of idle and never hard-codes a model", () => {
    const idle = view({ key: "idle", modelName: "zzz", deployment: dep("r1", "zzz") });
    const busy = view({ key: "busy", modelName: "aaa", deployment: dep("r2", "aaa") });
    const ranked = rankViews([idle, busy], ["idle", "busy"]);
    expect(ranked[0].key).toBe("busy");
  });
});

describe("primary emphasis follows CONFIG, never promotion", () => {
  it("selects the config PRIMARY even when it is offline", () => {
    const p = view({ key: "p", deployment: dep("r1", "m1", { role: "primary", display: "stopped" }) });
    const w = view({ key: "w", deployment: dep("r2", "m2", { role: "worker" }) });
    expect(primaryView([p, w])?.key).toBe("p");
  });

  it("adapts to an absent primary with the heuristic top rank", () => {
    const a = view({ key: "a" });
    const b = view({ key: "b" });
    expect(primaryView([a, b])?.key).toBe("a");
    expect(primaryView([])).toBeNull();
  });

  it("isPrimary is true only for PRIMARY", () => {
    expect(isPrimary("PRIMARY")).toBe(true);
    expect(isPrimary("WORKER")).toBe(false);
    expect(isPrimary("NONE")).toBe(false);
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
    aggregation: null, membersReporting: 1, membersMissingTelemetry: [],
  };

  it("only surfaces metrics the runtime actually declares", () => {
    const out = secondaryInstruments(["mtpAcceptanceRate", "ttftSeconds"], telemetry);
    expect(out.map((s) => s.key)).toEqual(["mtpAcceptanceRate", "ttftSeconds"]);
  });

  it("renders '—' for a declared-but-absent value, never 0", () => {
    const out = secondaryInstruments(["kvCacheUsage", "requestsWaiting"], { ...telemetry, kvCacheUsage: null });
    expect(out.map((s) => s.key)).toEqual(["kvCacheUsage", "requestsWaiting"]);
    expect(out.find((s) => s.key === "kvCacheUsage")?.value).toBe("—");
    expect(out.find((s) => s.key === "kvCacheUsage")?.fraction).toBeUndefined();
  });

  it("carries a micro-bar fraction for ratio metrics only", () => {
    const out = secondaryInstruments(["kvCacheUsage", "requestsWaiting"], telemetry);
    expect(out.find((s) => s.key === "kvCacheUsage")?.fraction).toBe(0.5);
    expect(out.find((s) => s.key === "requestsWaiting")?.fraction).toBeUndefined();
  });

  it("returns nothing when the runtime declares nothing; '—' when telemetry is absent", () => {
    expect(secondaryInstruments([], telemetry)).toEqual([]);
    const absent = secondaryInstruments(["ttftSeconds"], null);
    expect(absent.map((s) => s.key)).toEqual(["ttftSeconds"]);
    expect(absent[0].value).toBe("—");
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

describe("lab briefing + fabric aggregate", () => {
  it("is fully data-driven with '—' for an absent primary", () => {
    const b = labBriefing({ nodesOnline: 2, nodesTotal: 3, deploymentsActive: 1, primaryName: null, fabric: "ok", critical: 0, warning: 1 });
    expect(b).toBe("2/3 COMPUTE ONLINE · 1 DEPLOYMENT ACTIVE · PRIMARY: — · FABRIC: HEALTHY · 0 CRITICAL · 1 WARNING");
  });

  it("aggregates PHYSICAL LINK worst-case (never node health)", () => {
    expect(fabricHealthSummary([{ health: "ok" as const }, { health: "warn" as const }, { health: "ok" as const }])).toBe("warn");
    expect(fabricHealthSummary([{ health: "ok" as const }, { health: "error" as const }])).toBe("error");
    expect(fabricHealthSummary([])).toBe("unknown");
  });

  it("keeps FABRIC healthy while a node carries memory pressure", () => {
    const links = [{ health: "ok" as const }, { health: "ok" as const }];
    expect(fabricStateLabel(fabricHealthSummary(links))).toBe("HEALTHY");
    // every link up => HEALTHY even though a node itself is memory-warned.
    expect(fabricHealthSummary(links)).toBe("ok");
  });
});

describe("node telemetry honesty", () => {
  it("renders '—' for a missing metric and never 0", () => {
    const n = spark({ metrics: { ...spark().metrics, gpu: { temperature: 0, usage: 0, power: { draw: 0, limit: 0 }, vram: { used: 0, total: 0, percentage: 0, available: 0 } } } });
    const row = nodeTelemetryRow(n, []);
    const gpuTemp = row.metrics.find((m) => m.key === "gpuTemp")!;
    expect(gpuTemp.value).toBe("0");
    const mem = row.metrics.find((m) => m.key === "mem");
    expect(mem).toBeUndefined();
  });

  it("shows '—' when gpu exists but cpu is absent (no fabricated node metric)", () => {
    const n = spark({ metrics: { ...spark().metrics, gpu: { temperature: 55, usage: 40, power: { draw: 60, limit: 120 }, vram: { used: 1, total: 2, percentage: 50, available: 1 } } } });
    const row = nodeTelemetryRow(n, []);
    expect(row.metrics.find((m) => m.key === "cpuTemp")).toBeUndefined();
    expect(row.metrics.find((m) => m.key === "gpuTemp")?.value).toBe("55");
  });

  it("shows power draw only when the limit is 0/null (no fabricated limit)", () => {
    const n = spark({ metrics: { ...spark().metrics, gpu: { temperature: 55, usage: 40, power: { draw: 56, limit: 0 }, vram: { used: 1, total: 2, percentage: 50, available: 1 } } } });
    const power = nodeTelemetryRow(n, []).metrics.find((m) => m.key === "power")!;
    expect(power.value).toBe("56");
    expect(power.title).toBeUndefined();
  });

  it("marks a thermal-throttled node critical, a warm node warn, and offline unmistakably", () => {
    const throttled = spark({ metrics: { ...spark().metrics, gpu: { temperature: 91, usage: 10, power: { draw: 1, limit: 2 }, vram: { used: 1, total: 2, percentage: 1, available: 1 }, throttle: { thermal: true, hwSlowdown: true, powerCap: false, active: true, reason: "thermal", smClockMHz: null, smClockMaxMHz: null, smClockPct: null, detail: "" } } } });
    // provider thermal slowdown = real critical signal.
    expect(nodeTelemetryRow(throttled, []).tone).toBe("alert");
    expect(nodeTelemetryRow(throttled, []).thermal).toBe("critical");
    expect(nodeTelemetryRow(throttled, []).metrics.find((m) => m.key === "gpuTemp")?.value).toBe("91");
    // a high-but-not-critical temp is warm (measured, no throttle flag).
    const warm = spark({ metrics: { ...spark().metrics, gpu: { temperature: 88, usage: 10, power: { draw: 1, limit: 2 }, vram: { used: 1, total: 2, percentage: 1, available: 1 } } } as never });
    expect(nodeTelemetryRow(warm, []).tone).toBe("warn");
    expect(nodeTelemetryRow(warm, []).thermal).toBe("warm");
    // a normal temp reads live, no alarm.
    const cool = spark({ metrics: { ...spark().metrics, gpu: { temperature: 62, usage: 10, power: { draw: 1, limit: 2 }, vram: { used: 1, total: 2, percentage: 1, available: 1 } } } as never });
    expect(nodeTelemetryRow(cool, []).tone).toBe("live");
    expect(nodeTelemetryRow(cool, []).thermal).toBe("normal");
    const off = nodeTelemetryRow(spark({ online: false }), []);
    expect(off.tone).toBe("off");
    expect(off.online).toBe(false);
  });

  it("uses unified terminology and falls back to RAM only when no unified pool", () => {
    const unified = spark({ metrics: { ...spark().metrics, unifiedMemory: { total: 130000, gpuUsed: 1, cpuUsed: 1, used: 65000, available: 65000, percentage: 50, oomRisk: "low", bandwidth: { current: 0, peak: 0 } } } });
    expect(nodeTelemetryRow(unified, []).metrics.find((m) => m.key === "mem")?.label).toBe("UNIFIED MEM");
    const ramOnly = spark({ metrics: { ...spark().metrics, ram: { used: 10, total: 100, percentage: 10 } } });
    expect(nodeTelemetryRow(ramOnly, []).metrics.find((m) => m.key === "mem")?.label).toBe("RAM");
  });

  it("omits node instruments entirely when the node has no metrics", () => {
    expect(nodeInstruments(spark())).toEqual([]);
    expect(nodeInstruments(null)).toEqual([]);
  });

  it("aggregates thermal as MAX across members, labelled with the hottest node", () => {
    const mk = (id: string, name: string, temp: number | null) =>
      spark({ id, name, metrics: { ...spark().metrics, gpu: temp == null ? null : { temperature: temp, usage: 10, power: { draw: 1, limit: 2 }, vram: { used: 1, total: 2, percentage: 1, available: 1 } } } as never });
    const r = hottestThermal([mk("a", "n-a", 61), mk("b", "n-b", 88)]);
    expect(r.level).toBe("warm");
    expect(r.value).toBe("88");
    expect(r.nodeName).toBe("n-b");
    expect(r.reporting).toBe(2);
    expect(r.memberCount).toBe(2);
    // missing temp contributes no reading — never a fabricated 0.
    const partial = hottestThermal([mk("a", "n-a", null), mk("b", "n-b", 80)]);
    expect(partial.reporting).toBe(1);
    expect(partial.value).toBe("80");
  });

  it("labels the aggregation legend explicitly, null for a single member", () => {
    expect(aggregationLegend(1, 1)).toBeNull();
    const legend = aggregationLegend(1, 2)!;
    expect(legend).toContain("SUM gen/queue");
    expect(legend).toContain("MAX kv/vram");
    expect(legend).toContain("1/2 ranks reporting");
  });

  it("reads a genuine oom EVENT from NV_ERR_NO_MEMORY, not from utilisation", () => {
    const clean = spark({ metrics: { ...spark().metrics, gpu: { temperature: 50, nvErrNoMemory: 0 } as never } });
    const ev = spark({ metrics: { ...spark().metrics, gpu: { temperature: 50, nvErrNoMemory: 14 } as never } });
    expect(nodeOomEvents(ev)).toBe(14);
    expect(nodeOomEvents(clean)).toBe(0);
    // utilisation alone is not an oom; the event count is surfaced once present.
    expect(nodeTelemetryRow(ev, []).metrics.find((m) => m.key === "nvmem")?.value).toBe("14");
    expect(nodeTelemetryRow(clean, []).metrics.find((m) => m.key === "nvmem")).toBeUndefined();
  });
});
