import { describe, expect, it } from "vitest";
import { StatusPill, StatusDot, statusLabel, statusSuffix } from "./Status";
import { render } from "../../testing/render";

/**
 * Fixed display vocabulary (DESIGN_BRIEF global rule 10): dot + word, never
 * color alone. "Running external" is running-green + a muted suffix chip and
 * ONLY "Expected · not detected" takes the warning tone.
 */
describe("StatusPill display vocabulary", () => {
  it("labels every display state with the fixed words", () => {
    expect(statusLabel("running")).toBe("Running");
    expect(statusLabel("running-external")).toBe("Running");
    expect(statusLabel("expected-not-detected")).toBe("Expected · not detected");
    expect(statusLabel("degraded")).toBe("Degraded");
    expect(statusLabel("stopped")).toBe("Stopped");
  });

  it("renders Running external as a green pill with a muted external suffix", () => {
    const { container } = render(<StatusPill status="running-external" />);
    const pill = container.querySelector(".cp-pill");
    expect(pill?.className).toContain("running-external");
    expect(pill?.textContent).toBe("Runningexternal");
    expect(container.querySelector(".cp-pill-suffix")?.textContent).toBe("external");
    expect(statusSuffix("running-external")).toBe("external");
    expect(statusSuffix("running")).toBeNull();
  });

  it("gives Expected · not detected the warning class and hollow warning dot", () => {
    const { container } = render(<StatusPill status="expected-not-detected" />);
    expect(container.querySelector(".cp-pill")?.className).toContain("expected-not-detected");
    expect(container.querySelector(".cp-dot")?.className).toContain("expected-not-detected");
    expect(container.textContent).toContain("Expected");
  });

  it("Degraded takes the real-failure class, not warning", () => {
    const { container } = render(<StatusDot status="degraded" />);
    expect(container.querySelector(".cp-dot")?.className).toContain("degraded");
    expect(container.querySelector(".cp-dot")?.className).not.toContain("warn");
  });

  it("keeps lifecycle slugs working (transitional pulse classes)", () => {
    const { container } = render(<StatusPill status="starting" />);
    expect(container.querySelector(".cp-pill")?.className).toContain("starting");
    expect(container.textContent).toContain("Starting");
  });
});
