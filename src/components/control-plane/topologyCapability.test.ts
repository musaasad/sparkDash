/**
 * Capability-aware topology evaluation. Invariants:
 *  - fleet size NEVER produces a degree
 *  - UNKNOWN != FAILED and UNKNOWN != VALID
 *  - a runtime that DECLARES no support rejects (invalid)
 * Capabilities come from provider DATA (descriptors), never a model name.
 */
import { describe, expect, it } from "vitest";
import { emptyRecipeDraft, type RecipeDraft } from "./RecipeEditor";
import { evaluateTopology, strategyTier, configuredDegrees, TOPOLOGY_STRATEGIES } from "./topologyCapability";

/** vLLM-shaped descriptor: single supported, TP bound by node count, others silent. */
const VLLM = { single: "supported", tp: "by-node-count" } as const;
/** TabbyAPI-shaped: single only, every parallelism mode explicitly unsupported. */
const TABBY = { single: "supported", tp: "unsupported", pp: "unsupported", dp: "unsupported", ep: "unsupported" } as const;

const draft = (over: Partial<RecipeDraft> = {}): RecipeDraft => ({ ...emptyRecipeDraft("m1"), ...over });

describe("topologyCapability.evaluateTopology", () => {
  it("TP2 on 2 nodes with a tp-declaring runtime is VALID", () => {
    const out = evaluateTopology({ draft: draft({ topoMode: "tp", tp: "2" }), descriptor: VLLM, nodeCount: 2 });
    expect(out.status).toBe("valid");
  });

  it("TP4 on 2 nodes is INVALID with a degree-vs-nodes reason", () => {
    const out = evaluateTopology({ draft: draft({ topoMode: "tp", tp: "4" }), descriptor: VLLM, nodeCount: 2 });
    expect(out.status).toBe("invalid");
    expect(out.reason).toMatch(/at least 4 node/);
  });

  it("TP3 on 3 nodes with an UNKNOWN runtime is NEEDS-CONFIRMATION, never valid", () => {
    const out = evaluateTopology({ draft: draft({ topoMode: "tp", tp: "3" }), descriptor: {}, nodeCount: 3 });
    expect(out.status).toBe("needs-confirmation");
    expect(out.status).not.toBe("valid");
  });

  it("tabbyapi TP is INVALID (runtime explicitly does NOT support TP)", () => {
    const out = evaluateTopology({ draft: draft({ topoMode: "tp", tp: "2" }), descriptor: TABBY, nodeCount: 2 });
    expect(out.status).toBe("invalid");
    expect(out.reason).toMatch(/does not support TP/);
  });

  it("3 nodes with no configured degree is unknown — never inferred parallelism", () => {
    const out = evaluateTopology({ draft: draft(), descriptor: VLLM, nodeCount: 3 });
    expect(out.status).toBe("needs-confirmation");
    expect(out.reason).toMatch(/do not imply/);
    expect(configuredDegrees(draft()).length).toBe(0);
  });

  it("product of degrees over node count is invalid", () => {
    const out = evaluateTopology({ draft: draft({ topoMode: "tp", tp: "2", pp: "2" }), descriptor: VLLM, nodeCount: 3 });
    expect(out.status).toBe("invalid");
    expect(out.reason).toMatch(/product/);
  });

  it("no node count is needs-confirmation (unknown != failed)", () => {
    const out = evaluateTopology({ draft: draft({ topoMode: "tp", tp: "2" }), descriptor: VLLM, nodeCount: 0 });
    expect(out.status).toBe("needs-confirmation");
  });

  it("strategyTier: absent declaration is needs-confirmation, declared unsupported is unsupported", () => {
    expect(strategyTier({}, "tp", 2, 2)).toBe("needs-confirmation");
    expect(strategyTier(TABBY, "tp", 2, 2)).toBe("unsupported");
    expect(strategyTier(VLLM, "tp", 2, 2)).toBe("supported");
    expect(strategyTier(VLLM, "tp", 4, 2)).toBe("unsupported");
  });

  it("exposes all five explicit strategies as data", () => {
    expect(TOPOLOGY_STRATEGIES.map((s) => s.id)).toEqual(["single", "tp", "pp", "dp", "ep"]);
  });
});
