import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import type { Settings } from "../../api/types";
import { flush, render, cleanupRenders } from "../../testing/render";

const base: Settings = {
  pollIntervalMs: 2000,
  defaultLlmPort: 8889,
  autoHideOffline: false,
  hideWorkers: false,
  temperatureUnit: "celsius",
  benchDebugTraces: false,
  density: "compact",
  showFleetEnergy: false,
  showFleetExceptions: false,
  showOverviewSearch: false,
  benchShareImage: true,
};

const updateSettings = vi.fn(async (patch: Partial<Settings>) => ({ ...base, ...patch }));

vi.mock("../../api/client", () => ({
  fetchSettings: vi.fn(async () => base),
  updateSettings: (patch: Partial<Settings>) => updateSettings(patch),
  fetchDeployments: vi.fn(async () => ({ deployments: [], dryRun: true })),
}));

const { SettingsSection } = await import("./SettingsSection");

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function railButton(container: HTMLElement, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>(".cp-settings-rail button")].find((b) => b.textContent?.includes(label))!;
}

function saveButton(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLButtonElement>(".cp-panel-title button")].find((b) => b.textContent === "Save")!;
}

async function mount() {
  cleanupRenders();
  const utils = render(<SettingsSection sparks={[]} navigate={() => {}} onSparksChanged={() => {}} />);
  await flush();
  return utils;
}

describe("SettingsSection section-scoped save", () => {
  beforeEach(() => updateSettings.mockClear());

  it("keeps Save disabled until the section is dirty, then saves + toasts", async () => {
    const { container } = await mount();
    expect(saveButton(container).disabled).toBe(true);

    const toggle = container.querySelector<HTMLButtonElement>(".cp-toggle")!;
    act(() => toggle.click());
    expect(saveButton(container).disabled).toBe(false);

    await act(async () => {
      saveButton(container).click();
      await Promise.resolve();
    });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".cp-toast")?.textContent).toContain("General saved");
  });

  it("blocks save on inline validation errors", async () => {
    const { container } = await mount();
    act(() => railButton(container, "Access").click());

    const poll = container.querySelector<HTMLInputElement>("#set-poll")!;
    act(() => setInput(poll, "100"));
    expect(container.querySelector(".cp-field-error")?.textContent).toContain("500");
    expect(saveButton(container).disabled).toBe(true);

    act(() => setInput(poll, "3000"));
    expect(saveButton(container).disabled).toBe(false);
  });

  it("renders one theme control (radio cards) and no duplicate legacy switch", async () => {
    const { container } = await mount();
    expect(container.querySelectorAll('[role="radiogroup"][aria-label="Theme"] .cp-radio-card')).toHaveLength(4);
    expect(container.querySelector(".icon-circle")).toBeNull();
  });

  it("guards a section switch behind a Save/Discard/Cancel modal when dirty", async () => {
    const { container } = await mount();
    act(() => container.querySelector<HTMLButtonElement>(".cp-toggle")!.click());
    act(() => railButton(container, "Access").click());

    const modal = document.querySelector(".cp-modal");
    expect(modal?.textContent).toContain("Unsaved changes");
    const discard = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Discard")!;
    act(() => discard.click());

    // Discarded edits drop, and the switch proceeds to Access.
    expect(document.querySelector(".cp-modal")).toBeNull();
    expect(container.querySelector("#set-poll")).not.toBeNull();
  });
});

describe("SettingsSection danger zone", () => {
  it("gates the destructive button behind type-the-resource-name", async () => {
    const { container } = await mount();
    act(() => railButton(container, "Danger Zone").click());

    const btn = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Clear activity")!;
    expect(btn.disabled).toBe(true);

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Type activity to confirm"]')!;
    act(() => setInput(input, "activity"));
    expect(btn.disabled).toBe(false);

    act(() => btn.click());
    expect(container.querySelector(".cp-toast")?.textContent).toContain("Activity history cleared");
  });

  it("renders warning icon and danger rail entry", async () => {
    const { container } = await mount();
    const danger = railButton(container, "Danger Zone");
    expect(danger.classList.contains("danger")).toBe(true);
    expect(danger.querySelector(".cp-danger-icon")).not.toBeNull();
  });

  it("performs a real local clear (cursor reset) rather than a no-op toast", async () => {
    cleanupRenders();
    const cleared: number[] = [];
    const { container } = render(
      <SettingsSection sparks={[]} navigate={() => {}} onSparksChanged={() => {}} activityLatestSeq={57} onClearActivity={(s) => cleared.push(s)} />
    );
    await flush();
    act(() => railButton(container, "Danger Zone").click());

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Type activity to confirm"]')!;
    act(() => setInput(input, "activity"));
    const btn = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Clear activity")!;
    act(() => btn.click());
    expect(cleared).toEqual([57]);
    expect([...container.querySelectorAll(".cp-field-hint")].some((p) => p.textContent?.includes("nothing is deleted server-side"))).toBe(true);
  });
});
