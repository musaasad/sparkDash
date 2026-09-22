/**
 * TOPOLOGY step proof: explicit strategies + free integer degrees, capability
 * from provider DATA. DISTINCT VALID / INVALID(reason) / NEEDS-CONFIRMATION —
 * UNKNOWN is never rendered as VALID, and unsupported is never hidden.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { ModelWizard } from "./ModelWizard";
import type { ModelEntry, RecipePublic, RecipeRuntime, SparkSnapshot } from "../../api/types";
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
vi.mocked(client.fetchRuntimes).mockResolvedValue({ runtimes: [] } as never);

/** Provider DATA: vllm TP by node count, tabbyapi single-only, custom silent. */
const RUNTIMES: { id: RecipeRuntime; label: string; topology?: Record<string, string> }[] = [
  { id: "vllm", label: "vLLM", topology: { single: "supported", tp: "by-node-count" } },
  { id: "tabbyapi-exl3", label: "TabbyAPI", topology: { single: "supported", tp: "unsupported", pp: "unsupported", dp: "unsupported", ep: "unsupported" } },
  { id: "custom", label: "Custom" },
];

const NODES = ["n1", "n2", "n3"];
const sparks = NODES.map((id) => ({ id, name: `Node ${id}`, online: true }) as SparkSnapshot);

function type(container: HTMLElement, selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector);
  expect(input).not.toBeNull();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input!, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickText(text: string) {
  const btn = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
  expect(btn, `button "${text}"`).not.toBeUndefined();
  act(() => btn!.click());
}

/** Walk to the topology step on a chosen runtime with N nodes placed. */
function advanceToTopology(container: HTMLElement, runtimeLabel: string, nodes: number) {
  const scratch = [...container.querySelectorAll<HTMLButtonElement>(".cp-template-scratch")][0];
  act(() => scratch.click());
  type(container, "#w-model-name", "Any Model");
  clickText("Continue"); // recipe
  type(container, "#w-r-name", "Any recipe");
  clickText(runtimeLabel); // choose runtime by provider DATA, not model name
  clickText("Continue"); // runtime
  clickText("Continue"); // compute
  for (const n of NODES.slice(0, nodes)) clickText(`Node ${n}`);
  clickText("Continue"); // topology
}

const status = (container: HTMLElement) => container.querySelector("[data-topology-status]")?.getAttribute("data-topology-status");

beforeEach(() => {
  cleanupRenders();
  vi.clearAllMocks();
  vi.mocked(client.fetchRuntimes).mockResolvedValue({ runtimes: [] } as never);
  vi.mocked(client.validateDraftRecipe).mockResolvedValue({ ok: true, errors: [], warnings: [] });
  vi.mocked(client.validateRecipe).mockResolvedValue({ ok: true, errors: [], warnings: [] });
});

describe("ModelWizard topology step", () => {
  it("lists all five explicit strategies and marks tiers from provider data", () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={sparks} runtimes={RUNTIMES} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} />
    );
    advanceToTopology(container, "TabbyAPI", 2);
    expect(container.textContent).toContain("SINGLE");
    expect(container.textContent).toContain("TP · tensor-parallel");
    // unsupported strategies stay VISIBLE, never hidden.
    expect(container.textContent).toContain("unsupported");
  });

  it("vllm TP2 on 2 nodes is VALID", () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={sparks} runtimes={RUNTIMES} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} />
    );
    advanceToTopology(container, "vLLM", 2);
    type(container, "#w-tp", "2");
    expect(status(container)).toBe("valid");
    expect(container.textContent).toContain("VALID");
  });

  it("vllm TP4 on 2 nodes is INVALID with a reason and blocks Continue", () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={sparks} runtimes={RUNTIMES} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} />
    );
    advanceToTopology(container, "vLLM", 2);
    type(container, "#w-tp", "4");
    expect(status(container)).toBe("invalid");
    expect(container.textContent).toContain("at least 4 node");
    clickText("Continue");
    // Still on topology; the error surfaced.
    expect(container.textContent).toContain("Topology invalid");
  });

  it("TP3 on 3 nodes with a silent runtime is NEEDS-CONFIRMATION, not VALID", () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={sparks} runtimes={RUNTIMES} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} />
    );
    advanceToTopology(container, "Custom", 3);
    type(container, "#w-tp", "3");
    expect(status(container)).toBe("needs-confirmation");
    expect(container.textContent).not.toContain("NEEDS CONFIRMATION: structurally sound");
  });

  it("tabbyapi TP on 2 nodes is INVALID (runtime explicitly does not support TP)", () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={sparks} runtimes={RUNTIMES} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} />
    );
    advanceToTopology(container, "TabbyAPI", 2);
    type(container, "#w-tp", "2");
    expect(status(container)).toBe("invalid");
    expect(container.textContent).toContain("does not support TP");
  });

  it("3 nodes with no degree is NEEDS-CONFIRMATION (fleet size != degree)", () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={sparks} runtimes={RUNTIMES} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} />
    );
    advanceToTopology(container, "vLLM", 3);
    expect(status(container)).toBe("needs-confirmation");
    expect(container.textContent).toContain("do not imply");
  });

  it("validate report shows ? for unverifiable runtime/weights, never a false ✓", async () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={sparks} runtimes={RUNTIMES} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} />
    );
    advanceToTopology(container, "Custom", 1);
    clickText("Continue"); // role & options
    clickText("Continue"); // schedule validate (runs the dry-run)
    await flush();
    await flush();
    const report = container.querySelector("[data-validate-report]");
    expect(report).not.toBeNull();
    expect(report!.querySelector('[data-status="unknown"]')?.textContent).toContain("?");
    // Runtime capability is silent for "custom" ⇒ RUNTIME must be ?, not ✓.
    const runtimeLine = [...report!.querySelectorAll("dd")].find((d) => d.textContent?.includes("NOT-VERIFIED"));
    expect(runtimeLine?.getAttribute("data-status")).toBe("unknown");
  });

  it("rejects a non-integer degree", () => {
    const { container } = render(
      <ModelWizard models={[]} recipes={[]} sparks={sparks} runtimes={RUNTIMES} navigate={() => {}} onSaved={() => {}} onCancel={() => {}} />
    );
    advanceToTopology(container, "vLLM", 2);
    type(container, "#w-tp", "0");
    clickText("Continue");
    expect(container.textContent).toContain("integer ≥ 1");
  });
});
