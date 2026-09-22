/**
 * Validate report honesty: a thing that cannot be verified stays "?" — never a
 * false "✓". Invalid things are "✗". Lifecycle is always CONFIG ONLY / DRY RUN.
 */
import { describe, expect, it } from "vitest";
import { buildValidateReport, reportSymbol, type ValidateReportInput } from "./validateReport";

const base: ValidateReportInput = {
  modelName: "Model X",
  modelId: "model-x",
  weightPath: "/models/x",
  runtime: "vllm",
  runtimeVerifiable: true,
  nodeCount: 1,
  rangeMin: 1,
  rangeMax: 1,
  topologyStatus: "valid",
  topologyReason: "single node, runtime declares single-node support",
  secretEntries: 0,
  secretMissingNames: 0,
  role: null,
};

const line = (input: Partial<ValidateReportInput>, key: string) =>
  buildValidateReport({ ...base, ...input }).find((l) => l.key === key)!;

describe("buildValidateReport", () => {
  it("emits every required concept in order", () => {
    expect(buildValidateReport(base).map((l) => l.key)).toEqual([
      "MODEL",
      "RUNTIME",
      "COMPUTE",
      "TOPOLOGY",
      "WEIGHTS",
      "SECRETS",
      "ROLE",
      "LIFECYCLE",
    ]);
  });

  it("marks a missing weight path as ? (unknown), not ✓", () => {
    expect(line({ weightPath: "" }, "WEIGHTS").status).toBe("unknown");
    expect(reportSymbol(line({ weightPath: "" }, "WEIGHTS").status)).toBe("?");
  });

  it("marks an un-declared runtime capability as ? (NOT-VERIFIED), not ✓", () => {
    const l = line({ runtime: "custom", runtimeVerifiable: false }, "RUNTIME");
    expect(l.status).toBe("unknown");
    expect(l.detail).toMatch(/NOT-VERIFIED/);
  });

  it("marks defaults-USING role as ? — never auto-assigned", () => {
    const l = line({ role: null }, "ROLE");
    expect(l.status).toBe("unknown");
    expect(l.detail).toMatch(/not auto-assigned/);
  });

  it("maps topology status through honestly", () => {
    expect(line({ topologyStatus: "valid" }, "TOPOLOGY").status).toBe("valid");
    expect(line({ topologyStatus: "invalid", topologyReason: "needs 4 nodes" }, "TOPOLOGY").status).toBe("invalid");
    expect(line({ topologyStatus: "needs-confirmation", topologyReason: "unknown" }, "TOPOLOGY").status).toBe("unknown");
  });

  it("marks out-of-range compute as ✗", () => {
    expect(line({ nodeCount: 3, rangeMin: 1, rangeMax: 2 }, "COMPUTE").status).toBe("invalid");
  });

  it("keeps lifecycle always certain and config-only", () => {
    const l = line({}, "LIFECYCLE");
    expect(l.status).toBe("valid");
    expect(l.detail).toBe("CONFIG ONLY · DRY RUN");
  });

  it("secret entries without a NAME stay ? and never echo values", () => {
    const l = line({ secretEntries: 2, secretMissingNames: 1 }, "SECRETS");
    expect(l.status).toBe("unknown");
    expect(l.detail).toMatch(/without a NAME/);
  });
});
