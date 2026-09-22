/**
 * ROLE step proof: 6 roles from DEPLOYMENT_ROLES, PURE config selection with NO
 * model-name logic, default none/null (never auto-assigned), written on save and
 * changeable later via PATCH without recreation. Config-only (no lifecycle).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { ModelWizard } from "./ModelWizard";
import type { ModelEntry, RecipePublic, SparkSnapshot } from "../../api/types";
import { render, flush, cleanupRenders } from "../../testing/render";
import { DEPLOYMENT_ROLES, roleToSave } from "./deploymentRoles";

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

function clickText(_container: HTMLElement, text: string) {
  const btn = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
  expect(btn, `button "${text}"`).not.toBeUndefined();
  act(() => btn!.click());
}

function startScratch(container: HTMLElement) {
  const btn = [...container.querySelectorAll<HTMLButtonElement>(".cp-template-scratch")][0];
  act(() => btn.click());
}

/** Walk to the role step with one node placed. */
function advanceToRole(container: HTMLElement) {
  startScratch(container);
  type(container, "#w-model-name", "Any Model");
  clickText(container, "Continue"); // recipe
  type(container, "#w-r-name", "Any recipe");
  clickText(container, "Continue"); // runtime
  clickText(container, "Continue"); // compute
  clickText(container, "Node One");
  clickText(container, "Continue"); // topology
  clickText(container, "Continue"); // role
}

beforeEach(() => {
  cleanupRenders();
  vi.clearAllMocks();
  upsertModel.mockResolvedValue({ model: { id: "w-model" } as ModelEntry });
  upsertRecipe.mockResolvedValue({ recipe: { id: "w-recipe" } as RecipePublic });
  validateRecipe.mockResolvedValue({ ok: true, errors: [], warnings: [] });
  validateDraftRecipe.mockResolvedValue({ ok: true, errors: [], warnings: [] });
  vi.mocked(client.archiveModel).mockResolvedValue({ archived: true });
  vi.mocked(client.fetchRuntimes).mockResolvedValue({ runtimes: [] } as never);
  createDeployment.mockResolvedValue({ deployment: {} as never, runtime: {} as never });
});

describe("ModelWizard role step", () => {
  it("offers all 6 DEPLOYMENT_ROLES plus an explicit none, and is config-only", () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={[spark]} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} />
    );
    advanceToRole(container);
    expect(DEPLOYMENT_ROLES).toEqual(["primary", "worker", "specialist", "reviewer", "experimental", "none"]);
    for (const r of ["primary", "worker", "specialist", "reviewer", "experimental"]) {
      expect([...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === r), r).toBe(true);
    }
    expect(container.textContent).toContain("config selection only");
    expect(container.textContent).toContain("PATCH /api/deployments/:id");
    // No lifecycle: the step must say so.
    expect(container.textContent).not.toContain("started or stopped intentionally");
  });

  it("defaults to none/null and saves null, never auto-assigning primary", async () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={[spark]} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} />
    );
    advanceToRole(container);
    expect(container.textContent).toContain("Selected: none");
    clickText(container, "Continue"); // validate
    await flush();
    clickText(container, "Continue"); // review
    clickText(container, "Continue"); // save
    clickText(container, "Create model + recipe + deployment");
    await flush();
    expect(createDeployment).toHaveBeenCalledWith(expect.objectContaining({ role: null }));
  });

  it("writes a chosen role on save via config only — no model recreation", async () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={[spark]} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} />
    );
    advanceToRole(container);
    clickText(container, "specialist");
    expect(container.textContent).toContain("Selected: specialist");
    clickText(container, "Continue"); // validate
    await flush();
    clickText(container, "Continue"); // review
    expect(container.textContent).toContain("changeable later via PATCH");
    clickText(container, "Continue"); // save
    clickText(container, "Create model + recipe + deployment");
    await flush();
    expect(upsertModel).toHaveBeenCalledTimes(1); // created once, not per role
    expect(createDeployment).toHaveBeenCalledWith(expect.objectContaining({ role: "specialist" }));
  });

  it("roleToSave folds none to null (FE heuristic resumes)", () => {
    expect(roleToSave("")).toBeNull();
    expect(roleToSave("none")).toBeNull();
    expect(roleToSave("reviewer")).toBe("reviewer");
  });
});
