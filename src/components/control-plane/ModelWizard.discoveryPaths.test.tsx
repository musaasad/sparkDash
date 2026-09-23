/**
 * Discovery-first Add Model entry: the picker must clearly offer the FIVE
 * explicit paths — DISCOVER RUNNING MODEL / DISCOVER LOCAL WEIGHTS / START FROM
 * PROVEN TEMPLATE / CONNECT EXTERNAL ENDPOINT / ADVANCED. Discovery paths are the
 * emphasised primaries; Advanced replaces "Create from scratch".
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
  scanLocalWeights: vi.fn(),
}));

const spark = { id: "n1", name: "Node One", online: true } as SparkSnapshot;

function clickPath(label: string) {
  const btn = [...document.querySelectorAll<HTMLButtonElement>(".cp-path-card")].find((b) =>
    b.textContent?.includes(label)
  );
  expect(btn, `path card "${label}"`).not.toBeUndefined();
  act(() => btn!.click());
}

beforeEach(() => {
  cleanupRenders();
  vi.clearAllMocks();
});

describe("ModelWizard discovery-first entry", () => {
  it("offers the five explicit paths up front, discovery emphasised", () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={[spark]} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} />
    );
    const texts = [...container.querySelectorAll(".cp-path-card")].map((b) => b.textContent ?? "");
    expect(texts.some((t) => t.includes("Discover running model"))).toBe(true);
    expect(texts.some((t) => t.includes("Discover local weights"))).toBe(true);
    expect(texts.some((t) => t.includes("Start from proven template"))).toBe(true);
    expect(texts.some((t) => t.includes("Connect external endpoint"))).toBe(true);
    expect(texts.some((t) => t.includes("Advanced"))).toBe(true);
    // Advanced replaced the old "Create from scratch" wording.
    expect(texts.some((t) => t.includes("Create from scratch"))).toBe(false);
    // Discovery tier cards carry the emphasised marker.
    expect(container.querySelectorAll(".cp-path-card.is-discovery").length).toBeGreaterThanOrEqual(3);
    // Each path explains what SparkDash will NOT do.
    expect(container.textContent).toContain("Won't:");
  });

  it("DISCOVER path opens the read-only discovery form", () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={[spark]} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} />
    );
    clickPath("Discover running model");
    expect(container.textContent).toContain("read-only");
    expect(container.querySelector("#disc-host")).not.toBeNull();
  });

  it("LOCAL WEIGHTS path opens the bounded local-weights form", () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={[spark]} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} />
    );
    clickPath("Discover local weights");
    expect(container.textContent).toContain("readdir/stat");
    expect(container.querySelector("#lw-dir")).not.toBeNull();
    expect(container.textContent).toContain("does not sweep the whole filesystem");
  });

  it("EXTERNAL path opens an OpenAI-compatible base-URL form", () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={[spark]} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} />
    );
    clickPath("Connect external endpoint");
    expect(container.querySelector("#ext-url")).not.toBeNull();
    expect(container.textContent).toContain("value is never echoed");
  });

  it("ADVANCED path opens the blank manual form with the compact 9-step stepper", () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={[spark]} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} />
    );
    clickPath("Advanced");
    expect(container.querySelector("#w-model-name")).not.toBeNull();
    expect(container.querySelector(".cp-stepper-count")?.textContent).toContain("Step 1 of 9");
    expect(container.querySelector("#w-model-name")).not.toBeNull();
  });

  it("template path pre-fills but every field stays editable", () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={[spark]} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} />
    );
    clickPath("Start from proven template");
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
