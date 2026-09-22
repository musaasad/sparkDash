/**
 * Structured v2 recipe editor proof: block-shaped write body (engine / serving /
 * launch / topology / healthProbe / logSource / tags), secrets stay as secretRef,
 * inline validate is a dry-run POST, and an archived recipe renders read-only.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { RecipeEditor } from "./RecipeEditor";
import type { RecipePublic, SparkSnapshot } from "../../api/types";
import { render, flush, cleanupRenders } from "../../testing/render";

vi.mock("../../api/client", () => ({
  upsertRecipe: vi.fn(),
  validateRecipe: vi.fn(),
}));

const client = await import("../../api/client");
const upsertRecipe = vi.mocked(client.upsertRecipe);
const validateRecipe = vi.mocked(client.validateRecipe);

const spark = { id: "n1", name: "Node One", online: true } as SparkSnapshot;

function type(container: HTMLElement, selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  expect(input).not.toBeNull();
  act(() => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickText(container: HTMLElement, text: string) {
  const btn = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
  expect(btn, `button "${text}"`).not.toBeUndefined();
  act(() => btn!.click());
}

function proven(): RecipePublic {
  return {
    id: "r1", modelId: "m1", name: "Proven", runtime: "tabbyapi-exl3", topology: "single",
    topologyBlock: { mode: "single", parallelism: 1, minNodes: 1, maxNodes: 1 },
    engine: { runtime: "tabbyapi-exl3", quantization: "EXL3", apiProtocol: "openai" },
    serving: { contextLength: 64000 }, launch: { mechanism: "command", env: [{ name: "TOKEN", secret: true, secretRef: "recipe:r1:TOKEN" }] },
    nodeIds: ["n1"], modelPath: "/m", workdir: "/w", logDir: "/logs", apiPort: 8889, healthPath: "/v1/models",
    contextLength: 64000, cpuAffinity: null, launcher: null, metadata: {}, notes: "", env: [],
    lifecycleState: "proven", archived: false, createdAt: 0, updatedAt: 0,
  };
}

beforeEach(() => {
  cleanupRenders();
  vi.clearAllMocks();
  upsertRecipe.mockResolvedValue({ recipe: { id: "r1" } as RecipePublic });
  validateRecipe.mockResolvedValue({ ok: true, errors: [], warnings: ["heads up"] });
});

describe("RecipeEditor structured v2", () => {
  it("writes structured blocks, not a legacy flat body", async () => {
    const onSaved = vi.fn();
    const { container } = render(<RecipeEditor modelId="m1" sparks={[spark]} onSaved={onSaved} onCancel={() => {}} />);

    type(container, "#r-name", "My Recipe"); // autoslugs id
    clickText(container, "Continue");
    type(container, "#r-quant", "EXL3 4.0bpw");
    clickText(container, "Continue");
    clickText(container, "Continue"); // advanced
    clickText(container, "Create recipe");
    await flush();

    expect(upsertRecipe).toHaveBeenCalledTimes(1);
    const body = upsertRecipe.mock.calls[0][0] as Record<string, any>;
    expect(body.engine).toBeTruthy();
    expect(body.serving).toBeTruthy();
    expect(body.launch).toBeTruthy();
    expect(body.topology).toBeTruthy();
    expect(body.healthProbe).toBeTruthy();
    expect(body.logSource).toBeTruthy();
    expect(body.modelRef).toEqual({ modelId: "m1", weightId: null });
    expect(onSaved).toHaveBeenCalled();
  });

  it("keeps secret entries as secretRef and never sends the value in the review label", () => {
    const { container } = render(<RecipeEditor modelId="m1" existing={proven()} sparks={[spark]} onSaved={() => {}} onCancel={() => {}} />);
    clickText(container, "Continue");
    clickText(container, "Continue");
    clickText(container, "Continue");
    expect(container.textContent).toContain("TOKEN→secretRef");
  });

  it("validate POSTs the dry-run route and shows warnings inline", async () => {
    const { container } = render(<RecipeEditor modelId="m1" existing={proven()} sparks={[spark]} onSaved={() => {}} onCancel={() => {}} />);
    clickText(container, "Continue");
    clickText(container, "Continue");
    clickText(container, "Continue");
    clickText(container, "Validate (dry-run)");
    await flush();
    expect(validateRecipe).toHaveBeenCalledWith("r1", ["n1"]);
    expect(container.textContent).toContain("heads up");
  });

  it("archived recipe is read-only", () => {
    const archived = { ...proven(), lifecycleState: "archived" as const, archived: true };
    const { container } = render(<RecipeEditor modelId="m1" existing={archived} sparks={[spark]} onSaved={() => {}} onCancel={() => {}} />);
    expect(container.querySelector<HTMLInputElement>("#r-name")?.disabled).toBe(true);
    expect(container.textContent).toContain("read-only");
  });
});
