import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { ExternalConnectPanel } from "./ModelDetail";
import type { RecipePublic } from "../../api/types";
import { render, flush, cleanupRenders } from "../../testing/render";

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    fetchRuntimes: vi.fn(async () => ({ runtimes: [{ id: "tabbyapi-exl3", label: "TabbyAPI", launchable: true }] })),
  };
});

const recipe: RecipePublic = {
  id: "r-ext", modelId: "m-quen", name: "Qwen external", runtime: "tabbyapi-exl3", topology: "single",
  nodeIds: ["dgx-3"], modelPath: "/models/qwen", workdir: "/w", logDir: "/logs", apiPort: 8889,
  healthPath: "/v1/models", contextLength: 600000, cpuAffinity: null, launcher: "manual", metadata: {},
  notes: "", env: [{ name: "TABBY_API_KEY", secret: true, hasValue: true }], archived: false, createdAt: 0, updatedAt: 0,
};

const connect = {
  endpoint: "http://10.0.0.9:8889/v1",
  hasKey: true,
  keyHint: "sk-abc…47f9",
  keyName: "TABBY_API_KEY",
  nodeNames: ["dgx-3"],
  note: "Launched outside SparkDash — manage via TabbyAPI",
};

describe("ExternalConnectPanel", () => {
  it("is read-only: endpoint copyable, real key hint masked, Stop/Restart disabled with tooltip", async () => {
    cleanupRenders();
    const { container } = render(<ExternalConnectPanel connect={connect} recipe={recipe} />);
    await flush();

    expect(container.textContent).toContain("http://10.0.0.9:8889/v1");
    expect(container.textContent).toContain("Launched outside SparkDash — manage via TabbyAPI");

    // Real stored prefix…suffix from the API hint, not hardcoded bullets.
    const masked = container.querySelector(".cp-id");
    expect(masked).not.toBeNull();
    expect(masked!.textContent).toContain("sk-abc…47f9");
    expect(masked!.getAttribute("title")).toContain("copy");

    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".cp-connect-actions button")];
    const stop = buttons.find((b) => b.textContent === "Stop");
    const restart = buttons.find((b) => b.textContent === "Restart");
    expect(stop?.disabled).toBe(true);
    expect(restart?.disabled).toBe(true);
    expect(stop?.title).toContain("TabbyAPI");
  });

  it("toggles key visibility without revealing a real secret", () => {
    cleanupRenders();
    const { container } = render(<ExternalConnectPanel connect={connect} recipe={recipe} />);
    const show = [...container.querySelectorAll<HTMLButtonElement>(".cp-connect-actions button")].find((b) => b.textContent === "Show");
    expect(show).not.toBeUndefined();
    act(() => show!.click());
    expect(container.textContent).toContain("secret store");
  });

  it("omits the key row when no key exists and still copies the endpoint", () => {
    cleanupRenders();
    const { container } = render(<ExternalConnectPanel connect={{ ...connect, hasKey: false }} recipe={null} />);
    expect(container.textContent).not.toContain("••••");
    const copy = [...container.querySelectorAll<HTMLButtonElement>(".cp-connect-actions button")].find((b) => b.textContent === "Copy");
    expect(copy?.disabled).toBe(false);
  });
});
