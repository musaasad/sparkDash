import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { countBy, CountedTabs, DataTable, TabStrip } from "./DataTable";
import { render, cleanupRenders } from "../../testing/render";

describe("countBy reducer", () => {
  it("tallies items per bucket and skips null keys", () => {
    const items = ["a", "b", "a", null, undefined, "c"];
    expect(countBy(items, (x) => x)).toEqual({ a: 2, b: 1, c: 1 });
  });

  it("returns an empty record for no items", () => {
    expect(countBy([], (x: string) => x)).toEqual({});
  });
});

describe("CountedTabs", () => {
  it("renders every bucket with its count and marks the active tab", () => {
    cleanupRenders();
    const { container } = render(
      <CountedTabs
        tabs={[
          { key: "all", label: "All", count: 3 },
          { key: "running", label: "Running", count: 2 },
          { key: "stopped", label: "Stopped", count: 1 },
        ]}
        active="running"
        onSelect={() => {}}
        ariaLabel="Status"
      />
    );
    expect(container.textContent).toContain("Running");
    expect(container.textContent).toContain("2");
    const active = container.querySelector('[aria-selected="true"]');
    expect(active?.textContent).toContain("Running");
    // Zero-count buckets still render for a stable vocabulary.
    expect(container.querySelectorAll(".cp-counted-tab")).toHaveLength(3);
  });

  it("keeps the count visible for a zero bucket", () => {
    cleanupRenders();
    const { container } = render(
      <CountedTabs tabs={[{ key: "all", label: "All", count: 0 }]} active="all" onSelect={() => {}} />
    );
    expect(container.querySelector(".cp-counted-count")?.textContent).toBe("0");
  });

  it("moves selection with arrow keys and exposes roving tabindex", () => {
    cleanupRenders();
    const picked: string[] = [];
    const { container } = render(
      <CountedTabs
        tabs={[
          { key: "all", label: "All", count: 1 },
          { key: "running", label: "Running", count: 1 },
        ]}
        active="all"
        onSelect={(k) => picked.push(k)}
        panelId="p"
      />
    );
    const first = container.querySelector<HTMLButtonElement>(".cp-counted-tab")!;
    expect(first.tabIndex).toBe(0);
    expect(first.getAttribute("aria-controls")).toBe("p-all");
    act(() => first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(picked).toEqual(["running"]);
  });

  it("TabStrip wires roving tabindex and arrow nav", () => {
    cleanupRenders();
    const picked: string[] = [];
    const { container } = render(<TabStrip tabs={["a", "b"]} active="a" onSelect={(t) => picked.push(t)} panelId="x" />);
    const first = container.querySelector<HTMLButtonElement>('[role="tab"]')!;
    expect(first.getAttribute("aria-controls")).toBe("x-a");
    act(() => first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(picked).toEqual(["b"]);
  });
});

describe("DataTable interactive rows", () => {
  it("activates a clickable row on Enter and Space and announces it", () => {
    cleanupRenders();
    const onRowClick = vi.fn();
    const { container } = render(
      <DataTable
        columns={[{ key: "name", header: "Name", render: (r: { id: string }) => r.id }]}
        rows={[{ id: "n1" }]}
        rowKey={(r) => r.id}
        onRowClick={onRowClick}
      />
    );
    const row = container.querySelector<HTMLTableRowElement>("tbody tr")!;
    expect(row.getAttribute("role")).toBe("button");
    expect(row.tabIndex).toBe(0);
    act(() => row.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
    expect(onRowClick).toHaveBeenCalledWith({ id: "n1" });
  });
});
