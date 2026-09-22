import { describe, expect, it } from "vitest";
import { gaugeFraction, gaugeTrend, niceCeil, ThroughputGauge } from "./ThroughputGauge";
import { render, cleanupRenders } from "../../testing/render";

describe("gauge arc scaling", () => {
  it("scales to the recent observed ceiling, NOT /100", () => {
    // 450 tok/s with a 500 peak => ~0.9, not 4.5.
    const s = gaugeFraction(450, [400, 500, 460]);
    expect(s).not.toBeNull();
    expect(s!.fraction).toBeGreaterThan(0.85);
    expect(s!.fraction).toBeLessThan(1);
    expect(s!.ceiling).toBe(500);
  });

  it("has no range and no fraction with fewer than 2 samples (no fake range)", () => {
    expect(gaugeFraction(120, [])).toBeNull();
    expect(gaugeFraction(120, [120])).toBeNull();
  });

  it("clamps the fraction into 0..1", () => {
    const s = gaugeFraction(2000, [10, 20]);
    expect(s!.ceiling).toBe(2000);
    expect(s!.fraction).toBe(1);
    expect(gaugeFraction(null, [10, 20])!.fraction).toBe(0);
  });

  it("rounds ceilings to a nice step", () => {
    expect(niceCeil(430)).toBe(500);
    expect(niceCeil(12)).toBe(20);
    expect(niceCeil(0)).toBe(1);
  });

  it("reads a trend from the last two samples only", () => {
    expect(gaugeTrend([1, 2, 3])).toBe(1);
    expect(gaugeTrend([3, 2, 1])).toBe(-1);
    expect(gaugeTrend([5, 5])).toBe(0);
    expect(gaugeTrend([9])).toBe(0);
  });

  it("is neutral (no range labels) with a single sample", () => {
    cleanupRenders();
    const { container } = render(<ThroughputGauge value={120} history={[120]} state="serving" />);
    expect(container.querySelector(".cp-gauge")?.classList.contains("is-neutral")).toBe(true);
    expect(container.querySelector(".cp-gauge-range")).toBeNull();
    expect(container.querySelectorAll(".cp-gauge-tick")).toHaveLength(0);
  });
});

describe("gauge idle honesty", () => {
  it("shows the state word instead of an alarming 0 TOK/S", () => {
    cleanupRenders();
    const { container } = render(<ThroughputGauge value={null} history={[]} state="idle" />);
    expect(container.querySelector(".cp-gauge-center")?.textContent).toContain("IDLE");
    expect(container.querySelector(".cp-gauge-unit")).toBeNull();
  });

  it("renders a calm treatment with no fat fill blob when idle", () => {
    cleanupRenders();
    const { container } = render(<ThroughputGauge value={null} history={[10, 10]} state="ready" />);
    expect(container.querySelector(".cp-gauge")?.classList.contains("is-calm")).toBe(true);
    // calm: no value arc that could read as a grey smudge
    expect(container.querySelector(".cp-gauge-fill")).toBeNull();
    expect(container.querySelector(".cp-gauge-track")).not.toBeNull();
    expect(container.querySelector(".cp-gauge-center")?.textContent).toContain("READY");
  });

  it("treats unknown as calm too", () => {
    cleanupRenders();
    const { container } = render(<ThroughputGauge value={null} history={[]} state="unknown" />);
    expect(container.querySelector(".cp-gauge")?.classList.contains("is-calm")).toBe(true);
    expect(container.querySelector(".cp-gauge-fill")).toBeNull();
    expect(container.querySelector(".cp-gauge-center")?.textContent).toContain("UNKNOWN");
  });

  it("shows the number + unit while serving", () => {
    cleanupRenders();
    const { container } = render(<ThroughputGauge value={412} history={[380, 412]} state="serving" />);
    expect(container.querySelector(".cp-gauge-value")?.textContent).toBe("412");
    expect(container.querySelector(".cp-gauge-unit")?.textContent).toBe("TOK/S");
    expect(container.querySelector(".cp-gauge")?.classList.contains("is-active")).toBe(true);
    expect(container.querySelector(".cp-gauge")?.classList.contains("is-calm")).toBe(false);
    expect(container.querySelector(".cp-gauge-fill")).not.toBeNull();
  });

  it("keeps idle calm — no activity pulse", () => {
    cleanupRenders();
    const { container } = render(<ThroughputGauge value={null} history={[10, 10]} state="idle" />);
    expect(container.querySelector(".cp-gauge")?.classList.contains("is-active")).toBe(false);
  });
});
