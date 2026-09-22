import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { LiveConsole } from "./LiveConsole";
import { render } from "../../testing/render";
import { seedConsole, setConsoleConnection, setDeployments } from "../../hooks/domainStore";
import type { ConsoleLine, ConsoleTelemetryRow, DeploymentStatus } from "../../api/types";

const line = (msg: string, level = "INFO"): ConsoleLine => ({ ts: new Date(Date.now() - 500).toISOString(), level, msg, raw: `${level} ${msg}` });

const telemetryRow = (reqId: number, over: Partial<ConsoleTelemetryRow> = {}): ConsoleTelemetryRow => ({
  reqId,
  ts: new Date(Date.now() - 500).toISOString(),
  state: "done",
  promptTokens: 100,
  generatedTokens: 20,
  cachedPct: 10,
  newPromptTokens: 90,
  prefillTps: 50,
  ttftSeconds: 0.4,
  decodeTps: 30,
  totalSeconds: 1.5,
  draftAccepted: 3,
  draftAttempted: 4,
  draftPct: 75,
  toolCalls: 0,
  temperature: 0.7,
  ...over,
});

const dep = (recipeId: string, modelId: string, nodeIds: string[]): DeploymentStatus =>
  ({ recipeId, modelId, nodeIds, apiPort: 8000, managedBy: "external", dryRun: true, state: "running", display: "Running external", updatedAt: 1 } as unknown as DeploymentStatus);

function type(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>(".cp-lc-search")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  setDeployments([dep("r1", "deepseek", ["dgx-1"]), dep("r2", "qwen", ["dgx-3"])]);
  seedConsole("r1", [line("#1 prefill ok"), line("#2 decode slow", "ERROR")], [telemetryRow(1), telemetryRow(2, { ttftSeconds: 9 })], true, null);
  seedConsole("r2", [line("#3 ok")], [telemetryRow(3)], true, null);
});

describe("LiveConsole operator experience", () => {
  it("renders the toolbar, source tabs, stream state and fixed-order metric chips", () => {
    const { container } = render(<LiveConsole recipeId="r1" logDir="/var/log/model" />);
    expect(container.querySelectorAll(".cp-lc-src")).toHaveLength(3); // TP2 + Qwen + All
    expect(container.textContent).toContain("Following");
    expect(container.textContent).toContain("Live on");
    expect(container.querySelectorAll(".cp-lc-metric").length).toBeGreaterThanOrEqual(9);
    expect(container.querySelectorAll(".cp-lc-histbar").length).toBeGreaterThan(0);
  });

  it("filters instantly on a field query without dropping rows", () => {
    const { container } = render(<LiveConsole recipeId="r1" logDir={null} />);
    const before = container.querySelectorAll(".cp-lc-row").length;
    type(container, "reqId:2");
    expect(container.querySelectorAll(".cp-lc-row")).toHaveLength(1);
    expect(container.querySelector(".cp-lc-req")?.textContent).toBe("#2");
    type(container, "");
    expect(container.querySelectorAll(".cp-lc-row").length).toBe(before);
  });

  it("shows severity facets with live counts and filters to errors", () => {
    const { container } = render(<LiveConsole recipeId="r1" logDir={null} />);
    const errorFacet = [...container.querySelectorAll<HTMLButtonElement>(".cp-lc-facet")].find((b) => b.classList.contains("error"))!;
    expect(errorFacet.textContent).toContain("1");
    act(() => errorFacet.click());
    expect(container.querySelectorAll(".cp-lc-row")).toHaveLength(1);
  });

  it("raises the amber disconnect banner naming the node with a reconnect action", () => {
    const { container } = render(<LiveConsole recipeId="r1" logDir="/var/log/model" />);
    act(() => setConsoleConnection("r1", false, "ssh timeout"));
    const banner = container.querySelector('[role="alert"]');
    expect(banner?.textContent).toContain("dgx-1");
    expect(banner?.textContent).toContain("Reconnect");
    expect(banner?.classList.contains("is-info")).toBe(false);
  });

  it("shows a neutral not-configured banner without Reconnect when logDir is absent", () => {
    const { container } = render(<LiveConsole recipeId="r1" logDir={null} />);
    act(() => setConsoleConnection("r1", false, "no logDir configured"));
    const banner = container.querySelector(".cp-lc-banner.is-info");
    expect(banner?.textContent).toContain("Not streaming");
    expect(banner?.textContent).toContain("no log directory configured for this recipe");
    expect(banner?.textContent).not.toContain("Reconnect");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("offers Clear filters and Refresh query when nothing matches", () => {
    const { container } = render(<LiveConsole recipeId="r1" logDir={null} />);
    type(container, "reqId:999");
    expect(container.textContent).toContain("No rows match the query");
    expect(container.textContent).toContain("Clear filters");
    expect(container.textContent).toContain("Refresh query");
  });

  it("expands a row into a Parsed/Raw drawer with copy and View in Activity", () => {
    const { container } = render(<LiveConsole recipeId="r1" logDir={null} />);
    act(() => container.querySelector<HTMLElement>(".cp-lc-row")!.click());
    expect(container.querySelector(".cp-lc-drawer")).not.toBeNull();
    expect(container.textContent).toContain("View in Activity");
    expect(container.textContent).toContain("Copy full payload");
    const rawTab = [...container.querySelectorAll<HTMLButtonElement>(".cp-tab")].find((b) => b.textContent === "Raw")!;
    act(() => rawTab.click());
    expect(container.querySelector(".cp-lc-raw")).not.toBeNull();
  });

  it("pauses follow with a sticky resume button and a Paused indicator", () => {
    const { container } = render(<LiveConsole recipeId="r1" logDir={null} />);
    const live = container.querySelector<HTMLButtonElement>(".cp-lc-live")!;
    act(() => live.click());
    expect(container.textContent).toContain("Paused");
    const sticky = container.querySelector<HTMLButtonElement>(".cp-lc-sticky")!;
    expect(sticky.textContent).toContain("resume follow");
    act(() => sticky.click());
    expect(container.textContent).toContain("Following");
  });

  it("pre-seeds the query from a deep-link initialReqId", () => {
    const { container } = render(<LiveConsole recipeId="r1" logDir={null} initialReqId={2} />);
    expect(container.querySelector<HTMLInputElement>(".cp-lc-search")!.value).toBe("reqId:2");
    expect(container.querySelectorAll(".cp-lc-row")).toHaveLength(1);
    expect(container.querySelector(".cp-lc-req")?.textContent).toBe("#2");
  });
});
