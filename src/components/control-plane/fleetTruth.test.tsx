/**
 * P0 TRUTH-DEFECT regression suite — canonical inventory + identity association.
 *
 * Hermetic: pure fixtures, no network, no timers. Every association is by
 * stable id. A worker node never disappears; counters never disagree.
 */
import { describe, it, expect, vi } from "vitest";
import type { SparkSnapshot, DeploymentStatus, RecipePublic, ModelEntry, LlmMetrics } from "../../api/types";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import { FleetSection } from "./FleetSection";
import {
  fleetNodes,
  computeFleetHealth,
  deploymentViews,
  deploymentTelemetry,
  deriveRuntimeState,
  primaryNodeOf,
  nodeHealthRail,
} from "./fleetModel";
import { deriveFabric } from "./fabricModel";

const navigate = vi.fn();

function spark(over: Partial<SparkSnapshot> = {}): SparkSnapshot {
  const base = makeSpark(String(over.id ?? "n"));
  return { ...base, ...over } as SparkSnapshot;
}

function llm(over: Partial<LlmMetrics> = {}): LlmMetrics {
  return { available: true, generationTps: 0, ...over } as LlmMetrics;
}

/** Node with one LLM probe series on `port`. */
function nodeWithLlm(id: string, port: number, series: Partial<LlmMetrics> = {}, over: Partial<SparkSnapshot> = {}): SparkSnapshot {
  return spark({
    id,
    llmPort: port,
    llmPorts: [port],
    metrics: { ...spark({ id }).metrics, llm: [llm(series)] },
    ...over,
  });
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

function dep(recipeId: string, nodeIds: string[], modelId: string, apiPort: number, state: DeploymentStatus["state"] = "running"): DeploymentStatus {
  return {
    recipeId,
    modelId,
    nodeIds,
    apiPort,
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
  } as DeploymentStatus;
}

function recipe(id: string, nodeIds: string[], runtime = "vllm"): RecipePublic {
  return {
    id, modelId: "m", name: id, runtime, topology: nodeIds.length > 1 ? "tp2" : "single", nodeIds,
    modelPath: "/x", workdir: "/x", logDir: null, apiPort: 8888, healthPath: "/v1/models",
    contextLength: 4096, cpuAffinity: null, launcher: null, metadata: {}, notes: "", env: [],
    archived: false, lifecycleState: "validated", createdAt: 0, updatedAt: 0,
  } as RecipePublic;
}

function model(id: string, name: string): ModelEntry {
  return { id, name, family: null, notes: "", archived: false, createdAt: 0, updatedAt: 0 };
}

/** The canonical 3-node lab: #1 head + #2 worker on DeepSeek:8888, #3 standalone Qwen:8889. */
function lab(): { sparks: SparkSnapshot[]; deps: DeploymentStatus[]; models: ModelEntry[]; recipes: RecipePublic[] } {
  const sparks = [
    nodeWithLlm("s1", 8888, { modelId: "deepseek-hf", totalOutputTokens: 500 }, { role: "head", name: "Spark 1" }),
    nodeWithLlm("s2", 8888, { modelId: "deepseek-hf", generationTps: 0 }, { role: "worker", workerNode: true, workerHeadId: "s1", name: "Spark 2" }),
    nodeWithLlm("s3", 8889, { modelId: "qwen-hf", totalOutputTokens: 300 }, { role: "standalone", name: "Spark 3" }),
  ];
  return {
    sparks,
    deps: [dep("dDeep", ["s1", "s2"], "deepseek", 8888), dep("dQwen", ["s3"], "qwen", 8889)],
    models: [model("deepseek", "DeepSeek"), model("qwen", "Qwen")],
    recipes: [recipe("rDeep", ["s1", "s2"]), recipe("rQwen", ["s3"])],
  };
}

function viewSummary(views: ReturnType<typeof deploymentViews>) {
  return views
    .map((v) => ({
      key: v.key,
      rawModelId: v.rawModelId,
      modelName: v.modelName,
      nodes: v.nodes.map((n) => `${n.id}:${n.role}`),
      port: v.port,
      backend: v.telemetry?.backend ?? null,
      telemetryModelId: v.telemetry?.modelId ?? null,
      decodeTps: v.decodeTps,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

describe("canonical inventory truth", () => {
  it("(1) 3 configured nodes => Fleet renders exactly 3 rows", () => {
    const { sparks, deps, recipes, models } = lab();
    const { container } = render(
      <FleetSection sparks={sparks} deployments={deps} recipes={recipes} models={models} navigate={navigate} />
    );
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
  });

  it("(2) a worker node never disappears from the inventory nor the Fleet", () => {
    const { sparks, deps, recipes, models } = lab();
    expect(fleetNodes(sparks).map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    const { container } = render(
      <FleetSection sparks={sparks} deployments={deps} recipes={recipes} models={models} navigate={navigate} />
    );
    expect(container.textContent).toContain("Spark 2");
    expect(container.textContent).toContain("worker");
  });

  it("(3) Overview/Fleet/Fabric counters agree on the same canonical count", () => {
    const { sparks, deps } = lab();
    const inventory = fleetNodes(sparks).length;
    expect(computeFleetHealth(sparks, deps).nodesTotal).toBe(inventory);
    expect(nodeHealthRail(sparks, deps).find((r) => r.key === "all")?.count).toBe(inventory);
    expect(deriveFabric(sparks, deploymentViews(sparks, deps, [])).nodes).toHaveLength(inventory);
  });

  it("(4) reordering compute nodes changes no association", () => {
    const { sparks, deps, recipes, models } = lab();
    const before = viewSummary(deploymentViews(sparks, deps, recipes, models));
    const reordered = [...sparks].reverse();
    const after = viewSummary(deploymentViews(reordered, deps, recipes, models));
    expect(after).toEqual(before);
  });

  it("(5) reordering deployments changes no association", () => {
    const { sparks, deps, recipes, models } = lab();
    const before = viewSummary(deploymentViews(sparks, deps, recipes, models));
    const after = viewSummary(deploymentViews(sparks, [...deps].reverse(), recipes, models));
    expect(after).toEqual(before);
  });

  it("(6) reordering models keeps friendly names tied to the raw model id", () => {
    const { sparks, deps, recipes, models } = lab();
    const before = viewSummary(deploymentViews(sparks, deps, recipes, models));
    const after = viewSummary(deploymentViews(sparks, deps, recipes, [...models].reverse()));
    expect(after).toEqual(before);
  });

  it("(7) Qwen receives only Spark #3 telemetry", () => {
    const { sparks, deps, recipes, models } = lab();
    const qwen = deploymentViews(sparks, deps, recipes, models).find((v) => v.key === "dQwen")!;
    expect(qwen.nodes.map((n) => n.id)).toEqual(["s3"]);
    expect(qwen.telemetry?.modelId).toBe("qwen-hf");
    expect(deploymentTelemetry(sparks, deps[1])?.generationTps ?? 0).toBeLessThan(1);
  });

  it("(8) DeepSeek receives only Spark #1/#2 telemetry", () => {
    const { sparks, deps, recipes, models } = lab();
    const deep = deploymentViews(sparks, deps, recipes, models).find((v) => v.key === "dDeep")!;
    expect(deep.nodes.map((n) => n.id)).toEqual(["s1", "s2"]);
    expect(deep.telemetry?.modelId).toBe("deepseek-hf");
    expect(primaryNodeOf(sparks, deps[0])?.id).toBe("s1");
  });

  it("(12) adding Spark #4 does not alter existing associations", () => {
    const { sparks, deps, recipes, models } = lab();
    const before = viewSummary(deploymentViews(sparks, deps, recipes, models));
    const withFourth = [...sparks, nodeWithLlm("s4", 8889, { modelId: "other" }, { role: "standalone", name: "Spark 4" })];
    const after = viewSummary(deploymentViews(withFourth, deps, recipes, models));
    expect(after).toEqual(before);
    expect(fleetNodes(withFourth)).toHaveLength(4);
  });

  it("(13) a TP2→TP4 change follows explicit nodeIds membership, not position", () => {
    const { sparks, recipes, models } = lab();
    const tp4 = dep("dDeep4", ["s3", "s1", "s2", "s4"], "deepseek", 8888);
    const extra = nodeWithLlm("s4", 8888, { modelId: "deepseek-hf" }, { role: "standalone" });
    const all = [...sparks, extra];
    const view = deploymentViews(all, [tp4], recipes, models)[0];
    expect(view.nodes.map((n) => n.id)).toEqual(["s3", "s1", "s2", "s4"]);
    // Anchor is a non-worker member by identity, not by fleet order.
    expect(primaryNodeOf(all, tp4)?.id).toBe("s3");
  });
});

describe("canonical runtime state truth", () => {
  it("(9) reachable Qwen with missing optional telemetry is never OFFLINE", () => {
    const d = dep("dQwen", ["s3"], "qwen", 8889);
    const t = deploymentTelemetry([nodeWithLlm("s3", 8889, { available: false, error: "API key required (401)" })], d);
    expect(t).not.toBeNull();
    const state = deriveRuntimeState(d, t);
    expect(state).not.toBe("offline");
    expect(["ready", "reachable", "unknown"]).toContain(state);
  });

  it("(10) an active Qwen request => SERVING", () => {
    const d = dep("dQwen", ["s3"], "qwen", 8889);
    const t = deploymentTelemetry([nodeWithLlm("s3", 8889, { requestsRunning: 2, modelId: "qwen-hf", generationTps: 42 })], d)!;
    expect(deriveRuntimeState(d, t)).toBe("serving");
  });

  it("(11) an idle reachable endpoint => idle when it served, else ready", () => {
    const d = dep("dQwen", ["s3"], "qwen", 8889);
    const loaded = deploymentTelemetry([nodeWithLlm("s3", 8889, { modelId: "qwen-hf", slotsTotal: 4, totalOutputTokens: 900 })], d)!;
    expect(deriveRuntimeState(d, loaded)).toBe("idle");
    expect(deriveRuntimeState(d, { ...loaded, totalOutputTokens: 0 })).toBe("ready");
  });

  it("stale telemetry is marked STALE and never claims SERVING", () => {
    const d = dep("dDeep", ["s1"], "deepseek", 8888);
    const t = deploymentTelemetry([nodeWithLlm("s1", 8888, { requestsRunning: 3, generationTps: 50, modelId: "m", totalOutputTokens: 10 })], d)!;
    expect(deriveRuntimeState(d, t, { telemetryAgeMs: 60_000, staleMs: 30_000 })).toBe("idle");
    expect(deriveRuntimeState(d, t)).toBe("serving");
  });
});
