import { describe, expect, it } from "vitest";
import type { DeploymentStatus } from "../../api/types";
import type { DeploymentView } from "./fleetModel";
import type { DeploymentTelemetry } from "./fleetModel";
import { DeploymentInstrument } from "./DeploymentInstrument";
import { render, cleanupRenders } from "../../testing/render";

function dep(over: Partial<DeploymentStatus> = {}): DeploymentStatus {
  return {
    recipeId: "r1", modelId: "m1", nodeIds: ["n1"], apiPort: 8889,
    managedBy: "sparkdash", dryRun: true, state: "running", desired: "running", observed: "running",
    discovered: false, display: "running", lastOp: null, lastError: null, startedAt: null, updatedAt: 0,
    ...over,
  };
}

function telem(over: Partial<DeploymentTelemetry> = {}): DeploymentTelemetry {
  return {
    generationTps: 120, prefillTps: 500, ttftSeconds: 0.42, requestsRunning: 2, requestsWaiting: 0,
    kvCacheUsage: 0.5, prefixCacheHitRate: 0.9, mtpAcceptanceRate: 0.7, contextLength: 32000,
    gpuMemoryUtilization: 0.8, slotsActive: 2, slotsTotal: 4, totalOutputTokens: 500,
    backend: null, modelId: "m1", available: true, error: null,
    ...over,
  };
}

function view(over: Partial<DeploymentView> = {}): DeploymentView {
  const d = over.deployment ?? dep();
  return {
    deployment: d, key: "k1", recipe: null, modelName: "Test Model", rawModelId: "m1",
    nodes: [{ id: "n1", name: "Node 1", online: true, role: "head" } as never],
    runtime: "tabbyapi", topology: "single", lifecycleState: null, contextLength: 32000,
    port: 8889, decodeTps: null, telemetry: telem(), uptime: 3600,
    ...over,
  };
}

const noop = () => {};

describe("DeploymentInstrument", () => {
  it("renders the derived PRIMARY role and a state pill from the runtime state", () => {
    cleanupRenders();
    const { container } = render(
      <DeploymentInstrument view={view()} role="PRIMARY" state="serving" history={[100, 120]} lastRequestAt={null}
        now={1000} runtimeLabels={{ tabbyapi: "TabbyAPI" }} runtimeMetrics={{}} onOpen={noop} />
    );
    expect(container.querySelector(".cp-inst-role")?.textContent).toBe("PRIMARY");
    expect(container.querySelector(".cp-inst-state")?.textContent).toContain("SERVING");
    expect(container.querySelector(".cp-inst-state")?.classList.contains("tone-live")).toBe(true);
  });

  it("shows only secondary instruments the runtime declares", () => {
    cleanupRenders();
    const { container } = render(
      <DeploymentInstrument view={view()} role="PRIMARY" state="serving" history={[100, 120]} lastRequestAt={null}
        now={1000} runtimeLabels={{}} runtimeMetrics={{ tabbyapi: ["mtpAcceptanceRate", "ttftSeconds"] }} onOpen={noop} />
    );
    const labels = [...container.querySelectorAll(".cp-inst-cell-label")].map((e) => e.textContent);
    expect(labels).toEqual(["MTP", "TTFT"]);
  });

  it("omits the whole secondary row when the runtime declares nothing", () => {
    cleanupRenders();
    const { container } = render(
      <DeploymentInstrument view={view()} role="WORKER" state="idle" history={[]} lastRequestAt={null}
        now={1000} runtimeLabels={{}} runtimeMetrics={{}} onOpen={noop} />
    );
    expect(container.querySelector(".cp-inst-secondary")).toBeNull();
  });

  it("keeps idle calm: state word + recency, never an alarming 0", () => {
    cleanupRenders();
    const { container } = render(
      <DeploymentInstrument view={view({ telemetry: telem({ generationTps: null }) })} role="PRIMARY" state="idle"
        history={[10, 10]} lastRequestAt={900} now={1000} runtimeLabels={{}} runtimeMetrics={{}} onOpen={noop} />
    );
    expect(container.querySelector(".cp-gauge-center")?.textContent).toContain("IDLE");
    expect(container.querySelector(".cp-inst-recency")?.textContent).toContain("last request");
  });

  it("says 'no active traffic' when recency is unknown AND metrics are readable", () => {
    cleanupRenders();
    const { container } = render(
      <DeploymentInstrument view={view({ telemetry: telem({ generationTps: null }) })} role="PRIMARY" state="ready"
        history={[]} lastRequestAt={null} now={1000} runtimeLabels={{}} runtimeMetrics={{}} onOpen={noop} />
    );
    expect(container.querySelector(".cp-inst-recency")?.textContent).toContain("no active traffic");
  });

  it("expresses placement ONCE — no repeated node-name line under the chip", () => {
    cleanupRenders();
    const { container } = render(
      <DeploymentInstrument view={view()} role="PRIMARY" state="serving" history={[100, 120]} lastRequestAt={null}
        now={1000} runtimeLabels={{}} runtimeMetrics={{}} onOpen={noop} />
    );
    expect(container.querySelector(".cp-inst-nodes")).toBeNull();
    expect(container.querySelectorAll(".cp-inst-meta-label")[0]?.textContent).toBe("PLACEMENT");
  });

  it("says 'metrics require key' honestly for an auth-gated unreadable runtime", () => {
    cleanupRenders();
    const { container } = render(
      <DeploymentInstrument view={view({ telemetry: telem({ available: false, error: "HTTP 401", generationTps: null, modelId: null, slotsTotal: null }) })}
        role="PRIMARY" state="ready" history={[]} lastRequestAt={null} now={1000}
        runtimeLabels={{}} runtimeMetrics={{}} onOpen={noop} />
    );
    const recency = container.querySelector(".cp-inst-recency")?.textContent;
    expect(recency).toContain("metrics require key");
    expect(recency).not.toContain("no traffic yet");
  });

  it("says 'throughput unknown' for unreadable metrics without an auth error", () => {
    cleanupRenders();
    const { container } = render(
      <DeploymentInstrument view={view({ telemetry: telem({ available: false, error: "TimeoutError", generationTps: null }) })}
        role="PRIMARY" state="ready" history={[]} lastRequestAt={null} now={1000}
        runtimeLabels={{}} runtimeMetrics={{}} onOpen={noop} />
    );
    expect(container.querySelector(".cp-inst-recency")?.textContent).toContain("throughput unknown");
  });

  it("falls back to the raw runtime id when the registry has no label", () => {
    cleanupRenders();
    const { container } = render(
      <DeploymentInstrument view={view({ runtime: "vllm" })} role="WORKER" state="unknown" history={[]} lastRequestAt={null}
        now={1000} runtimeLabels={{}} runtimeMetrics={{}} onOpen={noop} />
    );
    expect(container.querySelector(".cp-inst-runtime")?.textContent).toBe("vllm");
  });

  it("renders a FULL non-primary role distinctly from the state pill", () => {
    cleanupRenders();
    const { container } = render(
      <DeploymentInstrument view={view()} role="SPECIALIST" state="busy" history={[100, 120]} lastRequestAt={null}
        now={1000} runtimeLabels={{}} runtimeMetrics={{}} onOpen={noop} />
    );
    expect(container.querySelector(".cp-inst-role")?.textContent).toBe("SPECIALIST");
    expect(container.querySelector(".cp-inst-state")?.textContent).toContain("BUSY");
    expect(container.querySelector(".cp-inst")?.classList.contains("is-primary")).toBe(false);
  });

  it("weights PRIMARY via geometry, not the role label alone", () => {
    cleanupRenders();
    const { container } = render(
      <DeploymentInstrument view={view()} role="PRIMARY" state="serving" history={[100, 120]} lastRequestAt={null}
        now={1000} runtimeLabels={{}} runtimeMetrics={{}} onOpen={noop} />
    );
    expect(container.querySelector(".cp-inst")?.classList.contains("is-primary")).toBe(true);
  });

  it("renders node-derived telemetry cells with '—' for genuinely absent values", () => {
    cleanupRenders();
    const node = {
      id: "n1", name: "Node 1", online: true, role: "head",
      metrics: { gpu: { temperature: 56, usage: 40, power: { draw: 56, limit: 0 }, vram: { used: 0, total: 0, percentage: 0, available: 0 } }, cpu: null, ram: null, storage: [], network: null, unifiedMemory: null, llm: [], comfy: null, tailscale: null },
    } as never;
    const { container } = render(
      <DeploymentInstrument view={view({ nodes: [node] })} role="PRIMARY" state="serving" history={[100, 120]} lastRequestAt={null}
        now={1000} runtimeLabels={{}} runtimeMetrics={{}} onOpen={noop} />
    );
    const labels = [...container.querySelectorAll(".cp-inst-cell-label")].map((e) => e.textContent);
    expect(labels).toContain("GPU TEMP");
    expect(labels).toContain("POWER");
    const power = [...container.querySelectorAll(".cp-inst-cell")].find((c) => c.textContent?.includes("POWER"));
    expect(power?.querySelector(".cp-inst-cell-value")?.textContent).toContain("56");
    expect(power?.querySelector(".cp-inst-cell-value")?.getAttribute("title")).toBeNull();
    expect(container.querySelector(".cp-inst-cell-value")?.textContent).not.toBe("0");
  });

  it("shows OFFLINE visibly without dimming the state away", () => {
    cleanupRenders();
    const { container } = render(
      <DeploymentInstrument view={view({ telemetry: telem({ generationTps: null }) })} role="PRIMARY" state="offline"
        history={[]} lastRequestAt={null} now={1000} runtimeLabels={{}} runtimeMetrics={{}} onOpen={noop} />
    );
    expect(container.querySelector(".cp-inst-state")?.textContent).toContain("OFFLINE");
    expect(container.querySelector(".cp-inst")?.classList.contains("is-offline")).toBe(true);
  });
});
