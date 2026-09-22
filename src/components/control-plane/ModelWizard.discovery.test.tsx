/**
 * Discovery → wizard proof: seed pre-fills the SAME 8-step wizard, provenance
 * survives to review, suggested template is overridable, topology is NEVER
 * inferred from node count, external stays external, and save is config-only.
 * Client fetch is fully mocked — nothing touches the live Qwen/DeepSeek servers.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { ModelWizard } from "./ModelWizard";
import type { DiscoveredSeed, ModelEntry, RecipePublic, SparkSnapshot } from "../../api/types";
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

const n1 = { id: "n1", name: "Node One", online: true } as SparkSnapshot;
const n2 = { id: "n2", name: "Node Two", online: true } as SparkSnapshot;

function seed(over: Partial<DiscoveredSeed> = {}): DiscoveredSeed {
  return {
    reachable: true,
    runtime: "vllm",
    runtimeConfidence: "high",
    servedModelIds: ["qwen-flash"],
    modelId: "qwen-flash",
    health: "running",
    contextLength: 32768,
    apiProtocol: "openai",
    quantization: null,
    endpoint: "http://10.0.0.5:8889/v1/models",
    credAttached: false,
    suggestedTemplate: { templateId: "vllm-openai", confidence: "high" },
    provenance: {
      modelId: "detected",
      runtime: "detected",
      apiProtocol: "detected",
      contextLength: "detected",
      port: "user",
      quantization: "unknown",
    },
    host: "10.0.0.5",
    port: 8889,
    scheme: "http",
    credRef: null,
    capabilities: null,
    ...over,
  };
}

function clickText(text: string) {
  const btn = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
  expect(btn, `button "${text}"`).not.toBeUndefined();
  act(() => btn!.click());
}

/** Advance through steps, placing all nodes on the compute step, stop at review. */
async function advanceToReview(container: HTMLElement) {
  for (let i = 0; i < 20; i++) {
    await flush();
    if (container.textContent?.includes("Exactly what will be created")) return;
    if (container.querySelector("#w-tp")) {
      for (const n of [...container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")]) {
        if (n.getAttribute("aria-pressed") !== "true" && /Node/.test(n.textContent ?? "")) act(() => n.click());
      }
    }
    const cont = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Continue");
    expect(cont, `continue at ${i}`).not.toBeUndefined();
    act(() => cont!.click());
  }
  throw new Error("review never appeared");
}

async function advanceToSave(container: HTMLElement) {
  await advanceToReview(container);
  clickText("Continue");
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
    runtimes: [{ id: "vllm", label: "vLLM", launchable: true }, { id: "tabbyapi-exl3", label: "TabbyAPI", launchable: true }],
  } as never);
  createDeployment.mockResolvedValue({ deployment: {} as never, runtime: {} as never });
});

describe("ModelWizard discovery seed", () => {
  it("pre-fills from a seed, keeps values editable, and shows provenance badges", () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={[n1]} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} seed={seed()} />
    );
    // Seed skips the picker → straight to the same 8-step flow.
    expect(container.querySelectorAll(".cp-step")).toHaveLength(8);
    expect(container.querySelector<HTMLInputElement>("#w-model-name")?.value).toBe("qwen-flash");
    expect(container.textContent).toContain("Detected");
    expect(container.textContent).toContain("UNKNOWN to confirm");

    // Every discovered value stays editable.
    type(container, "#w-model-name", "renamed");
    expect(container.querySelector<HTMLInputElement>("#w-model-name")?.value).toBe("renamed");

    // The UNKNOWN field carries a confirm affordance on the recipe step.
    clickText("Continue");
    expect(container.querySelector(".cp-prov.unknown")).not.toBeNull();
  });

  it("never guesses Family or Weight path for a discovered external endpoint", () => {
    // DeepSeek model: discovery carries no family; SparkDash must not borrow
    // another model's family nor fabricate a weight path from the model id.
    const { container } = render(
      <ModelWizard
        models={[]}
        recipes={[]}
        sparks={[n1]}
        navigate={() => {}}
        onSaved={() => {}}
        onCancel={() => {}}
        seed={seed({ modelId: "deepseek-v4-1-flash-uncensored-exl3", provenance: { modelId: "detected", runtime: "detected", port: "user" } })}
      />
    );
    const fam = container.querySelector<HTMLInputElement>("#w-model-fam")!;
    const path = container.querySelector<HTMLInputElement>("#w-model-path")!;
    expect(fam.value).toBe("");
    expect(path.value).toBe("");
    // Both stay visibly UNKNOWN / editable with a confirm affordance.
    expect(fam.parentElement?.querySelector(".cp-prov.unknown")).not.toBeNull();
    expect(path.parentElement?.querySelector(".cp-prov.unknown")).not.toBeNull();
    type(container, "#w-model-fam", "DeepSeek");
    type(container, "#w-model-path", "/models/ds");
    expect(container.querySelector<HTMLInputElement>("#w-model-fam")!.value).toBe("DeepSeek");
    expect(container.querySelector<HTMLInputElement>("#w-model-path")!.value).toBe("/models/ds");
  });

  it("pre-selects the suggested template but lets the operator override it", () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={[n1]} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} seed={seed()} />
    );
    // vllm preset applied (suggested template).
    clickText("Continue"); // → recipe step
    const vllm = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "vLLM");
    expect(vllm?.getAttribute("aria-checked")).toBe("true");
    clickText("TabbyAPI");
    const tabby = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "TabbyAPI");
    expect(tabby?.getAttribute("aria-checked")).toBe("true");
  });

  it("carries provenance to review and keeps external ownership + SAFETY line", async () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={[n1]} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} seed={seed()} />
    );
    await advanceToReview(container);

    expect(container.textContent).toContain("Detected");
    expect(container.textContent).toContain("External / observed");
    expect(container.textContent).toContain("CONFIG ONLY");
  });

  it("never infers topology from node count — 2 nodes with no degree reads unknown", async () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={[n1, n2]} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} seed={seed()} />
    );
    await advanceToReview(container);

    // Review topology line is unknown (no degrees set).
    expect(container.textContent).toContain("topology unknown");
    // And body validation keeps it non-blocking.
    expect(validateDraftRecipe).toHaveBeenCalled();
    const body = validateDraftRecipe.mock.calls[0][0] as Record<string, any>;
    expect(body.topology.unknown).toBe(true);
    expect(body.topology.tp).toBeNull();
  });

  it("represents explicit degrees as a topology (TP2) when the operator sets them", async () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={[n1, n2]} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} seed={seed()} />
    );
    // Walk to the compute step: model → recipe → runtime.
    clickText("Continue");
    clickText("Continue");
    clickText("Continue");
    clickText("Node One");
    clickText("Node Two");
    type(container, "#w-tp", "2");
    await flush();
    expect(container.textContent).toContain("TP2");
    expect(container.textContent).not.toContain("topology unknown");

    clickText("Continue"); // options
    clickText("Continue"); // validate
    await flush();
    const body = validateDraftRecipe.mock.calls.at(-1)![0] as Record<string, any>;
    expect(body.topology.tp).toBe(2);
    expect(body.topology.unknown).toBe(false);
  });

  it("saves config-only: external desiredState unknown, managedBy external", async () => {
    const onSaved = vi.fn();
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={[n1]} navigate={() => {}} onSaved={onSaved} onCancel={() => {}} seed={seed()} />
    );
    await advanceToSave(container);
    clickText("Create model + recipe + deployment");
    await flush();

    expect(createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ desiredState: "unknown", metadata: { managedBy: "external" } })
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it("handles an unreachable / unknown-runtime seed gracefully", () => {
    const { container } = render(
      <ModelWizard
        models={[]}
        recipes={[]}
        sparks={[n1]}
        navigate={() => {}}
        onSaved={() => {}}
        onCancel={() => {}}
        seed={seed({ reachable: false, runtime: "custom", modelId: null, suggestedTemplate: { templateId: "scratch", confidence: "low" }, provenance: { runtime: "unknown", modelId: "unknown" } })}
      />
    );
    expect(container.textContent).toContain("Unknown");
    expect(container.textContent).toContain("UNKNOWN to confirm");
  });
});

function type(container: HTMLElement, selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector);
  expect(input).not.toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input!, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
