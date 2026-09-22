/**
 * Guided wizard proof: progressive disclosure (common first, advanced behind a
 * disclosure), config-only save semantics, and the dry-run validate hand-off.
 * Nothing here starts/stops a real process.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { ModelWizard } from "./ModelWizard";
import type { ModelEntry, RecipePublic, SparkSnapshot } from "../../api/types";
import { render, flush, cleanupRenders } from "../../testing/render";

vi.mock("../../api/client", () => ({
  upsertModel: vi.fn(),
  upsertRecipe: vi.fn(),
  duplicateRecipe: vi.fn(),
  validateRecipe: vi.fn(),
  validateDraftRecipe: vi.fn(),
  createDeployment: vi.fn(),
  archiveModel: vi.fn(),
  fetchRuntimes: vi.fn(),
}));

const client = await import("../../api/client");
const upsertModel = vi.mocked(client.upsertModel);
const upsertRecipe = vi.mocked(client.upsertRecipe);
const validateRecipe = vi.mocked(client.validateRecipe);
const validateDraftRecipe = vi.mocked(client.validateDraftRecipe);
const createDeployment = vi.mocked(client.createDeployment);

const spark = { id: "n1", name: "Node One", online: true } as SparkSnapshot;

function type(container: HTMLElement, selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector);
  expect(input).not.toBeNull();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input!, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickText(container: HTMLElement, text: string) {
  void container;
  const btn = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
  expect(btn, `button "${text}"`).not.toBeUndefined();
  act(() => btn!.click());
}

function pickSelect(container: HTMLElement, selector: string, value: string) {
  const sel = container.querySelector<HTMLSelectElement>(selector);
  expect(sel).not.toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(sel, value);
    sel!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** Spec §7: creation opens a template picker first — leave it via "from scratch". */
function startScratch(container: HTMLElement) {
  const btn = [...container.querySelectorAll<HTMLButtonElement>(".cp-template-scratch")][0];
  expect(btn).not.toBeUndefined();
  act(() => btn.click());
}

/** Advance until the final save button appears, awaiting async validate steps. */
async function advanceToSave() {
  for (let i = 0; i < 14; i++) {
    await flush();
    const save = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.trim().startsWith("Create model")
    );
    if (save) return;
    const node = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Node One");
    if (node && node.getAttribute("aria-pressed") !== "true") act(() => node.click());
    const cont = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Continue");
    expect(cont, `continue at iteration ${i}`).not.toBeUndefined();
    act(() => cont!.click());
  }
  throw new Error("save button never appeared");
}

beforeEach(() => {
  cleanupRenders();
  vi.clearAllMocks();
  upsertModel.mockResolvedValue({ model: { id: "w-model" } as ModelEntry });
  upsertRecipe.mockResolvedValue({ recipe: { id: "w-recipe" } as RecipePublic });
  validateRecipe.mockResolvedValue({ ok: true, errors: [], warnings: [] });
  validateDraftRecipe.mockResolvedValue({ ok: true, errors: [], warnings: [] });
  vi.mocked(client.archiveModel).mockResolvedValue({ archived: true });
  vi.mocked(client.fetchRuntimes).mockResolvedValue({
    runtimes: [
      { id: "vllm", label: "vLLM", launchable: true },
      { id: "tabbyapi-exl3", label: "TabbyAPI", launchable: true },
    ],
  } as never);
  createDeployment.mockResolvedValue({ deployment: {} as never, runtime: {} as never });
});

describe("ModelWizard", () => {
  it("renders an 8-step stepper, common fields first, advanced behind a disclosure", () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={[spark]} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} />
    );
    // Picker is the entry surface; templates exist, scratch continues to the form.
    expect(container.querySelectorAll(".cp-template-card").length).toBeGreaterThan(0);
    startScratch(container);
    expect(container.querySelectorAll(".cp-step")).toHaveLength(8);
    // Step 1 shows the common model fields but the weight-variant fields only
    // after opening the Advanced disclosure.
    expect(container.querySelector("#w-model-name")).not.toBeNull();
    expect(container.querySelector("#w-model-path")).not.toBeNull();
    const advanced = container.querySelector("details.cp-advanced");
    expect(advanced).not.toBeNull();
    expect(advanced!.querySelector("input")).toBeNull(); // collapsed
  });

  it("blocks Continue on an invalid identity step with an inline error", () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={[spark]} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} />
    );
    startScratch(container);
    clickText(container, "Continue");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Model name is required");
  });

  it("walks all 8 steps and saves config entities with desiredState stopped", async () => {
    const navigate = vi.fn();
    const onSaved = vi.fn();
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={[spark]} navigate={navigate} onSaved={onSaved} onCancel={() => {}} />
    );

    startScratch(container);

    // 1 Model
    type(container, "#w-model-name", "Qwen Flash");
    type(container, "#w-model-path", "/models/qwen");
    clickText(container, "Continue");

    // 2 Recipe (create new)
    type(container, "#w-r-name", "Qwen recipe");
    clickText(container, "Continue");

    // 3 Runtime
    clickText(container, "Continue");

    // 4 Compute — pick the single node
    clickText(container, "Node One");
    clickText(container, "Continue");

    // 5 Options
    clickText(container, "Continue");
    await flush();

    // 6 Validate — unsaved-body dry validate (no entity yet)
    expect(validateDraftRecipe).toHaveBeenCalled();
    clickText(container, "Continue");

    // 7 Review
    expect(container.textContent).toContain("create binding");
    clickText(container, "Continue");

    // 8 Save
    clickText(container, "Create model + recipe + deployment");
    await flush();

    expect(upsertModel).toHaveBeenCalledTimes(1);
    expect(upsertRecipe).toHaveBeenCalledTimes(1);
    expect(createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ nodeIds: ["n1"], desiredState: "stopped" })
    );
    expect(onSaved).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ section: "model", modelId: "w-model" }));
  });

  it("pre-selects an existing model and still needs an explicit node pick", async () => {
    const external: RecipePublic = {
      id: "r-ext",
      modelId: "m1",
      name: "External",
      runtime: "tabbyapi-exl3",
      topology: "single",
      topologyBlock: { mode: "single", parallelism: 1, minNodes: 1, maxNodes: 1 },
      nodeIds: ["n1"],
      modelPath: "/m",
      workdir: "/w",
      logDir: null,
      apiPort: 8889,
      healthPath: "/v1/models",
      contextLength: null,
      cpuAffinity: null,
      launcher: null,
      metadata: {},
      notes: "",
      env: [],
      launch: { mechanism: "external" },
      archived: false,
      createdAt: 0,
      updatedAt: 0,
    };
    const model: ModelEntry = { id: "m1", name: "M", family: null, notes: "", archived: false, createdAt: 0, updatedAt: 0 };

    const { container } = render(
      <ModelWizard models={[model]} recipes={[external]} sparks={[spark]} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} initialModelId="m1" />
    );

    clickText(container, "Continue"); // 1 Model (existing pre-selected)
    clickText(container, "Use existing"); // 2 associate the external recipe
    pickSelect(container, "#w-recipe-pick", "r-ext");
    await advanceToSave();
    clickText(container, "Create model + recipe + deployment");
    await flush();

    expect(upsertModel).not.toHaveBeenCalled(); // existing model is associated, not recreated
    expect(createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "m1", recipeId: "r-ext", nodeIds: ["n1"], desiredState: "unknown" })
    );
  });
});
