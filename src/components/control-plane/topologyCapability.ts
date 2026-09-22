/**
 * Client-side capability-aware TOPOLOGY evaluation — mirrors the server domain
 * (server/domain/topologyValidate.js) but reads the runtime's DECLARED
 * capabilities from provider DATA (`GET /api/runtimes` → `topology`), so the
 * wizard never hard-codes a runtime/model name.
 *
 * Invariants:
 *  - FLEET SIZE != PARALLELISM DEGREE: nodes with no configured degree do NOT
 *    become TP<N> — that is NEEDS-CONFIRMATION.
 *  - UNKNOWN != FAILED and UNKNOWN != VALID: a runtime that does not declare a
 *    strategy yields "needs-confirmation", never a silent ✓.
 *  - A runtime that KNOWS it lacks a strategy yields "invalid".
 *
 * Pure: no state, no network, no execution.
 */
import type { RecipeDraft } from "./RecipeEditor";

/** Strategy tiers declared by a provider. Absent strategy ⇒ UNKNOWN. */
export type TopologyCapability = "supported" | "unsupported" | "by-node-count";
export type TopologyDescriptor = Record<string, TopologyCapability>;

export type TopologyStrategy = "single" | "tp" | "pp" | "dp" | "ep";
export type TopologyTier = "supported" | "unsupported" | "needs-confirmation";
export type TopologyStatus = "valid" | "invalid" | "needs-confirmation";

/** Explicit strategy catalogue — data, never a fixed degree enum (1/2/4). */
export const TOPOLOGY_STRATEGIES: { id: TopologyStrategy; label: string; hint: string }[] = [
  { id: "single", label: "SINGLE", hint: "Exactly one node, no parallelism." },
  { id: "tp", label: "TP · tensor-parallel", hint: "Integer degree ≥ 1; splits tensors across nodes." },
  { id: "pp", label: "PP · pipeline-parallel", hint: "Integer degree ≥ 1; splits layers into stages." },
  { id: "dp", label: "DP · data-parallel", hint: "Integer degree ≥ 1; replicates across nodes." },
  { id: "ep", label: "EP · expert-parallel", hint: "Integer degree ≥ 1; spreads MoE experts." },
];

type DegreeKey = Exclude<TopologyStrategy, "single">;
const DEGREE_KEYS: DegreeKey[] = ["tp", "pp", "dp", "ep"];

const intOrNull = (v: string): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? n : null;
};

/** Configured integer degrees of a draft (blank entries are skipped). */
export function configuredDegrees(draft: RecipeDraft): { key: DegreeKey; degree: number }[] {
  return DEGREE_KEYS.map((key) => ({ key, degree: intOrNull(draft[key]) })).filter(
    (d): d is { key: DegreeKey; degree: number } => d.degree != null
  );
}

/**
 * Tier of ONE strategy for a runtime descriptor at a degree/node count.
 * Absent declaration ⇒ needs-confirmation (shown, never hidden, never valid).
 */
export function strategyTier(
  descriptor: TopologyDescriptor | null | undefined,
  strategy: TopologyStrategy,
  degree: number | null,
  nodeCount: number
): TopologyTier {
  const declared = descriptor?.[strategy];
  if (declared == null) return "needs-confirmation";
  if (declared === "unsupported") return "unsupported";
  if (declared === "by-node-count") {
    const d = Math.max(1, degree ?? 1);
    return d <= nodeCount ? "supported" : "unsupported";
  }
  return "supported";
}

/**
 * Validate a draft topology against a node count and declared runtime capability.
 * @returns {{status: TopologyStatus, reason: string}}
 */
export function evaluateTopology(input: {
  draft: RecipeDraft;
  descriptor?: TopologyDescriptor | null;
  nodeCount: number;
}): { status: TopologyStatus; reason: string } {
  const { draft, descriptor, nodeCount } = input;
  const degrees = configuredDegrees(draft);

  if (nodeCount < 1) {
    return { status: "needs-confirmation", reason: "no node count available — topology feasibility unknown" };
  }

  // No configured degree: the node count must NOT produce one.
  if (degrees.length === 0) {
    if (nodeCount > 1) {
      return {
        status: "needs-confirmation",
        reason: `topology unknown — ${nodeCount} nodes do not imply a parallelism degree`,
      };
    }
    const tier = strategyTier(descriptor, "single", 1, nodeCount);
    if (tier === "unsupported") return { status: "invalid", reason: "runtime does not support single-node serving" };
    if (tier === "needs-confirmation")
      return { status: "needs-confirmation", reason: "runtime does not declare single-node capability" };
    return { status: "valid", reason: "single node, runtime declares single-node support" };
  }

  // Structural rules.
  if (draft.topoMode === "single" && nodeCount !== 1) {
    return { status: "invalid", reason: `SINGLE requires exactly 1 node, got ${nodeCount}` };
  }
  const dominant = Math.max(...degrees.map((d) => d.degree));
  if (nodeCount < dominant) {
    return {
      status: "invalid",
      reason: `${draft.topoMode.toUpperCase()}${dominant} requires at least ${dominant} node(s), got ${nodeCount}`,
    };
  }
  const product = degrees.reduce((a, d) => a * d.degree, 1);
  if (product > nodeCount) {
    return { status: "invalid", reason: `parallelism product ${product} exceeds ${nodeCount} node(s)` };
  }

  // Runtime capability, keyed per configured strategy.
  const unsupported = degrees.filter((d) => strategyTier(descriptor, d.key, d.degree, nodeCount) === "unsupported");
  if (unsupported.length > 0) {
    return {
      status: "invalid",
      reason: `runtime does not support ${unsupported.map((d) => d.key.toUpperCase()).join(", ")}`,
    };
  }
  const unknown = degrees.filter((d) => strategyTier(descriptor, d.key, d.degree, nodeCount) === "needs-confirmation");
  if (unknown.length > 0) {
    return {
      status: "needs-confirmation",
      reason: `runtime declares no capability for ${unknown.map((d) => d.key.toUpperCase()).join(", ")} — confirm parallelism`,
    };
  }
  return { status: "valid", reason: "structurally sound and runtime-declared support" };
}
