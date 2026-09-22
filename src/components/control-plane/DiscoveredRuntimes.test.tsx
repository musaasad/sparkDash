import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { DiscoveredRuntimes } from "./DiscoveredRuntimes";
import type { DiscoveredRuntime, SparkSnapshot } from "../../api/types";
import { render, flush, cleanupRenders } from "../../testing/render";

vi.mock("../../api/client", () => ({
  fetchDiscovery: vi.fn(),
  fetchModels: vi.fn(),
  adoptDiscovered: vi.fn(),
  fetchRuntimes: vi.fn(),
}));

const { fetchDiscovery, fetchModels, adoptDiscovered, fetchRuntimes } = await import("../../api/client");
const discovery = vi.mocked(fetchDiscovery);
const models = vi.mocked(fetchModels);
const adopt = vi.mocked(adoptDiscovered);

function disc(over: Partial<DiscoveredRuntime> = {}): DiscoveredRuntime {
  return {
    id: "disc-n1-8888",
    nodeId: "n1",
    port: 8888,
    servedModelIds: ["qwen-3.8-flash"],
    runtime: "vllm",
    health: "running",
    processEvidence: true,
    endpoint: "http://10.0.0.9:8888/v1/models",
    detectedAt: 0,
    adoptedAt: null,
    adoptionMode: null,
    alreadyAdopted: false,
    matchedModelId: null,
    matchedRecipeId: null,
    ...over,
  };
}

const spark = { id: "n1", name: "Node One" } as SparkSnapshot;

beforeEach(() => {
  cleanupRenders();
  discovery.mockReset();
  models.mockReset();
  adopt.mockReset();
  models.mockResolvedValue({ models: [{ id: "m1", name: "M One", archived: false } as never] });
  adopt.mockResolvedValue({} as never);
  vi.mocked(fetchRuntimes).mockResolvedValue({
    runtimes: [{ id: "vllm", label: "vLLM", launchable: true }],
  } as never);
});

describe("DiscoveredRuntimes", () => {
  it("renders no band when nothing is new", async () => {
    discovery.mockResolvedValue({ discovered: [], readOnly: true });
    const { container } = render(<DiscoveredRuntimes sparks={[spark]} onSaved={() => {}} />);
    await flush();
    expect(container.textContent).not.toContain("Discovered runtimes");
  });

  it("hides already-adopted runtimes and shows a band with evidence", async () => {
    discovery.mockResolvedValue({ discovered: [disc(), disc({ id: "adopted", alreadyAdopted: true })], readOnly: true });
    const { container } = render(<DiscoveredRuntimes sparks={[spark]} onSaved={() => {}} />);
    await flush();
    expect(container.textContent).toContain("Discovered runtimes");
    expect(container.textContent).toContain("qwen-3.8-flash");
    expect(container.textContent).toContain(":8888");
    expect(container.querySelectorAll('[title*="adopt"], button').length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("adopted"); // id-only row for the adopted one
  });

  it("filters to the requested node", async () => {
    discovery.mockResolvedValue({ discovered: [disc(), disc({ id: "x", nodeId: "n2" })], readOnly: true });
    const { container } = render(<DiscoveredRuntimes sparks={[spark]} nodeId="n1" onSaved={() => {}} />);
    await flush();
    expect(container.textContent).toContain("qwen-3.8-flash");
    expect(container.textContent).toContain("Discovered runtimes");
  });

  it("adopt create path reviews then saves config-only", async () => {
    discovery.mockResolvedValue({ discovered: [disc()], readOnly: true });
    render(<DiscoveredRuntimes sparks={[spark]} onSaved={() => {}} />);
    await flush();

    const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Review & Adopt"));
    expect(btn).toBeTruthy();
    await act(async () => btn!.click());
    await flush();
    // form step
    const createBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Create new");
    await act(async () => createBtn!.click());
    await flush();

    const reviewBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Review");
    await act(async () => reviewBtn!.click());
    await flush();
    expect(document.body.textContent).toContain("untouched");

    const save = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Create & bind"));
    await act(async () => save!.click());
    await flush();

    expect(adopt).toHaveBeenCalledTimes(1);
    const [id, body] = adopt.mock.calls[0];
    expect(id).toBe("disc-n1-8888");
    expect(body.mode).toBe("create");
  });
});
