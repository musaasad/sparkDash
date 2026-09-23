/**
 * Lifecycle separation proof: STOP changes desiredState (simulated) and keeps
 * the recipe; REMOVE deletes the binding only and keeps recipe/model/weights.
 * External deployments stay disabled with a reason.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { DeployControls } from "./DeployControls";
import type { DeploymentStatus, RecipePublic } from "../../api/types";
import { render, flush, cleanupRenders } from "../../testing/render";

vi.mock("../../api/client", () => ({
  deploymentAction: vi.fn(),
  deleteDeployment: vi.fn(),
}));

const client = await import("../../api/client");
const deploymentAction = vi.mocked(client.deploymentAction);
const deleteDeployment = vi.mocked(client.deleteDeployment);

const recipe: RecipePublic = {
  id: "r1", modelId: "m1", name: "Recipe", runtime: "vllm", topology: "single",
  nodeIds: ["n1"], modelPath: "/m", workdir: "/w", logDir: null, apiPort: 8889,
  healthPath: "/v1/models", contextLength: null, cpuAffinity: null, launcher: null,
  metadata: {}, notes: "", env: [], archived: false, createdAt: 0, updatedAt: 0,
};

const dep = (over: Partial<DeploymentStatus> = {}): DeploymentStatus => ({
  deploymentId: "dep-1", recipeId: "r1", modelId: "m1", nodeIds: ["n1"], apiPort: 8889,
  managedBy: "sparkdash", dryRun: true, state: "running", desired: "running", observed: "running",
  discovered: false, display: "running", lastOp: null, lastError: null, startedAt: null, updatedAt: 0, ...over,
});

function clickText(container: HTMLElement, text: string) {
  void container;
  const btn = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
  expect(btn, `button "${text}"`).not.toBeUndefined();
  act(() => btn!.click());
}

/** Click the confirm button inside the open modal (never the row trigger). */
function confirmModal() {
  const btn = document.querySelector<HTMLButtonElement>(".cp-modal-foot button:last-child");
  expect(btn).not.toBeNull();
  act(() => btn!.click());
}

beforeEach(() => {
  cleanupRenders();
  vi.clearAllMocks();
  deploymentAction.mockResolvedValue({ deployment: dep({ state: "stopping" }), dryRun: true });
  deleteDeployment.mockResolvedValue({ deleted: true, id: "dep-1" });
});

describe("DeployControls lifecycle separation", () => {
  it("STOP modal says the recipe is untouched and simulates the state", async () => {
    const { container } = render(<DeployControls recipe={recipe} deployment={dep()} onUpdated={() => {}} />);
    clickText(container, "Stop");
    const modal = document.querySelector(".cp-modal")!;
    expect(modal.textContent).toContain("recipe is untouched");
    expect(modal.textContent).toContain("simulated");
    expect(modal.querySelector(".cp-modal-diagram")).not.toBeNull();
    // Transitional stop uses the accent primary, never danger-solid.
    expect(modal.querySelector(".cp-modal-foot button:last-child")?.className).toContain("primary");
    confirmModal();
    await flush();
    expect(deploymentAction).toHaveBeenCalledWith("dep-1", "stop");
  });

  it("REMOVE modal deletes the binding only and has no state diagram", async () => {
    const { container } = render(<DeployControls recipe={recipe} deployment={dep()} onUpdated={() => {}} />);
    clickText(container, "Remove binding");
    const modal = document.querySelector(".cp-modal")!;
    expect(modal.textContent).toContain("BINDING only");
    expect(modal.textContent).toContain("weight file");
    expect(modal.querySelector(".cp-modal-diagram")).toBeNull();
    // Terminal remove binding keeps danger-solid.
    expect(modal.querySelector(".cp-modal-foot button:last-child")?.className).toContain("danger-solid");
    confirmModal();
    await flush();
    expect(deleteDeployment).toHaveBeenCalledWith("dep-1");
  });

  it("external deployment renders controls disabled with a reason", () => {
    const { container } = render(
      <DeployControls recipe={recipe} deployment={dep({ managedBy: "external", display: "running-external" })} />
    );
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")];
    const stop = buttons.find((b) => b.textContent?.trim() === "Stop")!;
    expect(stop.disabled).toBe(true);
    expect(stop.title).toContain("Externally managed");
  });

  it("F7: external still ENABLES the config-only Remove binding", () => {
    render(<DeployControls recipe={recipe} deployment={dep({ managedBy: "external", display: "running-external" })} />);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")];
    const remove = buttons.find((b) => b.textContent?.trim() === "Remove binding")!;
    expect(remove.disabled).toBe(false);
    expect(remove.title).toContain("the external process is untouched");
    // Lifecycle stays disabled on an uncontrolled process.
    expect(buttons.find((b) => b.textContent?.trim() === "Start")!.disabled).toBe(true);
  });
});
