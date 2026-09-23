/**
 * ACCEPTANCE SUITE — proves the cockpit/fabric is DATA-DRIVEN, not tied to
 * today's lab (3 nodes, Qwen primary, DeepSeek worker). Fixtures only: mocked
 * fetch, no network, no live nodes.
 *
 * Invariants exercised:
 *  - UNKNOWN != FAILED
 *  - IDLE != OFFLINE
 *  - FLEET SIZE != PARALLELISM DEGREE
 *  - physical fabric != deployment topology
 *  - CONFIGURED != DISCOVERED
 *  - DO NOT INVENT TELEMETRY / TOPOLOGY / CAPABILITY
 */
import { describe, expect, it, vi } from "vitest";
import type { DeploymentStatus, ModelEntry, RecipePublic, SparkSnapshot } from "../../api/types";
import { render, cleanupRenders } from "../../testing/render";
import { OverviewSection } from "./OverviewSection";
import { DeploymentInstrument } from "./DeploymentInstrument";
import { FabricPanel } from "./FabricPanel";
import { computeFleetHealth, deploymentViews, deriveRuntimeState, type DeploymentView, type DeploymentTelemetry } from "./fleetModel";
import { deriveFabric, deriveFabricTopology, fabricLayout } from "./fabricModel";
import { nodeTelemetryRow, roleOf, primaryView, fabricHealthSummary } from "./cockpitModel";
import { evaluateTopology, type TopologyDescriptor } from "./topologyCapability";
import type { RecipeDraft } from "./RecipeEditor";

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

function model(id: string, name: string): ModelEntry {
  return { id, name, family: null, weightPaths: {}, tags: [], notes: "", archived: false, createdAt: 0, updatedAt: 0 };
}

function recipe(id: string, modelId: string, over: Partial<RecipePublic> = {}): RecipePublic {
  return {
    id, modelRef: { modelId }, name: `Recipe ${id}`, engine: { runtime: "vllm" } as never,
    topology: "single", modelId, runtime: "vllm", nodeIds: ["n1"], modelPath: "/m", workdir: "/w",
    logDir: null, apiPort: 8889, healthPath: "/v1/models", contextLength: 32000, cpuAffinity: null,
    launcher: null, metadata: {}, notes: "", env: [], archived: false, createdAt: 0, updatedAt: 0,
    ...over,
  } as RecipePublic;
}

function dep(over: Partial<DeploymentStatus> = {}): DeploymentStatus {
  return {
    recipeId: "r1", modelId: "m1", nodeIds: ["n1"], apiPort: 8889,
    managedBy: "sparkdash", dryRun: true, state: "running", desired: "running", observed: "running",
    discovered: false, display: "running", lastOp: null, lastError: null, startedAt: null, updatedAt: 0,
    ...over,
  } as DeploymentStatus;
}

function view(over: Partial<DeploymentView> = {}): DeploymentView {
  const d = over.deployment ?? dep();
  return {
    deployment: d, key: d.recipeId, recipe: null,
    modelName: d.modelId, rawModelId: d.modelId, nodes: [spark()], runtime: "vllm",
    topology: "single", lifecycleState: null, contextLength: 32000, port: d.apiPort,
    decodeTps: null, telemetry: null, uptime: null, ...over,
  } as DeploymentView;
}

function telemetry(over: Partial<DeploymentTelemetry> = {}): DeploymentTelemetry {
  return {
    generationTps: null, prefillTps: null, ttftSeconds: null, requestsRunning: 0, requestsWaiting: 0,
    kvCacheUsage: null, prefixCacheHitRate: null, mtpAcceptanceRate: null, contextLength: 32000,
    gpuMemoryUtilization: null, slotsActive: null, slotsTotal: 8, totalOutputTokens: 0,
    backend: "vllm", modelId: "m", available: true, error: null,
    aggregation: null, membersReporting: 1, membersMissingTelemetry: [], ...over,
  } as DeploymentTelemetry;
}

const DESCRIPTOR = (d: Partial<TopologyDescriptor> = {}) => d as TopologyDescriptor;
const DRAFT = (d: Partial<RecipeDraft> = {}) => ({ topoMode: "tp", tp: "", pp: "", dp: "", ep: "", ...d } as RecipeDraft);

/* ─── 78 · PRIMARY CHANGE follows config role, no component change ─── */
describe("78 primary deployment is config-driven", () => {
  it("promotes the deployment whose role is 'primary' and badges it PRIMARY", () => {
    cleanupRenders();
    const nodes = [spark({ id: "n1", name: "A" }), spark({ id: "n2", name: "B" })];
    const models = [model("m1", "Alpha"), model("m2", "Beta")];
    const recipes = [recipe("r1", "m1"), recipe("r2", "m2", { nodeIds: ["n2"] })];
    const deps = [dep({ recipeId: "r1", modelId: "m1", nodeIds: ["n1"], role: "worker" }), dep({ recipeId: "r2", modelId: "m2", nodeIds: ["n2"], role: "primary" })];

    const { container } = render(<OverviewSection sparks={nodes} deployments={deps} recipes={recipes} models={models} navigate={() => {}} loaded />);

    // hierarchy follows deployment.role — the primary instrument is Beta.
    expect(container.querySelector(".cp-inst.is-primary")?.textContent).toContain("Beta");
    const row = [...container.querySelectorAll(".cp-deploy-row")].find((r) => r.textContent?.includes("Beta"));
    expect(row?.querySelector(".cp-deploy-role")?.textContent).toBe("PRIMARY");
    const otherRole = [...container.querySelectorAll(".cp-deploy-row")].find((r) => r.textContent?.includes("Alpha"))?.querySelector(".cp-deploy-role")?.textContent;
    expect(otherRole).toBe("WORKER");

    // pure layer agrees — no component edit needed.
    const views = deploymentViews(nodes, deps, recipes, models);
    expect(primaryView(views)?.rawModelId).toBe("m2");
    expect(roleOf(views[1], views)).toBe("PRIMARY");
  });
});

/* ─── 79 · DGX #4: fleet/fabric/compute accept an added node ─── */
describe("79 fleet size is data-driven (4th node, no slot assumption)", () => {
  it("counts 4 nodes, wires the new node, and selects it into compute", () => {
    const nodes = [spark({ id: "dgx-1" }), spark({ id: "dgx-2" }), spark({ id: "dgx-3" }), spark({ id: "dgx-4", name: "DGX 4" })];
    expect(computeFleetHealth(nodes, []).nodesTotal).toBe(4);

    const wired = nodes.map((n) => ({ ...n, fabricLinks: n.id === "dgx-4" ? [{ to: "dgx-3", speedMbps: 200_000, medium: "cx7" as const }] : [] }));
    const fabric = deriveFabric(wired, []);
    expect(fabric.nodes.map((n) => n.id)).toContain("dgx-4");
    expect(fabric.links.some((l) => [l.from, l.to].includes("dgx-4"))).toBe(true);

    const layout = fabricLayout(fabric, deriveFabricTopology(fabric));
    expect(layout.positions).toHaveLength(4);
    expect(new Set(layout.positions.map((p) => `${p.x},${p.y}`)).size).toBe(4);

    const v = deploymentViews(nodes, [dep({ nodeIds: ["dgx-1", "dgx-2", "dgx-3", "dgx-4"] })], [], []);
    expect(v[0].nodes.map((n) => n.id)).toEqual(["dgx-1", "dgx-2", "dgx-3", "dgx-4"]);
  });
});

/* ─── 80 · TP3 advertised + 3 nodes ⇒ VALID ─── */
describe("80 provider advertising TP3 on 3 nodes is VALID", () => {
  it("validates via a capability descriptor, not a node-count guess", () => {
    expect(evaluateTopology({ draft: DRAFT({ tp: "3" }), descriptor: DESCRIPTOR({ tp: "by-node-count" }), nodeCount: 3 }).status).toBe("valid");
  });
});

/* ─── 81 · provider NOT supporting TP3 on 3 nodes ⇒ INVALID ─── */
describe("81 provider without TP on 3 nodes is INVALID", () => {
  it("rejects a declared-unsupported strategy", () => {
    const out = evaluateTopology({ draft: DRAFT({ tp: "3" }), descriptor: DESCRIPTOR({ tp: "unsupported" }), nodeCount: 3 });
    expect(out.status).toBe("invalid");
    expect(out.reason).toMatch(/TP/);
  });
});

/* ─── 82 · 3 nodes, no degree ⇒ TOPOLOGY UNKNOWN (not TP3) ─── */
describe("82 fleet size never implies a degree", () => {
  it("reads needs-confirmation, never valid/invalid, for 3 nodes with no degree", () => {
    const out = evaluateTopology({ draft: DRAFT({ topoMode: "single" }), descriptor: DESCRIPTOR({ single: "supported" }), nodeCount: 3 });
    expect(out.status).toBe("needs-confirmation");
    expect(out.reason).toMatch(/do not imply/);
  });
});

/* ─── 83 · idle primary: READY/IDLE + 'no active traffic', never OFFLINE/0 ─── */
describe("83 idle primary is ready, not offline", () => {
  it("stays READY with an explicit no-traffic note and no fabricated 0 tok/s", () => {
    cleanupRenders();
    const d = dep({ display: "running", observed: "running" });
    const t = telemetry({ generationTps: null, requestsRunning: 0, requestsWaiting: 0, totalOutputTokens: 0 });
    expect(deriveRuntimeState(d, t)).toBe("ready");
    expect(deriveRuntimeState(d, t)).not.toBe("offline");

    const { container } = render(
      <DeploymentInstrument
        view={view({ deployment: d, telemetry: t })}
        role="PRIMARY"
        state="ready"
        history={[]}
        lastRequestAt={null}
        now={Date.now()}
        runtimeLabels={{}}
        runtimeMetrics={{}}
        onOpen={() => {}}
      />
    );
    expect(container.querySelector(".cp-inst-state")?.textContent).toContain("READY");
    expect(container.textContent).toContain("no active traffic");
    expect(container.querySelector(".cp-inst-state")?.textContent).not.toContain("OFFLINE");
    // throughput value is an em dash, never a fabricated 0.
    expect(container.textContent).not.toMatch(/0 tok\/s/);
  });
});

/* ─── 84 · unknown temperature: '—'/Unknown, no fabricated threshold ─── */
describe("84 unknown temperature is honest", () => {
  it("renders — for a missing temp and keeps the node healthy (no degrade-for-missing)", () => {
    const node = spark({ id: "n1", online: true, metrics: { ...spark().metrics, gpu: { usage: 10, vram: null, power: null } as never } });
    const row = nodeTelemetryRow(node, []);
    const gpuTemp = row.metrics.find((m) => m.key === "gpuTemp");
    expect(gpuTemp?.value).toBe("—");
    expect(row.tone).toBe("live");

    const fabric = deriveFabric([node], []);
    expect(fabric.nodes[0].health).toBe("ok");
    expect(fabricHealthSummary(fabric.links)).toBe("unknown");
  });
});

/* ─── 86 (FE) · an extra node renders in the fabric with no hard-coded UI ─── */
describe("86 fabric accepts an added compute node without source change", () => {
  it("lays out 4 nodes and keeps configured provenance labelled", () => {
    cleanupRenders();
    const nodes = ["dgx-1", "dgx-2", "dgx-3", "dgx-4"].map((id, i) =>
      spark({ id, name: `DGX ${i + 1}`, fabricLinks: i === 3 ? [{ to: "dgx-3", speedMbps: 200_000, medium: "cx7" }] : [] })
    );
    const { container } = render(<FabricPanel sparks={nodes} views={[]} navigate={() => {}} />);
    expect(container.querySelectorAll(".cp-fabric-node")).toHaveLength(4);
    expect(container.querySelector(".cp-fabric-wiring")?.textContent).toContain("CONFIGURED");
    expect(container.querySelector(".cp-fabric-wiring")?.textContent).not.toContain("DISCOVERED");
  });
});

/* ─── 52 · model replacement with no component change ─── */
describe("52 model replacement is a data swap", () => {
  it("re-renders the new model name from the registry, same recipe/binding", () => {
    cleanupRenders();
    const nodes = [spark({ id: "n1" })];
    const d = dep({ modelId: "m-new", recipeId: "r1" });
    const recipes = [recipe("r1", "m-new")];
    const models = [model("m-old", "Old Model"), model("m-new", "New Model")];

    const withNew = deploymentViews(nodes, [d], recipes, models);
    expect(withNew[0].modelName).toBe("New Model");

    const { container } = render(<OverviewSection sparks={nodes} deployments={[d]} recipes={recipes} models={models} navigate={() => {}} loaded />);
    expect(container.textContent).toContain("New Model");
    expect(container.textContent).not.toContain("Old Model");
  });
});
