/**
 * REVIEW step must show a prominent, honest two-block WILL / WON'T safety
 * confirmation before Save. Config-only: no process, weight or secret touched.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { ModelWizard } from "./ModelWizard";
import type { DiscoveredSeed, SparkSnapshot } from "../../api/types";
import { render, cleanupRenders, flush } from "../../testing/render";

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

const client = await import("../../api/client");
const validateDraft = vi.mocked(client.validateDraftRecipe);

const spark = { id: "n1", name: "Node One", online: true, lanIp: "10.0.0.9" } as SparkSnapshot;

const seed: DiscoveredSeed = {
  reachable: true,
  runtime: "vllm",
  runtimeConfidence: "high",
  servedModelIds: ["qwen"],
  modelId: "qwen",
  health: "running",
  contextLength: 32768,
  apiProtocol: "openai",
  quantization: null,
  endpoint: "http://10.0.0.9:8888",
  credAttached: false,
  suggestedTemplate: { templateId: "vllm-openai", confidence: "high" },
  provenance: { modelId: "detected", runtime: "detected" },
  host: "10.0.0.9",
  port: 8888,
  scheme: "http",
  credRef: null,
  capabilities: null,
};

async function advanceToReview(n = 7) {
  for (let i = 0; i < n; i++) {
    const cont = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.trim() === "Continue" || b.textContent?.trim() === "Working…"
    )!;
    act(() => cont.click());
    await flush();
  }
}

beforeEach(() => {
  cleanupRenders();
  vi.clearAllMocks();
  validateDraft.mockResolvedValue({ ok: true, errors: [], warnings: [] } as never);
});

describe("ModelWizard REVIEW safety confirmation", () => {
  it("shows SparkDash WILL / WON'T as two prominent blocks", async () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={[spark]} seed={seed} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} />
    );
    await advanceToReview();
    const block = container.querySelector("[data-will-wont]");
    expect(block).not.toBeNull();
    expect(block!.textContent).toContain("SparkDash WILL");
    expect(block!.textContent).toContain("SparkDash WON'T");
    expect(container.querySelectorAll("[data-will-wont] > div")).toHaveLength(2);
  });

  it("WILL names config writes + observation; WON'T names lifecycle/weights/remote/secrets", async () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={[spark]} seed={seed} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} />
    );
    await advanceToReview();
    const text = container.querySelector("[data-will-wont]")!.textContent!;
    expect(text).toContain("CONFIG entities");
    expect(text).toContain("Observe the chosen endpoint");
    expect(text).toContain("Start / stop / restart / signal / reconfigure");
    expect(text).toContain("Move, copy or download weight");
    expect(text).toContain("Mutate the remote host");
    expect(text).toContain("secret values");
  });
});
