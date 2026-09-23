import { describe, it, expect } from "vitest";
import {
  applyDiscovery,
  deriveId,
  draftToConfig,
  emptyDraft,
  markManual,
  mergeValidation,
  parsePorts,
  slugify,
  uniqueSlug,
  validateLocal,
} from "./computeDiscoveryModel";
import type { ComputeDiscoveryResult } from "../../api/types";

function discovery(over: Partial<ComputeDiscoveryResult> = {}): ComputeDiscoveryResult {
  return {
    host: "192.168.1.170",
    knownNodeId: null,
    hostProvenance: "user",
    reachable: true,
    sshReachable: true,
    fields: {},
    endpoints: [],
    notes: [],
    steps: [],
    readOnly: true,
    ...over,
  };
}

describe("slugify / uniqueness", () => {
  it("derives a safe slug and never collides", () => {
    expect(slugify("DGX 4 — Rack A")).toBe("dgx-4-rack-a");
    expect(slugify("!!!")).toBe("");
    expect(uniqueSlug("dgx-4", [])).toBe("dgx-4");
    expect(uniqueSlug("dgx-4", ["dgx-4"])).toBe("dgx-4-2");
    expect(deriveId("DGX 4", "192.168.1.170", ["dgx-4"])).toBe("dgx-4-2");
    expect(deriveId("", "", [])).toBe("compute");
  });
});

describe("applyDiscovery prefills ONLY observed values", () => {
  it("leaves unobserved fields null/absent and never fabricates", () => {
    const draft = applyDiscovery(emptyDraft(), discovery({ fields: {} }));
    expect(draft.hostname).toBeNull();
    expect(draft.gpuChip).toBeNull();
    expect(draft.lanIp).toBe("192.168.1.170");
    expect(draft.provenance.lanIp).toBe("manual");
  });

  it("carries provenance for observed and configured fields", () => {
    const draft = applyDiscovery(
      emptyDraft(),
      discovery({
        knownNodeId: "dgx-4",
        hostProvenance: "configured",
        fields: {
          hostname: { value: "dgx-4", provenance: "configured" },
          gpuChip: { value: "NVIDIA GB10", provenance: "discovered" },
          gpuMemoryGB: { value: 118, provenance: "discovered" },
          nodeKind: { value: "spark", provenance: "configured" },
        },
      })
    );
    expect(draft.name).toBe("dgx-4");
    expect(draft.hostname).toBe("dgx-4");
    expect(draft.provenance.gpuChip).toBe("discovered");
    expect(draft.provenance.hostname).toBe("configured");
    expect(draft.gpuMemoryGB).toBe(118);
  });

  it("adopts a reachable endpoint port as discovered", () => {
    const draft = applyDiscovery(
      emptyDraft(),
      discovery({ endpoints: [{ port: 9999, url: "u", reachable: true, status: 200, servedModelIds: [], provenance: "discovered" }] })
    );
    expect(draft.llmPorts).toContain(9999);
    expect(draft.provenance.llmPorts).toBe("discovered");
  });
});

describe("markManual + validateLocal", () => {
  it("marks operator-typed fields MANUAL", () => {
    const d = markManual(emptyDraft(), "gpuChip");
    expect(d.provenance.gpuChip).toBe("manual");
  });

  it("splits INVALID (blocking) from NOT-VERIFIED (advisory)", () => {
    const existing = [{ id: "dgx-1", lanIp: "192.168.1.161", ssh: { host: "192.168.1.161" } }];
    const d = { ...emptyDraft(), name: "DGX 4", id: "dgx-1", lanIp: "192.168.1.161" };
    const { blocking, advisory } = validateLocal(d, existing);
    expect(blocking.map((i) => i.code)).toContain("id-duplicate");
    expect(blocking.map((i) => i.code)).toContain("host-duplicate");
    expect(advisory.length).toBeGreaterThan(0);
    expect(advisory.every((i) => i.severity === "unverified")).toBe(true);
  });

  it("passes a clean remote draft with only advisories", () => {
    const d = { ...emptyDraft(), name: "DGX 4", id: "dgx-4", lanIp: "192.168.1.170", sshUser: "musa", gpuChip: "GB10" };
    const { blocking, advisory } = validateLocal(d, []);
    expect(blocking).toHaveLength(0);
    expect(advisory).toHaveLength(0);
  });

  it("F11: password auth without a password (or cred ref) is INVALID", () => {
    const base = { ...emptyDraft(), name: "DGX 4", id: "dgx-4", lanIp: "192.168.1.170", sshUser: "musa", gpuChip: "GB10" };
    const noPass = validateLocal({ ...base, sshAuth: "pass" }, []);
    expect(noPass.blocking.map((i) => i.code)).toContain("ssh-password-missing");
    const withPass = validateLocal({ ...base, sshAuth: "pass", sshPassword: "s3cret" }, []);
    expect(withPass.blocking).toHaveLength(0);
    const withRef = validateLocal({ ...base, sshAuth: "pass", credRef: "spark:dgx-4" }, []);
    expect(withRef.blocking).toHaveLength(0);
  });
});

describe("mergeValidation", () => {
  it("server INVALID wins and unverified is merged advisories", () => {
    const local = { blocking: [], advisory: [] };
    const merged = mergeValidation(local, {
      ok: false,
      invalidCount: 1,
      unverifiedCount: 1,
      issues: [
        { code: "id-duplicate", field: "id", severity: "invalid", message: "dup" },
        { code: "endpoint-unreachable", field: "llmPorts", severity: "unverified", message: "down" },
      ],
    });
    expect(merged.blocking.map((i) => i.code)).toContain("id-duplicate");
    expect(merged.advisory.map((i) => i.code)).toContain("endpoint-unreachable");
    expect(merged.serverUnverified).toBe(1);
  });
});

describe("draftToConfig", () => {
  it("produces a config-only payload with no provenance map leaking", () => {
    const d = { ...emptyDraft(), name: " DGX 4 ", id: "dgx-4", lanIp: "192.168.1.170", sshUser: "musa", fabricLinks: [{ to: "dgx-1", medium: "cx7" as const }] };
    const c = draftToConfig(d);
    expect(c.id).toBe("dgx-4");
    expect(c.name).toBe("DGX 4");
    expect(c.ssh.host).toBe("192.168.1.170");
    expect(c.fabricLinks).toHaveLength(1);
    expect("provenance" in c).toBe(false);
  });

  it("F11: carries password auth + value for a pass draft (value only when pass)", () => {
    const d = { ...emptyDraft(), name: "DGX 4", id: "dgx-4", lanIp: "192.168.1.170", sshUser: "musa", sshAuth: "pass" as const, sshPassword: "s3cret" };
    const c = draftToConfig(d);
    expect(c.ssh.auth).toBe("pass");
    expect(c.ssh.password).toBe("s3cret");
    const keyOnly = draftToConfig({ ...d, sshAuth: "key" as const });
    expect(keyOnly.ssh.auth).toBe("key");
    expect(keyOnly.ssh.password).toBe("s3cret");
  });
});

describe("parsePorts", () => {
  it("dedupes, drops junk, falls back", () => {
    expect(parsePorts("8888, 8888, 9000, abc, 70000")).toEqual([8888, 9000]);
    expect(parsePorts("")).toEqual([8888]);
  });
});
