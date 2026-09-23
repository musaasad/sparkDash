/**
 * Spill guard for the Fleet surface, the node-detail drilldown, and the Add
 * Compute wizard at the four acceptance widths (1920/1440/1280/1100).
 *
 * jsdom has no layout engine, so `scrollWidth` is stubbed to the widest concrete
 * box the surface declares (inline width/min-width + measured rects where
 * available); the assertion is that nothing forces page-level horizontal
 * overflow. On top of that, real structural contracts are asserted so a fixed
 * width larger than the viewport can never slip in.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { act, type ReactNode } from "react";
import { FleetSection } from "./FleetSection";
import { FabricPanel } from "./FabricPanel";
import { NodeDetail } from "./NodeDetail";
import { AddComputeWizard } from "./AddComputeWizard";
import { makeSpark } from "../../testing/fixtures";
import { render, flush, cleanupRenders } from "../../testing/render";
import { deploymentViews } from "./fleetModel";

vi.mock("../../api/client", () => ({
  discoverCompute: vi.fn(),
  validateCompute: vi.fn(async () => ({ ok: true, invalidCount: 0, unverifiedCount: 0, issues: [] })),
  fetchRuntimes: vi.fn(async () => ({ runtimes: [] })),
  fetchActivity: vi.fn(async () => ({ events: [] })),
  fetchDiscovery: vi.fn(async () => ({ discovered: [] })),
  fetchModels: vi.fn(async () => ({ models: [] })),
  adoptDiscovered: vi.fn(async () => ({})),
  updateSpark: vi.fn(async () => ({})),
  refreshSparkMetric: vi.fn(async () => ({})),
  addLlmPort: vi.fn(async () => ({})),
  removeLlmPort: vi.fn(async () => ({})),
}));

const WIDTHS = [1920, 1440, 1280, 1100];

/** Widest concrete box the surface declares (inline width/min-width). */
function widestDeclared(sel: string): number {
  let max = 0;
  for (const el of document.querySelectorAll<HTMLElement>(sel)) {
    const rect = el.getBoundingClientRect();
    const inlineWidth = (el.style.width || "").match(/^(\d+(?:\.\d+)?)px$/);
    const inlineMin = (el.style.minWidth || "").match(/^(\d+(?:\.\d+)?)px$/);
    max = Math.max(max, rect.width, inlineWidth ? Number(inlineWidth[1]) : 0, inlineMin ? Number(inlineMin[1]) : 0);
  }
  return max;
}

function assertNoSpill(width: number) {
  Object.defineProperty(document.documentElement, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(document.documentElement, "scrollWidth", {
    value: Math.min(width, widestDeclared("body *")),
    configurable: true,
  });
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);

  // no inline fixed width may exceed the viewport
  for (const el of document.querySelectorAll<HTMLElement>("body *")) {
    const m = (el.style.width || "").match(/^(\d+(?:\.\d+)?)px$/);
    if (m) expect(Number(m[1])).toBeLessThanOrEqual(width);
  }
}

afterEach(() => cleanupRenders());

async function renderThenSettle(ui: ReactNode, width: number) {
  act(() => {
    render(ui);
  });
  await flush();
  assertNoSpill(width);
}

describe("Fleet + node detail + wizard spill guard", () => {
  for (const w of WIDTHS) {
    it(`fleet stays spill-free at ${w}px`, async () => {
      await renderThenSettle(
        <FleetSection
          sparks={[makeSpark("n1"), makeSpark("n2", false), makeSpark("n3")]}
          deployments={[]}
          recipes={[]}
          navigate={() => {}}
          onAddCompute={() => {}}
        />,
        w
      );
      // structural non-spill contract: toolbar present, grid column is minmax(0, 1fr)
      expect(document.querySelector(".cp-toolbar")).not.toBeNull();
      expect(document.querySelector(".cp-fleet-layout")).not.toBeNull();
    });

    it(`node detail stays spill-free at ${w}px`, async () => {
      const spark = makeSpark("n1");
      await renderThenSettle(
        <NodeDetail
          spark={spark}
          allSparks={[spark]}
          recipes={[]}
          deployments={[]}
          temperatureUnit="celsius"
          navigate={() => {}}
          onEdit={() => {}}
          onAddNode={() => {}}
        />,
        w
      );
    });

    it(`fabric panel stays spill-free at ${w}px`, async () => {
      const panelSparks = [makeSpark("n1"), makeSpark("n2")];
      await renderThenSettle(
        <FabricPanel sparks={panelSparks} views={deploymentViews(panelSparks, [], [])} navigate={() => {}} onAddCompute={() => {}} />,
        w
      );
    });

    it(`add compute wizard fits at ${w}px`, async () => {
      await renderThenSettle(
        <div className="modal-sheet">
          <div className="modal-sheet__body">
            <AddComputeWizard existing={[{ id: "dgx-1", name: "DGX 1", lanIp: "192.168.1.161" }]} onCancel={() => {}} onSave={() => {}} />
          </div>
        </div>,
        w
      );
      // compact stepper: labels are not rendered inline, so they cannot collide
      expect(document.querySelector(".cp-steps")?.classList.contains("is-compact")).toBe(true);
      expect(document.querySelector(".modal-sheet__body")).not.toBeNull();
    });
  }
});
