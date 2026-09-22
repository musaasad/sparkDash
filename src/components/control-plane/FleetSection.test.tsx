import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { FleetSection } from "./FleetSection";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";

const navigate = vi.fn();

function renderFleet(count: number, onAddCompute = vi.fn()) {
  const sparks = [...Array(count).keys()].map((i) => makeSpark(`n${i}`));
  return { ...render(<FleetSection sparks={sparks} deployments={[]} recipes={[]} navigate={navigate} onAddCompute={onAddCompute} />), onAddCompute, sparks };
}

describe("FleetSection scalability + add-compute entry", () => {
  it("renders an explicit '+ Add compute' action", () => {
    const { container, onAddCompute } = renderFleet(2);
    const btn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add compute"))!;
    expect(btn).toBeTruthy();
    act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onAddCompute).toHaveBeenCalled();
  });

  it("stays data-driven for a large fleet (no three-card assumption)", () => {
    const { container } = renderFleet(9);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(9);
  });

  it("switches to a compact representation automatically at larger N", () => {
    const small = renderFleet(3).container;
    const large = renderFleet(9).container;
    expect(small.querySelector(".cp-fleet-compact-note")).toBeNull();
    expect(large.querySelector(".cp-fleet-compact-note")).not.toBeNull();
    // topology block (a giant-card style block) is dropped once compact
    expect(small.textContent).toContain("Topology");
    expect(large.textContent).not.toContain("Topology");
  });

  it("keeps the empty state reachable when no nodes exist", () => {
    const onAddCompute = vi.fn();
    const { container } = render(
      <FleetSection sparks={[]} deployments={[]} recipes={[]} navigate={navigate} onAddCompute={onAddCompute} />
    );
    const btn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add compute"))!;
    expect(btn).toBeTruthy();
  });
});
