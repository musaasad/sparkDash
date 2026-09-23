/**
 * ExternalEndpointForm — first-class external OpenAI-compatible path.
 * Read-only GET /v1/models probe prefills identity; credential is a REF only.
 * managedBy=external and family stays UNKNOWN.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { ExternalEndpointForm } from "./ExternalEndpointForm";
import { render, cleanupRenders, flush } from "../../testing/render";

vi.mock("../../api/client", () => ({
  probeDiscoveryEndpoint: vi.fn(),
  probeDiscoveryCapabilities: vi.fn(),
}));

const client = await import("../../api/client");
const probe = vi.mocked(client.probeDiscoveryEndpoint);

const probeResult = {
  reachable: true,
  runtime: "vllm" as const,
  runtimeConfidence: "high" as const,
  servedModelIds: ["qwen-3.8"],
  modelId: "qwen-3.8",
  health: "running-external" as const,
  contextLength: 32768,
  apiProtocol: "openai" as const,
  quantization: null,
  endpoint: "http://api.example.com:8889",
  credAttached: false,
  suggestedTemplate: { templateId: "vllm-openai", confidence: "high" as const },
  provenance: { modelId: "detected" as const, runtime: "detected" as const },
};

function setInput(container: HTMLElement, id: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(id)!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  cleanupRenders();
  vi.clearAllMocks();
});

describe("ExternalEndpointForm", () => {
  it("parses a base URL, probes read-only and prefills detected identity", async () => {
    probe.mockResolvedValue(probeResult as never);
    const { container } = render(<ExternalEndpointForm recipes={[]} onSeed={() => {}} onBack={() => {}} />);
    setInput(container, "#ext-url", "https://api.example.com:8889/v1");
    setInput(container, "#ext-cred", "recipe:abc:API_KEY");

    act(() => [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Probe endpoint")!.click());
    await flush();

    expect(probe).toHaveBeenCalledWith({ host: "api.example.com", port: 8889, scheme: "https", credRef: "recipe:abc:API_KEY" });
    expect(container.textContent).toContain("qwen-3.8");
    expect(container.textContent).toContain("family and weight path stay BLANK + UNKNOWN");
  });

  it("hands the seed with scheme/host/port/path and credRef (value never echoed)", async () => {
    probe.mockResolvedValue(probeResult as never);
    const seeded: unknown[] = [];
    const { container } = render(<ExternalEndpointForm recipes={[]} onSeed={(s) => seeded.push(s)} onBack={() => {}} />);
    setInput(container, "#ext-url", "http://10.0.0.12:8889/v1/");
    setInput(container, "#ext-cred", "recipe:abc:API_KEY");
    act(() => [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Probe endpoint")!.click());
    await flush();
    act(() => [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Continue to setup")!.click());

    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toMatchObject({ host: "10.0.0.12", port: 8889, scheme: "http", endpointPath: "/v1", credRef: "recipe:abc:API_KEY" });
  });

  it("rejects a malformed base URL with an honest error", async () => {
    const { container } = render(<ExternalEndpointForm recipes={[]} onSeed={() => {}} onBack={() => {}} />);
    setInput(container, "#ext-url", "http://bad host here");
    act(() => [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Probe endpoint")!.click());
    await flush();
    expect(probe).not.toHaveBeenCalled();
    expect(container.querySelector("[role='alert']")).not.toBeNull();
  });
});
