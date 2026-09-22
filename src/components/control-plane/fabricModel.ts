/**
 * PHYSICAL FABRIC model — deliberately SEPARATE from deployment topology.
 *
 * The fabric describes what is physically there: nodes, their health / link
 * speed / role / placed models, and only the links that were actually
 * discoverable. TP/PP/DP/EP belongs to the DEPLOYMENT (recipe.topologyBlock)
 * and is never read here.
 *
 * Honesty rules:
 *  - A link exists ONLY when two nodes share a discovered CX7 subnet / fabric id
 *    (provenance "discovered") OR the node config declares a fabricLink peer
 *    (provenance "configured"). Three nodes never become a triangle on their own.
 *  - When no link is discoverable/configured, `links` is empty and
 *    `wiringDiscovered` is false — the UI renders "nodes + link speed, wiring
 *    not discovered".
 */
import type { SparkSnapshot } from "../../api/types";
import { resolveSparkRole } from "../../api/sparkRole";
import type { DeploymentView } from "./fleetModel";

export type FabricHealth = "ok" | "warn" | "error" | "offline" | "unknown";
export type FabricLinkKind = "cx7" | "fabric";
/** Where a link came from: CONFIG vs DISCOVERY (never conflated). */
export type FabricProvenance = "configured" | "discovered";

export interface FabricNode {
  id: string;
  label: string;
  online: boolean;
  health: FabricHealth;
  /** Physical NIC link speed in Mbps when discovered, else null. */
  linkSpeedMbps: number | null;
  role: string;
  /** Deployment names placed on this node (deployment topology, not fabric). */
  placedModels: string[];
}

export interface FabricLink {
  id: string;
  from: string;
  to: string;
  /** Medium actually discovered: a shared CX7 subnet, or a configured fabric. */
  kind: FabricLinkKind;
  /** CONFIG or DISCOVERY — never inferred from topology or node count. */
  provenance: FabricProvenance;
  /** Discovered NIC speed in Mbps, else the CX7 nominal 200 Gb/s when unset. */
  speedMbps: number | null;
  degraded: boolean;
}

export interface FabricModel {
  nodes: FabricNode[];
  links: FabricLink[];
  /** False when no physical link could be discovered — show the honest state. */
  wiringDiscovered: boolean;
}

// ─── DEPLOYMENT PLACEMENT (separate visual, never merged with the fabric) ────
/** Which deployment/model sits on which node. Placement, not topology degree. */
export interface PlacementNode {
  id: string;
  label: string;
  online: boolean;
  health: FabricHealth;
}

export interface Placement {
  nodeId: string;
  deploymentKey: string;
  modelName: string;
  runtime: string;
  display: string;
}

export interface PlacementModel {
  nodes: PlacementNode[];
  placements: Placement[];
}

/**
 * Derive DEPLOYMENT PLACEMENT — deliberately separate from physical links so
 * the two graphs are never conflated. Fleet size never implies parallelism; the
 * recipe topology stays on the deployment.
 */
export function derivePlacement(
  sparks: SparkSnapshot[],
  deploymentViews: readonly DeploymentView[]
): PlacementModel {
  const degraded = new Set(
    deploymentViews
      .filter((v) => v.deployment.display === "degraded" || !!v.deployment.lastError)
      .flatMap((v) => v.deployment.nodeIds)
  );
  const nodes: PlacementNode[] = sparks.map((s) => ({
    id: s.id,
    label: s.name || s.id,
    online: s.online,
    health: healthOf(s, degraded.has(s.id)),
  }));
  const placements: Placement[] = [];
  for (const v of deploymentViews) {
    for (const nodeId of v.deployment.nodeIds) {
      placements.push({
        nodeId,
        deploymentKey: v.key,
        modelName: v.modelName || v.rawModelId,
        runtime: v.runtime,
        display: v.deployment.display,
      });
    }
  }
  return { nodes, placements };
}

/** First three octets of an IPv4 — the /24 fabric segment. */
function subnet(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const parts = String(ip).trim().split(".");
  return parts.length === 4 ? parts.slice(0, 3).join(".") : null;
}

/** Coarse node health from live signals only; nothing is fabricated. */
function healthOf(s: SparkSnapshot, hasDegradedDeployment: boolean): FabricHealth {
  if (!s.online) return "offline";
  if (hasDegradedDeployment) return "error";
  const gpu = s.metrics?.gpu;
  const diskPressure = (s.metrics?.storage || []).some((st) => !st.disabled && st.percentage >= 90);
  if (gpu?.throttle?.active || (typeof gpu?.temperature === "number" && gpu.temperature >= 90) || diskPressure) return "warn";
  if (s.metrics?.unifiedMemory?.oomRisk === "high") return "warn";
  return s.metrics ? "ok" : "unknown";
}

/**
 * Derive the physical fabric. `deploymentViews` is used ONLY to place model
 * names on nodes — the fabric shape never depends on the deployment topology.
 */
export function deriveFabric(sparks: SparkSnapshot[], deploymentViews: readonly DeploymentView[]): FabricModel {
  const degradedDeployments = new Set(
    deploymentViews
      .filter((v) => v.deployment.display === "degraded" || !!v.deployment.lastError)
      .flatMap((v) => v.deployment.nodeIds)
  );

  const nodes: FabricNode[] = sparks.map((s) => ({
    id: s.id,
    label: s.name || s.id,
    online: s.online,
    health: healthOf(s, degradedDeployments.has(s.id)),
    linkSpeedMbps: s.metrics?.network?.linkSpeedMbps ?? null,
    role: resolveSparkRole(s),
    placedModels: deploymentViews
      .filter((v) => v.deployment.nodeIds.includes(s.id))
      .map((v) => v.modelName || v.rawModelId),
  }));

  const links: FabricLink[] = [];
  const seen = new Set<string>();
  const nominalSpeed = (a: SparkSnapshot, b: SparkSnapshot): number | null => {
    const speeds = [a.metrics?.network?.linkSpeedMbps, b.metrics?.network?.linkSpeedMbps].filter(
      (v): v is number => typeof v === "number"
    );
    if (speeds.length === 0) return 200_000; // ConnectX-7 nominal 200 Gb/s
    return Math.min(...speeds);
  };

  const pushLink = (
    a: SparkSnapshot,
    b: SparkSnapshot,
    kind: FabricLinkKind,
    provenance: FabricProvenance,
    speedOverride: number | null = null
  ) => {
    const key = [a.id, b.id].sort().join("~");
    if (a.id === b.id || seen.has(key)) return;
    seen.add(key);
    links.push({
      id: `${provenance}:${kind}:${key}`,
      from: a.id,
      to: b.id,
      kind,
      provenance,
      speedMbps: speedOverride ?? nominalSpeed(a, b),
      degraded: !a.online || !b.online,
    });
  };

  // CONFIGURED first (highest confidence): explicit fabricLinks neighbours.
  // A configured link only exists when the peer node is actually present.
  const byId = new Map(sparks.map((s) => [s.id, s]));
  for (const s of sparks) {
    for (const l of s.fabricLinks || []) {
      const peer = byId.get(l.to);
      if (!peer) continue;
      pushLink(
        s,
        peer,
        l.medium === "cx7" ? "cx7" : "fabric",
        "configured",
        typeof l.speedMbps === "number" ? l.speedMbps : null
      );
    }
  }

  // Physical DISCOVERY: same fabric id, or same discovered CX7 /24 segment.
  for (let i = 0; i < sparks.length; i++) {
    for (let j = i + 1; j < sparks.length; j++) {
      const a = sparks[i];
      const b = sparks[j];
      if (a.fabric && b.fabric && a.fabric === b.fabric) {
        pushLink(a, b, "fabric", "discovered");
        continue;
      }
      const sa = subnet(a.cx7Ip);
      const sb = subnet(b.cx7Ip);
      if (sa && sb && sa === sb) pushLink(a, b, "cx7", "discovered");
    }
  }

  return { nodes, links, wiringDiscovered: links.length > 0 };
}

export interface FabricPosition {
  index: number;
  x: number;
  y: number;
}

const FABRIC_COL_W = 268;
const FABRIC_ROW_H = 136;

/**
 * Pure layout for 1..N nodes (data only, no rendering). Rows of ≤2 with the
 * last short row centred, so 1/2/3/4+ all read coherently and the viz adapts to
 * fleet size.
 */
export function fabricLayout(nodeCount: number): FabricPosition[] {
  const n = Math.max(0, Math.floor(nodeCount));
  if (n === 0) return [];
  const cols = n <= 2 ? n : 2;
  const out: FabricPosition[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const rowStart = row * cols;
    const inRow = Math.min(cols, n - rowStart);
    const col = i - rowStart;
    const offset = ((cols - inRow) * FABRIC_COL_W) / 2;
    out.push({ index: i, x: 24 + offset + col * FABRIC_COL_W, y: 24 + row * FABRIC_ROW_H });
  }
  return out;
}
