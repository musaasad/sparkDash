/**
 * Capability-aware topology validation — DRY-RUN, pure.
 *
 * Combines STRUCTURAL feasibility (a degree needs at least that many nodes; the
 * parallelism product needs enough nodes; "single" is exactly one node) with the
 * RUNTIME's DECLARED parallelism capability.
 *
 * Invariants:
 *  - FLEET SIZE != PARALLELISM DEGREE. Three nodes with no configured degree do
 *    NOT become TP3; that is NEEDS-CONFIRMATION (topology unknown).
 *  - UNKNOWN != FAILED. A provider that does not know a degree yields
 *    "needs-confirmation", never "invalid" — and never silently "valid".
 *  - A provider that KNOWS it does not support a degree yields "invalid".
 *
 * @module
 */

/** Parallelism degree kinds, dominant-first. */
const DEGREE_KEYS = ["tp", "pp", "dp", "ep"];

const intOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : null;
};

/**
 * Validate a topology against a node count and a runtime's capability.
 *
 * @param {{
 *   topology?: object|null,
 *   nodeCount?: number|null,
 *   runtime?: string|null,
 *   provider?: {supportsTopology?: (spec: object) => string}|null,
 *   registry?: {supportsTopology?: (runtime: string, spec: object) => string}|null,
 * }} [input]
 * @returns {{status: "valid"|"invalid"|"needs-confirmation", reason: string}}
 */
export function validateTopology(input = {}) {
  const topo = input.topology && typeof input.topology === "object" ? input.topology : {};
  const mode = typeof topo.mode === "string" && topo.mode ? topo.mode : "single";
  const degrees = DEGREE_KEYS.map((k) => intOrNull(topo[k])).filter((v) => v != null);
  const configured = degrees.length > 0;
  const nodeCount = Number(input.nodeCount) || 0;

  const capabilityOf = (spec) => {
    if (typeof input.provider?.supportsTopology === "function") return input.provider.supportsTopology(spec);
    if (typeof input.registry?.supportsTopology === "function") return input.registry.supportsTopology(input.runtime, spec);
    return "unknown";
  };

  if (nodeCount < 1) {
    return { status: "needs-confirmation", reason: "no node count available — topology feasibility unknown" };
  }

  // ── No configured degree: node count must NOT produce one ──
  if (!configured) {
    if (nodeCount > 1) {
      return {
        status: "needs-confirmation",
        reason: `topology unknown — ${nodeCount} nodes do not imply a parallelism degree`,
      };
    }
    const cap = capabilityOf({ mode, degree: 1, nodeCount });
    if (cap === "unsupported") return { status: "invalid", reason: `runtime does not support single-node serving` };
    if (cap === "unknown") return { status: "needs-confirmation", reason: `provider does not declare single-node capability` };
    return { status: "valid", reason: "single node, provider declares single-node support" };
  }

  // ── Structural rules ──
  const dominant = intOrNull(topo[mode]) ?? Math.max(...degrees);
  if (mode === "single" && nodeCount !== 1) {
    return { status: "invalid", reason: `single topology requires exactly 1 node, got ${nodeCount}` };
  }
  if (nodeCount < dominant) {
    return { status: "invalid", reason: `topology ${mode}${dominant} requires at least ${dominant} node(s), got ${nodeCount}` };
  }
  const product = degrees.reduce((a, b) => a * b, 1);
  if (product > nodeCount) {
    return { status: "invalid", reason: `parallelism product ${product} exceeds ${nodeCount} node(s)` };
  }

  // ── Provider capability per configured degree kind ──
  const checks = new Map();
  for (const k of DEGREE_KEYS) {
    const d = intOrNull(topo[k]);
    if (d != null) checks.set(k, capabilityOf({ mode: k, degree: d, nodeCount }));
  }
  const unsupported = [...checks.entries()].filter(([, v]) => v === "unsupported").map(([k]) => k);
  if (unsupported.length > 0) {
    return { status: "invalid", reason: `runtime does not support topology mode(s): ${unsupported.join(", ")}` };
  }
  const unknowns = [...checks.entries()].filter(([, v]) => v === "unknown").map(([k]) => k);
  if (unknowns.length > 0) {
    return {
      status: "needs-confirmation",
      reason: `provider declares no capability for mode(s): ${unknowns.join(", ")} — confirm parallelism`,
    };
  }
  return { status: "valid", reason: "structurally sound and provider-declared support" };
}
