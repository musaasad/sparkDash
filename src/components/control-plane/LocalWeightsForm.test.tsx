/**
 * LocalWeightsForm — discovery-first local weight scan. Honest states:
 * unconfigured, empty, missing dirs, matches. Read-only (raddir/stat) only.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { LocalWeightsForm } from "./LocalWeightsForm";
import { render, cleanupRenders, flush } from "../../testing/render";

vi.mock("../../api/client", () => ({
  scanLocalWeights: vi.fn(),
}));

const client = await import("../../api/client");
const scan = vi.mocked(client.scanLocalWeights);

const base = {
  configuredDirs: [],
  scannedDirs: [],
  missingDirs: [],
  matches: [],
  truncated: false,
  notes: [],
  steps: [],
  readOnly: true as const,
};

beforeEach(() => {
  cleanupRenders();
  vi.clearAllMocks();
});

describe("LocalWeightsForm", () => {
  it("shows an honest 'no weights directory configured' state — never a fake empty success", async () => {
    scan.mockResolvedValue({ ...base, configured: false });
    const { container } = render(<LocalWeightsForm onSeed={() => {}} onBack={() => {}} />);
    await flush();
    expect(container.querySelector("[data-lw-state='unconfigured']")).not.toBeNull();
    expect(container.textContent).toContain("No weights directory configured");
    expect(container.querySelector("[data-lw-state='scanned']")).toBeNull();
  });

  it("lists discovered weight files with provenance and lets the operator pick one", async () => {
    scan.mockResolvedValue({
      ...base,
      configured: true,
      scannedDirs: ["/models"],
      matches: [
        { path: "/models/model.gguf", name: "model.gguf", dir: "/models", sizeBytes: 2048, ext: "gguf", provenance: "configured" },
      ],
    });
    const seeded: unknown[] = [];
    const { container } = render(<LocalWeightsForm onSeed={(s) => seeded.push(s)} onBack={() => {}} />);
    await flush();

    const match = container.querySelector<HTMLButtonElement>("[data-lw-matches] button")!;
    expect(match.textContent).toContain("model.gguf");
    expect(match.textContent).toContain("Configured");
    act(() => match.click());

    const cont = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes("Continue to setup")
    )!;
    act(() => cont.click());
    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toMatchObject({ path: "/models/model.gguf", provenance: "configured" });
  });

  it("states plainly that configured dirs held no weight files", async () => {
    scan.mockResolvedValue({ ...base, configured: true, scannedDirs: ["/models"] });
    const { container } = render(<LocalWeightsForm onSeed={() => {}} onBack={() => {}} />);
    await flush();
    expect(container.querySelector("[data-lw-state='empty']")).not.toBeNull();
  });

  it("shows matches from an ad-hoc typed dir even when none is configured", async () => {
    scan.mockResolvedValue({
      ...base,
      configured: false,
      scannedDirs: ["/typed"],
      matches: [{ path: "/typed/a.gguf", name: "a.gguf", dir: "/typed", sizeBytes: 1, ext: "gguf", provenance: "user" }],
    });
    const { container } = render(<LocalWeightsForm onSeed={() => {}} onBack={() => {}} />);
    await flush();
    expect(container.querySelector("[data-lw-state='unconfigured']")).toBeNull();
    expect(container.querySelectorAll("[data-lw-matches] button")).toHaveLength(1);
    expect(container.textContent).toContain("User supplied");
  });

  it("reports missing directories as UNKNOWN, not fabricated matches", async () => {
    scan.mockResolvedValue({ ...base, configured: true, missingDirs: ["/gone"], notes: ["/gone not readable"] });
    const { container } = render(<LocalWeightsForm onSeed={() => {}} onBack={() => {}} />);
    await flush();
    expect(container.textContent).toContain("1 dir(s) missing");
    expect(container.querySelectorAll("[data-lw-matches] button")).toHaveLength(0);
  });

  it("does not promise family — says family stays UNKNOWN", async () => {
    scan.mockResolvedValue({
      ...base,
      configured: true,
      scannedDirs: ["/models"],
      matches: [{ path: "/models/a.safetensors", name: "a.safetensors", dir: "/models", sizeBytes: null, ext: "safetensors", provenance: "configured" }],
    });
    const { container } = render(<LocalWeightsForm onSeed={() => {}} onBack={() => {}} />);
    await flush();
    act(() => container.querySelector<HTMLButtonElement>("[data-lw-matches] button")!.click());
    expect(container.textContent).toContain("Family stays UNKNOWN");
  });
});
