import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { AppNav } from "./AppNav";
import type { Route } from "../../hooks/router";
import { render, cleanupRenders } from "../../testing/render";

function props(over: Partial<Parameters<typeof AppNav>[0]> = {}) {
  return {
    route: { section: "overview" } as Route,
    navigate: () => {},
    connected: true,
    stale: false,
    ...over,
  };
}

describe("AppNav", () => {
  it("renders the full rail: groups, pinned Settings and workspace card", () => {
    cleanupRenders();
    const { container } = render(<AppNav {...props()} workspaceName="Mia'a AI Lab" operatorId="mia-labs" />);

    const labels = Array.from(container.querySelectorAll(".cp-nav-item .cp-nav-label")).map(
      (n) => n.textContent
    );
    expect(labels).toEqual(["Overview", "Models", "Fleet", "Activity", "Benchmarks", "Settings"]);

    // Groups are hairline-separated with no group titles: 4 groups.
    expect(container.querySelectorAll(".cp-nav-group")).toHaveLength(4);
    // Settings lives in the pinned footer, outside the scroll area.
    expect(container.querySelector(".cp-rail-foot .cp-nav-item")?.textContent).toContain("Settings");
    expect(container.querySelector(".cp-rail-scroll .cp-nav-item")?.textContent).not.toContain("Settings");

    expect(container.querySelector(".cp-rail-ws-name")?.textContent).toBe("Mia'a AI Lab");
    expect(container.querySelector(".cp-rail-ws-op")?.textContent).toBe("mia-labs");
    expect(container.querySelector(".cp-rail-avatar")?.textContent).toBe("MI");
  });

  it("marks the active row with a full-width selected tint and page semantics", () => {
    cleanupRenders();
    const { container } = render(<AppNav {...props({ route: { section: "fleet" } as Route })} />);
    const active = container.querySelector(".cp-nav-item.is-active");
    expect(active?.textContent).toContain("Fleet");
    expect(active?.getAttribute("aria-current")).toBe("page");
  });

  it("renders counts as right-aligned muted numerals, not pills", () => {
    cleanupRenders();
    const { container } = render(
      <AppNav {...props()} counts={{ fleet: 12, models: 3, activity: 47 }} />
    );
    const counts = Array.from(container.querySelectorAll(".cp-nav-count")).map((n) => n.textContent);
    expect(counts).toEqual(["3", "12", "47"]);
    expect(container.querySelector(".cp-pill")).toBeNull();
  });

  it("navigates with the typed route union", () => {
    cleanupRenders();
    const navigate = vi.fn();
    const { container } = render(<AppNav {...props({ navigate })} />);
    const models = Array.from(container.querySelectorAll(".cp-nav-item")).find((n) =>
      n.textContent?.includes("Models")
    )!;
    act(() => (models as HTMLButtonElement).click());
    expect(navigate).toHaveBeenCalledWith({ section: "models" });
  });

  it("toggles the collapsed rail state", () => {
    cleanupRenders();
    const { container } = render(<AppNav {...props()} />);
    const toggle = container.querySelector(".cp-rail-collapse") as HTMLButtonElement;
    expect(container.querySelector(".cp-rail")?.className).not.toContain("is-collapsed");
    act(() => toggle.click());
    expect(container.querySelector(".cp-rail")?.className).toContain("is-collapsed");
  });
});
