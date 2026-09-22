import { describe, expect, it } from "vitest";
import { act } from "react";
import type { ActivityEvent } from "../../api/types";
import { ActivitySection } from "./ActivitySection";
import { render, cleanupRenders } from "../../testing/render";

function ev(over: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    seq: 1,
    ts: new Date().toISOString(),
    kind: "lifecycle",
    subject: "r1",
    summary: "recipe saved",
    attribution: null,
    meta: null,
    ...over,
  };
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const events: ActivityEvent[] = [
  ev({ seq: 1, summary: "deployment failed" }),
  ev({ seq: 2, summary: "deployment failed" }),
  ev({ seq: 3, kind: "node", summary: "node went offline" }),
  ev({ seq: 4, summary: "recipe saved" }),
];

describe("ActivitySection toolbar + facets", () => {
  it("renders live severity counts", () => {
    cleanupRenders();
    const { container } = render(<ActivitySection events={events} />);
    expect(container.querySelector(".cp-activity-facet.error")?.textContent).toContain("Errors 2");
    expect(container.querySelector(".cp-activity-facet.warning")?.textContent).toContain("Warnings 1");
    expect(container.querySelector(".cp-activity-facet.info")?.textContent).toContain("Info 1");
  });

  it("filters rows when a facet is toggled and dedupes repeats with xN", () => {
    cleanupRenders();
    const { container } = render(<ActivitySection events={events} />);
    // two identical failures collapse to one row carrying ×2
    expect(container.querySelector(".cp-activity-count")?.textContent).toBe("×2");
    const before = container.querySelectorAll(".cp-table tbody tr").length;

    act(() => container.querySelector<HTMLButtonElement>(".cp-activity-facet.error")!.click());
    const after = container.querySelectorAll(".cp-table tbody tr").length;
    expect(after).toBeLessThan(before);
    expect(after).toBe(1);
  });

  it("offers Clear filters in the empty filtered state", () => {
    cleanupRenders();
    const { container } = render(<ActivitySection events={events} />);
    const search = container.querySelector<HTMLInputElement>(".cp-toolbar-search input")!;
    act(() => setInput(search, "no-such-thing"));
    expect(container.querySelector(".cp-empty")?.textContent).toContain("No events match these filters");

    const clear = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Clear filters")!;
    act(() => clear.click());
    expect(container.querySelectorAll(".cp-table tbody tr").length).toBeGreaterThan(0);
  });

  it("exposes an explicit Following/Paused stream state", () => {
    cleanupRenders();
    const { container } = render(<ActivitySection events={events} />);
    expect(container.querySelector(".cp-activity-followstate")?.textContent).toContain("Following");
    const pause = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Pause")!;
    act(() => pause.click());
    expect(container.querySelector(".cp-activity-followstate")?.textContent).toContain("Paused");
  });

  it("expands a row to structured fields + a copyable raw line", () => {
    cleanupRenders();
    const { container } = render(<ActivitySection events={events} />);
    act(() => container.querySelector<HTMLButtonElement>(".cp-activity-sentence")!.click());
    expect(container.querySelector(".cp-activity-expand")).not.toBeNull();
    expect(container.querySelector(".cp-activity-raw")?.textContent).toContain("deployment failed");
  });

  it("auto-expands and highlights the deep-linked reqId event", () => {
    cleanupRenders();
    const withReq = [ev({ seq: 9, kind: "alert", summary: "probe failed", meta: { reqId: 4242 } }), ev({ seq: 10 })];
    const { container } = render(<ActivitySection events={withReq} reqId={4242} />);
    expect(container.querySelector(".cp-activity-expand")).not.toBeNull();
    expect(container.querySelector(".cp-activity-sentence.is-deep-link")).not.toBeNull();
  });

  it("deep-links an error row into the Live Console carrying the reqId", () => {
    cleanupRenders();
    const tapped: string[] = [];
    const withReq = [ev({ seq: 9, kind: "alert", summary: "probe failed", meta: { reqId: 4242, recipeId: "r1" } })];
    const { container } = render(<ActivitySection events={withReq} onOpenInConsole={(e) => tapped.push(String(e.meta?.reqId))} />);
    act(() => container.querySelector<HTMLButtonElement>(".cp-activity-sentence")!.click());
    const link = [...container.querySelectorAll<HTMLAnchorElement>("a")].find((a) => a.textContent?.includes("Live Console"))!;
    expect(link.textContent).toContain("r1");
    act(() => link.click());
    expect(tapped).toEqual(["4242"]);
  });
});
