import { describe, it, expect } from "vitest";
import { computeFleetHealth, computeFleetAlerts, attentionNodeIds, nodeHealthRail, nodeMatchesRail } from "./fleetModel";
import type { SparkSnapshot, DeploymentStatus } from "../../api/types";

function spark(over: Partial<SparkSnapshot> = {}): SparkSnapshot {
  return {
    id: "n1",
    name: "Node 1",
    online: true,
    uptime: 100,
    disabledDevices: [],
    disabledInterfaces: [],
    llmPort: 8888,
    llmPorts: [8888],
    hardware: { device: "x", cpuModel: "x", cpuCores: 0, totalMemoryGB: 0, gpuChip: "x", cudaDriver: null, storageModel: null },
    metrics: {
      gpu: null,
      cpu: null,
      ram: null,
      storage: [],
      network: null,
      unifiedMemory: null,
      llm: [],
      comfy: null,
      tailscale: null,
    },
    ...over,
  } as SparkSnapshot;
}

const DISPLAY_BY_STATE: Record<DeploymentStatus["state"], DeploymentStatus["display"]> = {
  available: "available",
  starting: "starting",
  loading: "loading",
  running: "running",
  stopping: "stopping",
  stopped: "stopped",
  error: "degraded",
};

function dep(recipeId: string, state: DeploymentStatus["state"], modelId = "m"): DeploymentStatus {
  return {
    recipeId,
    modelId,
    nodeIds: ["n1"],
    apiPort: 8889,
    managedBy: "sparkdash",
    dryRun: true,
    state,
    desired: state === "running" ? "running" : "stopped",
    observed: state === "running" ? "running" : "not-detected",
    discovered: false,
    display: DISPLAY_BY_STATE[state],
    lastOp: null,
    lastError: null,
    startedAt: null,
    updatedAt: 0,
  };
}

describe("fleetModel", () => {
  it("rolls up node/model/alert counts and fleet throughput", () => {
    const sparks = [
      spark({ id: "a", metrics: { ...spark().metrics, llm: [{ available: true, generationTps: 60 } as never] } }),
      spark({ id: "b", online: false }),
    ];
    const h = computeFleetHealth(sparks, [dep("r1", "running"), dep("r2", "loading"), dep("r3", "error")]);
    expect(h.nodesOnline).toBe(1);
    expect(h.nodesTotal).toBe(2);
    expect(h.modelsRunning).toBe(1);
    expect(h.modelsLoading).toBe(1);
    expect(h.fleetDecodeTps).toBe(60);
    expect(h.activeAlerts).toBeGreaterThanOrEqual(2); // offline node + error deployment
  });

  it("flags offline nodes, thermal throttle and full disks", () => {
    const sparks = [
      spark({ id: "off", online: false }),
      spark({
        id: "hot",
        metrics: {
          ...spark().metrics,
          gpu: { temperature: 95, usage: 50, power: { draw: 100, limit: 200 }, vram: { used: 1, total: 2, percentage: 50, available: 1 }, throttle: { thermal: true, hwSlowdown: false, powerCap: false, active: true, reason: "thermal", smClockMHz: null, smClockMaxMHz: null, smClockPct: null, detail: "" } } as never,
          storage: [{ device: "/dev/nvme0", label: "root", used: 95, total: 100, available: 5, percentage: 95, readSpeed: 0, writeSpeed: 0 }] as never,
        },
      }),
    ];
    const ids = computeFleetAlerts(sparks, []).map((a) => a.id);
    expect(ids).toContain("off-offline");
    expect(ids).toContain("hot-throttle");
    expect(ids).toContain("hot-temp");
    expect(ids).toContain("hot-disk-/dev/nvme0");
  });

  it("ignores disabled disks", () => {
    const sparks = [
      spark({
        id: "n",
        metrics: {
          ...spark().metrics,
          storage: [{ device: "/dev/sda", label: "backup", used: 99, total: 100, available: 1, percentage: 99, readSpeed: 0, writeSpeed: 0, disabled: true }] as never,
        },
      }),
    ];
    expect(computeFleetAlerts(sparks, [])).toHaveLength(0);
  });
});
import { deploymentViews, deploymentDecodeTps, friendlyName, allNodes } from "./fleetModel";
import type { RecipePublic, ModelEntry } from "../../api/types";

function recipe(over: Partial<RecipePublic> = {}): RecipePublic {
  return {
    id: "r1", modelId: "m", name: "R1", runtime: "vllm", topology: "tp2", nodeIds: ["a", "b"],
    modelPath: "/x", workdir: "/x", logDir: null, apiPort: 8888, healthPath: "/v1/models",
    contextLength: 600000, cpuAffinity: null, launcher: null, metadata: {}, notes: "", env: [],
    archived: false, createdAt: 0, updatedAt: 0, ...over,
  } as RecipePublic;
}

describe("council-pass helpers", () => {
  it("friendlyName prefers the registry name", () => {
    const models: ModelEntry[] = [{ id: "m", name: "DeepSeek V4.1 Flash", family: null, notes: "", archived: false, createdAt: 0, updatedAt: 0 }];
    expect(friendlyName("m", models)).toBe("DeepSeek V4.1 Flash");
    expect(friendlyName("unknown", models)).toBe("unknown");
  });

  it("allNodes never drops workers", () => {
    const sparks = [spark({ id: "w", role: "worker", workerNode: true } as never), spark({ id: "h" })];
    expect(allNodes(sparks).map((s) => s.id)).toEqual(["w", "h"]);
  });

  it("deploymentDecodeTps matches llm series by apiPort index only", () => {
    const node = spark({
      id: "a",
      llmPorts: [8888, 8889],
      metrics: {
        ...spark().metrics,
        llm: [
          { available: true, generationTps: 64 } as never,
          { available: true, generationTps: 999 } as never,
        ],
      },
    });
    const d = { ...dep("r1", "running", "m"), nodeIds: ["a"], apiPort: 8888 }; // → index 0
    expect(deploymentDecodeTps([node], d)).toBe(64);
    const wrong = { ...d, apiPort: 7777 };
    expect(deploymentDecodeTps([node], wrong)).toBeNull();
  });

  it("deploymentViews joins recipe, friendly name and member nodes", () => {
    const sparks = [spark({ id: "a", name: "Spark A" }), spark({ id: "b", name: "Spark B", role: "worker" } as never)];
    const models: ModelEntry[] = [{ id: "m", name: "DeepSeek V4.1 Flash", family: null, notes: "", archived: false, createdAt: 0, updatedAt: 0 }];
    const views = deploymentViews(sparks, [{ ...dep("r1", "running"), nodeIds: ["a", "b"] }], [recipe()], models);
    expect(views).toHaveLength(1);
    expect(views[0].modelName).toBe("DeepSeek V4.1 Flash");
    expect(views[0].nodes.map((n) => n.name)).toEqual(["Spark A", "Spark B"]);
    expect(views[0].topology).toBe("tp2");
    expect(views[0].contextLength).toBe(600000);
  });

  it("aggregates unified-memory pressure into one deployment-targeted alert", () => {
    const mk = (id: string, name: string) =>
      spark({ id, name, metrics: { ...spark().metrics, unifiedMemory: { total: 128, used: 120, gpuUsed: 100, cpuUsed: 20, available: 8, percentage: 94, oomRisk: "high", bandwidth: { current: 0, peak: 0 } } } as never });
    const alerts = computeFleetAlerts([mk("a", "Spark A"), mk("b", "Spark B")], [{ ...dep("r1", "running"), nodeIds: ["a", "b"] }]);
    const oom = alerts.filter((x) => x.id === "oom-pressure");
    expect(oom).toHaveLength(1);
    expect(oom[0].message).toContain("Spark A, Spark B");
    expect(oom[0].target).toEqual({ section: "model", modelId: "m" });
  });

  it("surfaces stopped deployments with lastError context", () => {
    const d = { ...dep("r1", "stopped"), lastError: "probe auth failed" };
    const alerts = computeFleetAlerts([], [d]);
    expect(alerts[0].message).toContain("probe auth failed");
    expect(alerts[0].severity).toBe("warn");
  });
});

import { deploymentTabCounts, deploymentMatchesTab, attentionDigest, familyGroups, modelGlyph, externalConnectView, errorLogLines, isErrorRow, runtimeLabel } from "./fleetModel";
import type { ActivityEvent } from "../../api/types";

describe("TP2 polish helpers", () => {
  it("counts every deployment status tab in fixed order", () => {
    const deps = [dep("r1", "running"), dep("r2", "running"), dep("r3", "stopped"), dep("r4", "loading"), dep("r5", "error")];
    const counts = deploymentTabCounts(deps);
    expect(counts.map((c) => c.key)).toEqual(["all", "running", "starting", "attention", "stopped"]);
    expect(counts.find((c) => c.key === "all")?.count).toBe(5);
    expect(counts.find((c) => c.key === "running")?.count).toBe(2);
    expect(counts.find((c) => c.key === "attention")?.count).toBe(1);
  });

  it("matches rows against a tab filter", () => {
    expect(deploymentMatchesTab(dep("r1", "running"), "all")).toBe(true);
    expect(deploymentMatchesTab(dep("r1", "running"), "stopped")).toBe(false);
    expect(deploymentMatchesTab(dep("r1", "running"), "running")).toBe(true);
    expect(deploymentMatchesTab({ ...dep("r1", "running"), display: "running-external" }, "running")).toBe(true);
  });

  it("flags error rows for inline expansion", () => {
    expect(isErrorRow({ ...dep("r1", "error") })).toBe(true);
    expect(isErrorRow({ ...dep("r1", "running"), lastError: "boom" })).toBe(true);
    expect(isErrorRow(dep("r1", "running"))).toBe(false);
  });

  it("collapses the attention digest by condition + resource with an xN count", () => {
    const sparks = [
      spark({
        id: "n",
        metrics: {
          ...spark().metrics,
          storage: [
            { device: "/dev/a", label: "a", used: 95, total: 100, available: 5, percentage: 95, readSpeed: 0, writeSpeed: 0 },
            { device: "/dev/b", label: "b", used: 96, total: 100, available: 4, percentage: 96, readSpeed: 0, writeSpeed: 0 },
          ] as never,
        },
      }),
    ];
    const digest = attentionDigest(sparks, []);
    const disk = digest.find((d) => d.id.startsWith("disk:"));
    expect(disk?.count).toBe(2);
  });

  it("groups the catalog by family with variant counts", () => {
    const models: ModelEntry[] = [
      { id: "a", name: "Alpha One", family: "Alpha", notes: "", archived: false, createdAt: 0, updatedAt: 0 },
      { id: "b", name: "Alpha Two", family: "Alpha", notes: "", archived: false, createdAt: 0, updatedAt: 0 },
      { id: "c", name: "Lone", family: null, notes: "", archived: false, createdAt: 0, updatedAt: 0 },
    ];
    const groups = familyGroups(models, []);
    expect(groups.find((g) => g.family === "Alpha")?.variantCount).toBe(2);
    expect(groups[groups.length - 1].family).toBe("Other");
  });

  it("derives a deterministic monogram", () => {
    expect(modelGlyph("Qwen Flash Next")).toBe("QF");
    expect(modelGlyph("Solo")).toBe("SO");
    expect(modelGlyph("  ")).toBe("??");
  });

  it("maps each runtime id to its registry label, raw-id for unknown", () => {
    const labels = { vllm: "vLLM", "tabbyapi-exl3": "TabbyAPI", sglang: "SGLang" };
    expect(runtimeLabel("vllm", labels)).toBe("vLLM");
    expect(runtimeLabel("tabbyapi-exl3", labels)).toBe("TabbyAPI");
    expect(runtimeLabel("sglang", labels)).toBe("SGLang");
    expect(runtimeLabel("llama.cpp")).toBe("llama.cpp");
    expect(runtimeLabel("custom", labels)).toBe("its launcher");
    expect(runtimeLabel(null)).toBe("its launcher");
  });

  it("builds a read-only external connect view only for external deployments", () => {
    const node = spark({ id: "a", name: "Spark A", lanIp: "10.0.0.5" });
    const labels = { "tabbyapi-exl3": "TabbyAPI", vllm: "vLLM" };
    const external = { ...dep("r1", "running"), managedBy: "external" as const, apiPort: 8889, nodeIds: ["a"] };
    const view = externalConnectView(external, recipe({ runtime: "tabbyapi-exl3", env: [{ name: "KEY", secret: true, hasValue: true }] }), [node], labels);
    expect(view?.endpoint).toBe("http://10.0.0.5:8889/v1");
    expect(view?.hasKey).toBe(true);
    expect(view?.note).toContain("TabbyAPI");
    expect(externalConnectView(dep("r1", "running"), null, [node])).toBeNull();

    // The note must follow the recipe runtime, not hardcode TabbyAPI.
    const vllmNote = externalConnectView(external, recipe({ runtime: "vllm" }), [node], labels);
    expect(vllmNote?.note).toContain("manage via vLLM");
    expect(vllmNote?.note).not.toContain("TabbyAPI");

    // A non-secret env var must NOT raise the masked-key affordance.
    const plain = externalConnectView(external, recipe({ env: [{ name: "PORT", secret: false, value: "8889" }] }), [node]);
    expect(plain?.hasKey).toBe(false);
  });

  it("selects the last N activity lines for an error row", () => {
    const feed: ActivityEvent[] = Array.from({ length: 14 }, (_, i) => ({
      seq: i, ts: new Date(i).toISOString(), kind: "lifecycle", subject: "r1", summary: `line ${i}`, attribution: null, meta: null,
    }));
    const picked = errorLogLines(feed, ["r1"], 10);
    expect(picked).toHaveLength(10);
    expect(picked[0].summary).toBe("line 0");
  });

  it("attention rail matches only genuinely attention nodes and hides when empty", () => {
    const healthy = spark({ id: "ok", name: "OK" });
    const offline = spark({ id: "off", name: "Off", online: false });
    const hot = spark({ id: "hot", name: "Hot", metrics: { ...spark().metrics, gpu: { temperature: 95 } as never } });
    const degraded = { ...dep("r1", "error"), nodeIds: ["ok"] };
    const sparks = [healthy, offline, hot];

    const attention = attentionNodeIds(sparks, [degraded]);
    expect([...attention].sort()).toEqual(["hot", "off", "ok"]);
    expect(nodeMatchesRail(healthy, "attention", [degraded])).toBe(true);
    expect(nodeMatchesRail(hot, "attention", [degraded])).toBe(true);
    expect(nodeMatchesRail(offline, "attention", [degraded])).toBe(true);

    const clean = spark({ id: "clean", name: "Clean" });
    expect(nodeMatchesRail(clean, "attention", [])).toBe(false);
    expect(nodeHealthRail([clean], []).map((r) => r.key)).not.toContain("attention");
    expect(nodeHealthRail(sparks, [degraded]).find((r) => r.key === "attention")?.count).toBe(3);
  });
});

import { deploymentTelemetry, deriveRuntimeState } from "./fleetModel";
import type { LlmMetrics } from "../../api/types";

/** Minimal LlmMetrics series; absent fields stay undefined (never fabricated). */
function llm(over: Partial<LlmMetrics> = {}): LlmMetrics {
  return { available: true, generationTps: 0, ...over } as LlmMetrics;
}

function nodeWithLlm(id: string, over: Partial<SparkSnapshot> = {}, series: Partial<LlmMetrics> = {}): SparkSnapshot {
  return spark({
    id,
    llmPort: 8889,
    llmPorts: [8889],
    metrics: { ...spark().metrics, llm: [llm(series)] },
    ...over,
  });
}

describe("deploymentTelemetry", () => {
  it("reads primary-node fields and nulls absent ones", () => {
    const d = { ...dep("r1", "running"), nodeIds: ["a"] };
    const t = deploymentTelemetry([nodeWithLlm("a", { uptime: 500 }, { ttftSeconds: 0.4, requestsRunning: 2 })], d)!;
    expect(t.ttftSeconds).toBe(0.4);
    expect(t.requestsRunning).toBe(2);
    expect(t.kvCacheUsage).toBeNull();
    expect(t.mtpAcceptanceRate).toBeNull();
    expect(t.slotsTotal).toBeNull();
  });

  it("sums generationTps across member nodes but takes ttft from the coordinator", () => {
    const d = { ...dep("r1", "running"), nodeIds: ["head", "worker"] };
    const sparks = [
      nodeWithLlm("head", { role: "head" }, { generationTps: 40, ttftSeconds: 0.5 }),
      nodeWithLlm("worker", { role: "worker" }, { generationTps: 60, ttftSeconds: 9 }),
    ];
    const t = deploymentTelemetry(sparks, d)!;
    expect(t.generationTps).toBe(100);
    expect(t.ttftSeconds).toBe(0.5);
  });

  it("returns null when no member node exposes a probe series", () => {
    expect(deploymentTelemetry([spark({ id: "a" })], { ...dep("r1", "running"), nodeIds: ["a"] })).toBeNull();
  });
});

describe("deriveRuntimeState", () => {
  it("reads loaded-but-idle as idle when it has served, else ready — never a scary 0", () => {
    const d = dep("r1", "running");
    const loaded = { ...deploymentTelemetry([nodeWithLlm("n1", {}, { slotsTotal: 4, modelId: "m" })], d)! };
    expect(deriveRuntimeState(d, { ...loaded, totalOutputTokens: 900 })).toBe("idle");
    expect(deriveRuntimeState(d, { ...loaded, totalOutputTokens: 0 })).toBe("ready");
  });

  it("prioritises offline > degraded > busy > serving", () => {
    const d = dep("r1", "running");
    const hot = deploymentTelemetry([nodeWithLlm("n1", {}, { generationTps: 50, requestsWaiting: 3 })], d)!;
    expect(deriveRuntimeState(d, hot)).toBe("busy");
    expect(deriveRuntimeState(d, { ...hot, requestsWaiting: 0 })).toBe("serving");
    expect(deriveRuntimeState({ ...d, observed: "unhealthy" }, hot)).toBe("degraded");
    expect(deriveRuntimeState({ ...d, display: "stopped" }, hot)).toBe("offline");
  });

  it("returns unknown for missing probe data and never fabricates", () => {
    expect(deriveRuntimeState(dep("r1", "running"), null)).toBe("unknown");
    const t = deploymentTelemetry([nodeWithLlm("n1", {}, { available: false })], dep("r1", "running"))!;
    expect(t.generationTps).toBeNull();
    expect(deriveRuntimeState(dep("r1", "running"), t)).toBe("unknown");
  });

  it("reads an auth-gated external runtime as healthy ready, never degraded", () => {
    const qwen = {
      ...dep("r1", "running"),
      managedBy: "external" as const,
      desired: "unknown" as const,
      observed: "auth-gated" as const,
      display: "running-external" as const,
    };
    // No readable metrics at all: still loaded + serving-capable.
    expect(deriveRuntimeState(qwen, null)).toBe("ready");
    // 401 on the probe is proof of a live gated process, not a failure.
    const gated = deploymentTelemetry([nodeWithLlm("n1", {}, { available: false, error: "HTTP 401" })], qwen)!;
    expect(deriveRuntimeState(qwen, gated)).toBe("ready");
    // An external runtime whose endpoint answers but carries no load detail.
    const observedRunning = { ...dep("r1", "running"), managedBy: "external" as const, observed: "running" as const, display: "running-external" as const };
    const bare = deploymentTelemetry([nodeWithLlm("n1", {})], observedRunning)!;
    expect(deriveRuntimeState(observedRunning, bare)).not.toBe("degraded");
  });

  it("keeps degraded for genuinely unhealthy signals only", () => {
    const d = dep("r1", "running");
    expect(deriveRuntimeState({ ...d, display: "degraded" }, null)).toBe("degraded");
    expect(deriveRuntimeState({ ...d, observed: "unhealthy" }, null)).toBe("degraded");
    // Managed deployment whose readable probe hard-fails.
    const refused = deploymentTelemetry([nodeWithLlm("n1", {}, { available: false, error: "ECONNREFUSED" })], d)!;
    expect(deriveRuntimeState(d, refused)).toBe("degraded");
    const timeout = deploymentTelemetry([nodeWithLlm("n1", {}, { available: false, error: "TimeoutError" })], d)!;
    expect(deriveRuntimeState(d, timeout)).toBe("degraded");
    // External hard-fail is NOT degraded.
    const ext = { ...d, managedBy: "external" as const, observed: "running" as const, display: "running-external" as const };
    expect(deriveRuntimeState(ext, refused)).not.toBe("degraded");
  });

  it("still reads serving/busy from readable metrics for a healthy external runtime", () => {
    const ext = { ...dep("r1", "running"), managedBy: "external" as const, observed: "auth-gated" as const, display: "running-external" as const };
    const hot = deploymentTelemetry([nodeWithLlm("n1", {}, { generationTps: 50, requestsWaiting: 2 })], ext)!;
    expect(deriveRuntimeState(ext, hot)).toBe("busy");
    expect(deriveRuntimeState(ext, { ...hot, requestsWaiting: 0 })).toBe("serving");
  });
});

describe("deploymentViews telemetry wiring", () => {
  it("attaches telemetry and primary-node uptime", () => {
    const [view] = deploymentViews([nodeWithLlm("n1", { uptime: 42 })], [dep("r1", "running")], [recipe()]);
    expect(view.telemetry?.available).toBe(true);
    expect(view.uptime).toBe(42);
  });
});
