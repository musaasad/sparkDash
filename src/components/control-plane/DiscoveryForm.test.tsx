/**
 * Discovery form proof: read-only probe → detected fields with provenance,
 * overridable suggested template, SEPARATE opt-in capability probe, graceful
 * unreachable handling. Client fetch is fully mocked — no real network.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { DiscoveryForm } from "./DiscoveryForm";
import type { DiscoveryProbeResult, ProbeCapabilitiesResult } from "../../api/types";
import { render, flush, cleanupRenders } from "../../testing/render";

vi.mock("../../api/client", () => ({
  probeDiscoveryEndpoint: vi.fn(),
  probeDiscoveryCapabilities: vi.fn(),
  fetchRuntimes: vi.fn(),
}));

const client = await import("../../api/client");
const probeEndpoint = vi.mocked(client.probeDiscoveryEndpoint);
const probeCaps = vi.mocked(client.probeDiscoveryCapabilities);

function result(over: Partial<DiscoveryProbeResult> = {}): DiscoveryProbeResult {
  return {
    reachable: true,
    runtime: "tabbyapi-exl3",
    runtimeConfidence: "high",
    servedModelIds: ["qwen-exl3"],
    modelId: "qwen-exl3",
    health: "running",
    contextLength: 16384,
    apiProtocol: "openai",
    quantization: "exl3",
    endpoint: "http://10.0.0.5:8889/v1/models",
    credAttached: false,
    suggestedTemplate: { templateId: "tabbyapi-exl3", confidence: "high" },
    provenance: {
      host: "user",
      port: "user",
      reachable: "probed",
      runtime: "detected",
      modelId: "detected",
      apiProtocol: "detected",
      contextLength: "detected",
      quantization: "detected",
      credRef: "user",
    },
    ...over,
  };
}

function caps(): ProbeCapabilitiesResult {
  return {
    text: "yes",
    streaming: "yes",
    vision: "unknown",
    tools: "unknown",
    reasoning: "unknown",
    modelId: "qwen-exl3",
    provenance: { text: "probed", streaming: "probed" },
    credAttached: false,
  };
}

function type(container: HTMLElement, selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector);
  expect(input).not.toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input!, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickText(text: string) {
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

beforeEach(() => {
  cleanupRenders();
  vi.clearAllMocks();
  vi.mocked(client.fetchRuntimes).mockResolvedValue({
    runtimes: [{ id: "vllm", label: "vLLM", launchable: true }, { id: "tabbyapi-exl3", label: "TabbyAPI", launchable: true }],
  } as never);
  probeEndpoint.mockResolvedValue(result());
  probeCaps.mockResolvedValue(caps());
});

describe("DiscoveryForm", () => {
  it("probes one typed endpoint and renders detected fields with provenance badges", async () => {
    const onSeed = vi.fn();
    const { container } = render(<DiscoveryForm recipes={[]} onSeed={onSeed} onBack={() => {}} />);

    type(container, "#disc-host", "10.0.0.5");
    type(container, "#disc-port", "8889");
    clickText("Discover");
    await flush();

    expect(probeEndpoint).toHaveBeenCalledWith(expect.objectContaining({ host: "10.0.0.5", port: 8889, scheme: "http" }));
    expect(container.textContent).toContain("Detected");
    expect(container.textContent).toContain("qwen-exl3");
    // Capability probe is NOT automatic.
    expect(probeCaps).not.toHaveBeenCalled();
  });

  it("keeps the suggested template overridable and seeds the chosen one", async () => {
    const onSeed = vi.fn();
    const { container } = render(<DiscoveryForm recipes={[]} onSeed={onSeed} onBack={() => {}} />);

    type(container, "#disc-host", "10.0.0.5");
    type(container, "#disc-port", "8889");
    clickText("Discover");
    await flush();

    // Suggestion pre-selected from the probe…
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Suggested template"]')?.value).toBe("tabbyapi-exl3");
    // …and overridable.
    pickSelect(container, '[aria-label="Suggested template"]', "vllm-openai");
    clickText("Continue to setup");

    expect(onSeed).toHaveBeenCalledWith(expect.objectContaining({ suggestedTemplate: expect.objectContaining({ templateId: "vllm-openai" }), host: "10.0.0.5", port: 8889 }));
  });

  it("runs the capability probe only on the explicit opt-in button", async () => {
    const { container } = render(<DiscoveryForm recipes={[]} onSeed={vi.fn()} onBack={() => {}} />);

    type(container, "#disc-host", "10.0.0.5");
    type(container, "#disc-port", "8889");
    clickText("Discover");
    await flush();
    expect(probeCaps).not.toHaveBeenCalled();

    clickText("Probe capabilities (opt-in, tiny)");
    await flush();
    expect(probeCaps).toHaveBeenCalledWith(expect.objectContaining({ modelId: "qwen-exl3" }));
    expect(container.textContent).toContain("streaming");
  });

  it("degrades gracefully when unreachable — unknowns, still continuable", async () => {
    probeEndpoint.mockResolvedValue(
      result({
        reachable: false,
        health: "not-detected",
        modelId: null,
        servedModelIds: [],
        contextLength: null,
        quantization: null,
        runtime: "custom",
        suggestedTemplate: { templateId: "scratch", confidence: "low" },
        provenance: { runtime: "unknown", modelId: "unknown", apiProtocol: "unknown", contextLength: "unknown" },
      })
    );
    const onSeed = vi.fn();
    const { container } = render(<DiscoveryForm recipes={[]} onSeed={onSeed} onBack={() => {}} />);

    type(container, "#disc-host", "10.0.0.9");
    type(container, "#disc-port", "9999");
    clickText("Discover");
    await flush();

    expect(container.textContent).toContain("Not reachable");
    expect(container.textContent).toContain("Unknown");
    clickText("Continue to setup");
    expect(onSeed).toHaveBeenCalledWith(expect.objectContaining({ reachable: false }));
  });
});
