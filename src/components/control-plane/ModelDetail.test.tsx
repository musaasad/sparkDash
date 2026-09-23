/**
 * Model detail IA + safe lifecycle semantics proof:
 *  - Recipes and Deployments are first-class tabs (cards + binding rows)
 *  - every destructive/irreversible action runs through a confirm Modal with
 *    explicit "does NOT" copy, replacing the old window.prompt/alert
 *  - archive NEVER deletes weights (copy says so)
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { ModelDetail, PerformanceTab } from "./ModelDetail";
import type { ModelEntry, RecipePublic, DeploymentStatus, SparkSnapshot } from "../../api/types";
import { render, flush, cleanupRenders } from "../../testing/render";
import { setDeployments } from "../../hooks/domainStore";

vi.mock("../../api/client", () => ({
  fetchModel: vi.fn(),
  fetchRecipes: vi.fn(),
  fetchRuntimes: vi.fn(),
  fetchActivity: vi.fn(),
  listDecodeBench: vi.fn(),
  archiveModel: vi.fn(),
  archiveRecipe: vi.fn(),
  restoreModel: vi.fn(),
  restoreRecipe: vi.fn(),
  duplicateRecipe: vi.fn(),
  validateRecipe: vi.fn(),
  recipeLifecycle: vi.fn(),
  createDeployment: vi.fn(),
  deleteDeployment: vi.fn(),
}));

const client = await import("../../api/client");
const fetchModel = vi.mocked(client.fetchModel);
const archiveModel = vi.mocked(client.archiveModel);
const deleteDeployment = vi.mocked(client.deleteDeployment);

const model: ModelEntry = {
  id: "m1",
  name: "Qwen Flash",
  family: "Qwen",
  weightPaths: { default: "/models/qwen" },
  notes: "",
  archived: false,
  createdAt: 0,
  updatedAt: 0,
};

const recipe: RecipePublic = {
  id: "r-proven",
  modelId: "m1",
  name: "Proven EXL3",
  runtime: "tabbyapi-exl3",
  topology: "single",
  topologyBlock: { mode: "single", parallelism: 1, minNodes: 1, maxNodes: 1 },
  engine: { runtime: "tabbyapi-exl3", quantization: "EXL3 4.0bpw", apiProtocol: "openai" },
  serving: { contextLength: 64000 },
  endpoint: { scheme: "http", hostTemplate: "{nodeIp}", port: 8889, path: "/v1" },
  nodeIds: ["n1"],
  modelPath: "/models/qwen",
  workdir: "/w",
  logDir: "/logs",
  apiPort: 8889,
  healthPath: "/v1/models",
  contextLength: 64000,
  cpuAffinity: null,
  launcher: null,
  metadata: {},
  notes: "",
  env: [],
  lifecycleState: "proven",
  archived: false,
  createdAt: 0,
  updatedAt: 0,
};

const dep: DeploymentStatus = {
  deploymentId: "dep-1",
  recipeId: "r-proven",
  modelId: "m1",
  nodeIds: ["n1"],
  apiPort: 8889,
  managedBy: "sparkdash",
  dryRun: true,
  state: "running",
  desired: "running",
  observed: "running",
  discovered: false,
  display: "running",
  lastOp: null,
  lastError: null,
  startedAt: null,
  updatedAt: 0,
};

const spark = { id: "n1", name: "Node One", online: true, llmPorts: [8889], metrics: {} } as SparkSnapshot;

function clickText(container: HTMLElement, text: string) {
  const btn = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
  expect(btn, `button "${text}"`).not.toBeUndefined();
  act(() => btn!.click());
}

beforeEach(() => {
  cleanupRenders();
  vi.clearAllMocks();
  setDeployments([dep]);
  fetchModel.mockResolvedValue({ model, recipes: [recipe], deployments: [dep] });
  (client.fetchRecipes as ReturnType<typeof vi.fn>).mockResolvedValue({ recipes: [recipe] });
  (client.fetchRuntimes as ReturnType<typeof vi.fn>).mockResolvedValue({ runtimes: [{ id: "tabbyapi-exl3", label: "TabbyAPI", launchable: true }] });
  (client.fetchActivity as ReturnType<typeof vi.fn>).mockResolvedValue({ events: [] });
  (client.listDecodeBench as ReturnType<typeof vi.fn>).mockResolvedValue({ active: null, last: null, history: [], defaults: {} });
  archiveModel.mockResolvedValue({ archived: true });
  deleteDeployment.mockResolvedValue({ deleted: true, id: "dep-1" });
});

describe("ModelDetail IA", () => {
  it("surfaces Recipes and Deployments as first-class tabs", async () => {
    const { container } = render(
      <ModelDetail modelId="m1" sparks={[spark]} navigate={() => {}} onDataChanged={() => {}} />
    );
    await flush();
    const tabs = [...container.querySelectorAll(".cp-tab")].map((t) => t.textContent);
    expect(tabs).toContain("Recipes");
    expect(tabs).toContain("Deployments");
  });

  it("renders a recipe card with lifecycle badge, runtime chip, node count and Deploy/Duplicate/Edit actions", async () => {
    const { container } = render(
      <ModelDetail modelId="m1" initialTab="recipes" sparks={[spark]} navigate={() => {}} onDataChanged={() => {}} />
    );
    await flush();
    const card = container.querySelector(".cp-panel");
    expect(card).not.toBeNull();
    expect(container.textContent).toContain("Proven");
    expect(container.textContent).toContain("TabbyAPI");
    expect(container.textContent).toContain("1 node");
    expect(container.textContent).toContain("Duplicate");
    expect(container.textContent).toContain("Deploy");
  });

  it("duplicate flows through a Modal stating the original stays untouched (no window.prompt)", async () => {
    const { container } = render(
      <ModelDetail modelId="m1" initialTab="recipes" sparks={[spark]} navigate={() => {}} onDataChanged={() => {}} />
    );
    await flush();
    clickText(container, "Duplicate");
    const modal = document.querySelector(".cp-modal");
    expect(modal).not.toBeNull();
    expect(modal!.textContent).toContain("NEW draft");
    expect(modal!.textContent).toContain("original is untouched");
    expect(modal!.textContent).toContain("r-proven");
  });

  it("archive model Modal states weights are never deleted", async () => {
    const { container } = render(
      <ModelDetail modelId="m1" sparks={[spark]} navigate={() => {}} onDataChanged={() => {}} />
    );
    await flush();
    clickText(container, "Archive model");
    const modal = document.querySelector(".cp-modal");
    expect(modal!.textContent).toContain("WEIGHTS ARE NEVER DELETED");
    expect(modal!.textContent).toContain("untouched");
  });

  it("deployments tab remove Modal states binding-only deletion", async () => {
    const { container } = render(
      <ModelDetail modelId="m1" initialTab="deployments" sparks={[spark]} navigate={() => {}} onDataChanged={() => {}} />
    );
    await flush();
    const kebab = document.querySelector<HTMLButtonElement>(".cp-kebab")!;
    act(() => kebab.click());
    const modal = document.querySelector(".cp-modal");
    expect(modal!.textContent).toContain("BINDING only");
    expect(modal!.textContent).toContain("recipe/model");
    clickText(container, "Remove binding");
    await flush();
    expect(deleteDeployment).toHaveBeenCalledWith("dep-1");
  });

  it("archived recipe renders read-only and cannot back a new deployment", async () => {
    const archived = { ...recipe, id: "r-arch", lifecycleState: "archived" as const, archived: true };
    fetchModel.mockResolvedValue({ model, recipes: [archived], deployments: [] });
    const { container } = render(
      <ModelDetail modelId="m1" initialTab="recipes" sparks={[spark]} navigate={() => {}} onDataChanged={() => {}} />
    );
    await flush();
    const deploy = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Deploy");
    expect(deploy?.disabled).toBe(true);
    expect(container.textContent).toContain("View");
  });

  it("folds legacy deep-link tabs into the four spec surfaces", async () => {
    for (const [legacy, expected] of [["performance", "Benchmarks"], ["configuration", "Recipes"], ["history", "Overview"]] as const) {
      cleanupRenders();
      const { container } = render(
        <ModelDetail modelId="m1" initialTab={legacy} sparks={[spark]} navigate={() => {}} onDataChanged={() => {}} />
      );
      await flush();
      expect(container.querySelector(".cp-tab.is-active")?.textContent).toBe(expected);
      expect([...container.querySelectorAll(".cp-tab")].map((t) => t.textContent)).toEqual([
        "Overview",
        "Recipes",
        "Deployments",
        "Live Console",
        "Benchmarks",
      ]);
    }
  });
});

describe("PerformanceTab port association (F8)", () => {
  const llmNode = (id: string, port: number, tps: number, modelId: string) =>
    ({ id, name: `Node ${id}`, online: true, llmPorts: [port], metrics: { llm: [{ available: true, generationTps: tps, modelId }] } }) as SparkSnapshot;

  it("aggregates across member nodes on the deployment apiPort", () => {
    cleanupRenders();
    const nodes = [llmNode("a", 8889, 10, "m-a"), llmNode("b", 8889, 20, "m-b")];
    const { container } = render(<PerformanceTab sparks={nodes} recipe={recipe} deployment={{ ...dep, nodeIds: ["a", "b"] }} />);
    expect(container.textContent).toContain("2 members (SUM)");
    expect(container.textContent).toContain("port 8889");
  });

  it("nulls an unmatched port instead of charting index-0 of a wrong-port series", () => {
    cleanupRenders();
    // Node reports only on 8889; the deployment asks for 7777.
    const node = llmNode("a", 8889, 10, "WRONG-model");
    const { container } = render(<PerformanceTab sparks={[node]} recipe={recipe} deployment={{ ...dep, apiPort: 7777 }} />);
    const served = [...container.querySelectorAll(".cp-metric")].find((m) => m.textContent?.includes("Model served"));
    expect(served?.textContent).toContain("—");
    expect(served?.textContent).not.toContain("WRONG-model");
  });
});

describe("ModelDetail live-first model identity", () => {
  const llmSpark = (modelId: string, contextLength: number, backend: string) =>
    ({ id: "n1", name: "Node One", online: true, llmPorts: [8889], metrics: { llm: [{ available: true, modelId, contextLength, backend }] } }) as SparkSnapshot;
  const boundDep = (modelId: string): DeploymentStatus => ({ ...dep, modelId, nodeIds: ["n1"], apiPort: 8889, recipeId: "r-glm" });
  const glmRecipe = { ...recipe, id: "r-glm", modelId: "deepseek-v41-flash", serving: { contextLength: 600000 }, metadata: {} } as RecipePublic;

  it("renders a discovered live model (not in the registry) as a coherent view", async () => {
    cleanupRenders();
    setDeployments([boundDep("deepseek-v41-flash")]);
    fetchModel.mockRejectedValue(new Error("model not found"));
    (client.fetchRecipes as ReturnType<typeof vi.fn>).mockResolvedValue({ recipes: [glmRecipe] });
    const { container } = render(
      <ModelDetail modelId="GLM-5.3-Flash-EXL3" sparks={[llmSpark("GLM-5.3-Flash-EXL3", 850000, "vllm")]} navigate={() => {}} onDataChanged={() => {}} />
    );
    await flush();
    expect(container.textContent).toContain("GLM-5.3-Flash-EXL3");
    expect(container.textContent).toContain("live · discovered");
    expect(container.textContent).toContain("850,000"); // live context wins over recipe 600k
    expect(container.textContent).not.toContain("Model not found");
  });

  it("does NOT flag a same-model live alias as superseded (Qwen keeps friendly name)", async () => {
    cleanupRenders();
    setDeployments([boundDep("qwen38-flash-next")]);
    fetchModel.mockResolvedValue({ model: { ...model, id: "qwen38-flash-next", name: "Qwen 3.8 Flash Next", family: "Qwen" }, recipes: [recipe], deployments: [dep] });
    const { container } = render(
      <ModelDetail modelId="qwen38-flash-next" sparks={[llmSpark("Qwen3.8-Flash-Next-EXL3", 262144, "tabbyapi")]} navigate={() => {}} onDataChanged={() => {}} />
    );
    await flush();
    expect(container.textContent).toContain("Qwen 3.8 Flash Next");
    expect(container.textContent).not.toContain("not currently serving");
    expect(container.textContent).not.toContain("not serving");
  });

  it("flags a registered model whose endpoint now serves a DIFFERENT live model", async () => {
    cleanupRenders();
    setDeployments([boundDep("deepseek-v41-flash")]);
    fetchModel.mockResolvedValue({ model: { ...model, id: "deepseek-v41-flash", name: "DeepSeek V4.1 Flash", family: "DeepSeek" }, recipes: [glmRecipe], deployments: [boundDep("deepseek-v41-flash")] });
    const { container } = render(
      <ModelDetail modelId="deepseek-v41-flash" sparks={[llmSpark("GLM-5.3-Flash-EXL3", 850000, "vllm")]} navigate={() => {}} onDataChanged={() => {}} />
    );
    await flush();
    expect(container.textContent).toContain("not currently serving");
    expect(container.textContent).toContain("GLM-5.3-Flash-EXL3");
  });
});
