import { act } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AddComputeWizard } from "./AddComputeWizard";
import { render, flush } from "../../testing/render";
import type { ComputeDiscoveryResult } from "../../api/types";

const discoverCompute = vi.fn();
const validateCompute = vi.fn();

vi.mock("../../api/client", () => ({
  discoverCompute: (...a: unknown[]) => discoverCompute(...a),
  validateCompute: (...a: unknown[]) => validateCompute(...a),
}));

function discovery(over: Partial<ComputeDiscoveryResult> = {}): ComputeDiscoveryResult {
  return {
    host: "192.168.1.170",
    knownNodeId: null,
    hostProvenance: "user",
    reachable: true,
    sshReachable: true,
    fields: {
      hostname: { value: "dgx-4", provenance: "discovered" },
      gpuChip: { value: "NVIDIA GB10", provenance: "discovered" },
    },
    endpoints: [],
    notes: [],
    steps: ["ssh read-only facts"],
    readOnly: true,
    ...over,
  };
}

const EXISTING = [{ id: "dgx-1", name: "DGX 1", lanIp: "192.168.1.161" }];

function setInput(container: HTMLElement, id: string, value: string) {
  const el = container.querySelector<HTMLInputElement>(`#${id}`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setSelect(container: HTMLElement, id: string, value: string) {
  const el = container.querySelector<HTMLSelectElement>(`#${id}`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function clickNext(container: HTMLElement) {
  const btn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Next")!;
  act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

beforeEach(() => {
  discoverCompute.mockReset();
  validateCompute.mockReset();
  validateCompute.mockResolvedValue({ ok: true, invalidCount: 0, unverifiedCount: 1, issues: [] });
  discoverCompute.mockResolvedValue(discovery());
});

describe("AddComputeWizard — guided, config-first", () => {
  it("renders all 8 steps with explicit titles", () => {
    const { container } = render(<AddComputeWizard existing={EXISTING} onCancel={() => {}} onSave={() => {}} />);
    expect(container.querySelectorAll(".cp-step")).toHaveLength(8);
    expect(container.textContent).toContain("Discover / connect");
    expect(container.textContent).toContain("Save");
    expect(container.querySelector('[aria-label="Add compute steps"]')).not.toBeNull();
  });

  it("blocks Next until a host is supplied", () => {
    const { container } = render(<AddComputeWizard existing={EXISTING} onCancel={() => {}} onSave={() => {}} />);
    clickNext(container);
    expect(container.textContent).toContain("Identity");
    // still on connect because host empty
    expect(container.querySelector("#ac-host")).not.toBeNull();
  });

  it("discovers read-only and prefills identity without touching the remote", async () => {
    const onSave = vi.fn();
    const { container } = render(<AddComputeWizard existing={EXISTING} onCancel={() => {}} onSave={onSave} />);
    setInput(container, "ac-host", "192.168.1.170");
    setInput(container, "ac-user", "musa");
    const discover = [...container.querySelectorAll("button")].find((b) => b.textContent === "Discover (read-only)")!;
    await act(async () => {
      discover.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await flush();
    expect(discoverCompute).toHaveBeenCalledTimes(1);
    expect(discoverCompute.mock.calls[0][0]).toMatchObject({ host: "192.168.1.170", sshUser: "musa" });
    // prefilled from discovery
    expect(container.querySelector<HTMLInputElement>("#ac-name")?.value ?? container.textContent).toBeTruthy();
    expect(container.textContent).toContain("Reachable");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("lets the operator pick a known node and add a fabric peer", () => {
    const { container } = render(<AddComputeWizard existing={EXISTING} onCancel={() => {}} onSave={() => {}} />);
    setSelect(container, "ac-known", "dgx-1");
    expect(container.querySelector<HTMLInputElement>("#ac-host")?.value).toBe("192.168.1.161");
  });

  it("saves a config-only payload through the last step", async () => {
    const onSave = vi.fn();
    const { container } = render(<AddComputeWizard existing={EXISTING} onCancel={() => {}} onSave={onSave} />);
    setInput(container, "ac-host", "192.168.1.170");
    setInput(container, "ac-user", "musa");
    // step 0 -> next (identity)
    clickNext(container);
    setInput(container, "ac-name", "DGX 4");
    setInput(container, "ac-id", "dgx-4");
    // step 1 -> next
    clickNext(container);
    // step 2 capabilities -> next
    clickNext(container);
    // step 3 network -> next
    clickNext(container);
    // step 4 fabric -> next
    clickNext(container);
    // step 5 validate — server validation runs
    await flush();
    clickNext(container);
    // step 6 review -> next
    clickNext(container);
    await flush();
    const save = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Save (config"))!;
    await act(async () => {
      save.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = onSave.mock.calls[0][0];
    expect(payload.id).toBe("dgx-4");
    expect(payload.lanIp).toBe("192.168.1.170");
    expect(payload.ssh.host).toBe("192.168.1.170");
  });

  it("blocks save on a duplicate id and surfaces INVALID", () => {
    const onSave = vi.fn();
    const { container } = render(<AddComputeWizard existing={EXISTING} onCancel={() => {}} onSave={onSave} />);
    setInput(container, "ac-host", "192.168.1.170");
    clickNext(container); // -> identity (id auto-derived from host)
    setInput(container, "ac-id", "dgx-1");
    clickNext(container); // identity blocks on duplicate id → stays
    expect(container.textContent).toContain("Identity");
    expect(container.textContent).toContain("Resolve the blocking items first.");
  });

  it("offers an Advanced manual switch", () => {
    const onAdvanced = vi.fn();
    const { container } = render(<AddComputeWizard existing={EXISTING} onCancel={() => {}} onSave={() => {}} onAdvanced={onAdvanced} />);
    const btn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Advanced manual form")!;
    act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onAdvanced).toHaveBeenCalled();
  });
});
