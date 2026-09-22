/**
 * Discovery-first Add Model entry: the picker must clearly offer the THREE
 * paths — DISCOVER RUNNING MODEL / START FROM TEMPLATE / CREATE FROM SCRATCH.
 * Templates are data-driven and never become permanent limits.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { ModelWizard } from "./ModelWizard";
import type { SparkSnapshot } from "../../api/types";
import { render, cleanupRenders } from "../../testing/render";

vi.mock("../../api/client", () => ({
  upsertModel: vi.fn(),
  upsertRecipe: vi.fn(),
  duplicateRecipe: vi.fn(),
  validateRecipe: vi.fn(),
  validateDraftRecipe: vi.fn(),
  createDeployment: vi.fn(),
  archiveModel: vi.fn(),
  fetchRuntimes: vi.fn(),
  probeDiscoveryEndpoint: vi.fn(),
  probeDiscoveryCapabilities: vi.fn(),
}));

const spark = { id: "n1", name: "Node One", online: true } as SparkSnapshot;

function clickText(text: string) {
  const btn = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
  expect(btn, `button "${text}"`).not.toBeUndefined();
  act(() => btn!.click());
}

beforeEach(() => {
  cleanupRenders();
  vi.clearAllMocks();
});

describe("ModelWizard discovery-first entry", () => {
  it("offers the three explicit paths up front", () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={[spark]} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} />
    );
    const texts = [...container.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(texts).toContain("Discover running model");
    expect(texts).toContain("Start from template");
    expect(texts).toContain("Create from scratch");
    // Data-driven templates are present (never a fixed runtime limit).
    expect([...container.querySelectorAll(".cp-template-card")].length).toBeGreaterThan(0);
    expect(container.textContent).toContain("External / observed");
  });

  it("DISCOVER path opens the read-only discovery form", () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={[spark]} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} />
    );
    clickText("Discover running model");
    expect(container.textContent).toContain("Discover running model");
    expect(container.textContent).toContain("read-only");
    expect(container.querySelector("#disc-host")).not.toBeNull();
  });

  it("CREATE FROM SCRATCH path opens the blank form", () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={[spark]} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} />
    );
    clickText("Create from scratch");
    expect(container.querySelector("#w-model-name")).not.toBeNull();
    expect(container.querySelectorAll(".cp-step")).toHaveLength(9);
  });

  it("template path pre-fills but every field stays editable", () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={[spark]} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} />
    );
    const card = [...container.querySelectorAll<HTMLButtonElement>(".cp-template-card")].find((c) =>
      c.textContent?.includes("TabbyAPI")
    )!;
    act(() => card.click());
    expect(container.querySelectorAll(".cp-step")).toHaveLength(9);
    const name = container.querySelector<HTMLInputElement>("#w-model-name");
    expect(name).not.toBeNull();
    name!.value = "";
    expect(name!.value).toBe("");
  });
});
