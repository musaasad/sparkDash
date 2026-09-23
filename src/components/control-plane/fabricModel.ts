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
import { nodeRole } from "../../shared/inventory.js";
import type { DeploymentView } from "./fleetModel";
import { nodeThermalLevel, nodeOomEvents } from "./cockpitModel";

export type FabricHealth = "ok" | "warn" | "error" | "offline" | "unknown";
export type FabricLinkKind = "cx7" | "fabric";
/** Where a link came from: CONFIG vs DISCOVERY (never conflated). */
export type FabricProvenance = "configured" | "discovered";

/**
 * PHYSICAL topology SHAPE — classified from the actual edge set (adjacency),
 * NEVER from node count. Strictly separate from the DEPLOYMENT parallelism
 * strategy (single/TP/PP/DP/hybrid): TP3 is not a triangle, TP4 is not a ring.
 */
export type FabricTopologyKind =
  | "single"
  | "pair"
  | "triangle"
  | "ring"
  | "mesh"
  | "star"
  | "custom"
  | "unknown";

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
  /** Discovered NIC speed in Mbps, or null when no endpoint measured one. */
  speedMbps: number | null;
  /**
   * True when `speedMbps` is null and only the CX7 NOMINAL 200 Gb/s applies —
   * never printed as a measured value.
   */
  speedNominal: boolean;
  degraded: boolean;
  /**
   * PHYSICAL LINK health — endpoint reachability only. Node health (memory /
   * temp) never leaks into fabric health: a link is healthy when both ends are
   * online, warn when either end is offline.
   */
  health: FabricHealth;
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

/**
 * Coarse NODE health from live signals only. Thermal comes from the REAL
 * measured thermal level — no invented alarm. Unified-memory utilisation is a
 * high-water proxy, NOT pressure, so it does not warn; a GENUINE oom event
 * (NV_ERR_NO_MEMORY) and disk pressure do. A missing temp stays ok.
 */
function healthOf(s: SparkSnapshot, hasDegradedDeployment: boolean): FabricHealth {
  if (!s.online) return "offline";
  if (hasDegradedDeployment) return "error";
  const diskPressure = (s.metrics?.storage || []).some((st) => !st.disabled && st.percentage >= 90);
  if (nodeThermalLevel(s) !== "normal" || nodeOomEvents(s) > 0 || diskPressure) return "warn";
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
    role: nodeRole(s),
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
    if (speeds.length === 0) return null;
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
    const degraded = !a.online || !b.online;
    const measured = speedOverride ?? nominalSpeed(a, b);
    links.push({
      id: `${provenance}:${kind}:${key}`,
      from: a.id,
      to: b.id,
      kind,
      provenance,
      speedMbps: measured,
      speedNominal: measured == null,
      degraded,
      // Link health is PHYSICAL reachability, never node memory pressure.
      health: degraded ? "warn" : "ok",
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

/**
 * Provenance-honest link count label. CONFIGURED is never mislabelled as
 * DISCOVERED: configured-only reads CONFIGURED, discovered-only reads
 * DISCOVERED, a mixed graph names both. Returns null when there are no links.
 */
export function fabricLinkProvenanceLabel(links: readonly Pick<FabricLink, "provenance">[]): string | null {
  if (links.length === 0) return null;
  const configured = links.filter((l) => l.provenance === "configured").length;
  const discovered = links.length - configured;
  const noun = `${links.length} LINK${links.length === 1 ? "" : "S"}`;
  if (discovered === 0) return `${noun} · CONFIGURED`;
  if (configured === 0) return `${noun} · DISCOVERED`;
  return `${noun} · ${configured} CONFIGURED · ${discovered} DISCOVERED`;
}

/** Deduped, undirected, in-node-set edge pairs (self-loops dropped). */
function edgePairs(
  nodes: readonly Pick<FabricNode, "id">[],
  links: readonly Pick<FabricLink, "from" | "to">[]
): Array<[string, string]> {
  const ids = new Set(nodes.map((n) => n.id));
  const seen = new Set<string>();
  const out: Array<[string, string]> = [];
  for (const l of links) {
    if (!ids.has(l.from) || !ids.has(l.to) || l.from === l.to) continue;
    const key = [l.from, l.to].sort().join("~");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([l.from, l.to]);
  }
  return out;
}

/** Adjacency + degree map over the deduped edge set. */
function adjacency(edges: Array<[string, string]>): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  }
  return adj;
}

/** Minimal graph input (ids + edge endpoints) shared by topology + layout. */
export interface FabricGraphInput {
  nodes: readonly Pick<FabricNode, "id">[];
  links: readonly Pick<FabricLink, "from" | "to">[];
}

/**
 * Classify the PHYSICAL topology STRICTLY from the edge set. Node count alone
 * never decides: 3 unlinked nodes are UNKNOWN, not a triangle; 4 unlinked nodes
 * are UNKNOWN, not a ring. `unknown` means links are absent/not discovered.
 */
export function deriveFabricTopology(model: FabricGraphInput): FabricTopologyKind {
  const n = model.nodes.length;
  if (n === 0) return "unknown";
  if (n === 1) return "single";

  const edges = edgePairs(model.nodes, model.links);
  if (edges.length === 0) return "unknown"; // nodes exist, wiring not discovered/absent

  if (n === 2 && edges.length === 1) return "pair";

  const adj = adjacency(edges);
  const degree = (id: string) => adj.get(id)?.size ?? 0;
  const complete = edges.length === (n * (n - 1)) / 2;

  if (complete && n === 3) return "triangle";
  if (complete && n > 3) return "mesh";

  // ring: a single cycle touching every node — each node joins exactly two.
  const ring = n >= 3 && edges.length === n && model.nodes.every((nd) => degree(nd.id) === 2);
  if (ring) return "ring";

  // star: exactly one hub joined to all leaves; leaves touch only the hub.
  const hub = model.nodes.find((nd) => degree(nd.id) === n - 1);
  const star =
    n >= 3 &&
    edges.length === n - 1 &&
    !!hub &&
    model.nodes.every((nd) => (nd.id === hub.id ? true : degree(nd.id) === 1));
  if (star) return "star";

  return "custom";
}

/**
 * Shape + provenance label, e.g. "PHYSICAL · TRIANGLE · 3 LINKS CONFIGURED".
 * Never claims a shape when wiring is absent — falls back to WIRING NOT DISCOVERED.
 */
export function fabricTopologyLabel(
  topology: FabricTopologyKind,
  links: readonly Pick<FabricLink, "provenance">[]
): string {
  const shape = `PHYSICAL · ${topology.toUpperCase()}`;
  const provenance = fabricLinkProvenanceLabel(links);
  return provenance ? `${shape} · ${provenance}` : `${shape} · WIRING NOT DISCOVERED`;
}

export interface FabricPosition {
  index: number;
  x: number;
  y: number;
}

/** Node box in SVG viewBox units — the canvas scales, so these are shape units. */
export const FABRIC_NODE_W = 236;
export const FABRIC_NODE_H = 118;
const FABRIC_PAD = 20;
const FABRIC_GAP = 46;

export interface FabricLayout {
  positions: FabricPosition[];
  width: number;
  height: number;
  /** SVG viewBox so the graph scales to its container and never spills sideways. */
  viewBox: string;
  /** Row-adjacent pairs, used ONLY as faint positional placeholders. */
  placeholderPairs: Array<[number, number]>;
}

function ringOrder(nodes: readonly Pick<FabricNode, "id">[], adj: Map<string, Set<string>>): number[] {
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const order: number[] = [];
  const visited = new Set<string>();
  let cur = nodes[0].id;
  order.push(0);
  visited.add(cur);
  while (order.length < nodes.length) {
    const next = [...(adj.get(cur) ?? [])].find((id) => !visited.has(id));
    if (!next) break;
    visited.add(next);
    order.push(idx.get(next)!);
    cur = next;
  }
  for (let i = 0; i < nodes.length; i++) if (!order.includes(i)) order.push(i);
  return order;
}

/**
 * Pure topology-AWARE layout (data only, no rendering). Positions follow the
 * physical connections so the drawn shape reflects the topology type; the whole
 * graph sits inside a viewBox. 1/2/3/4/6/8/N all reflow and stay readable, and
 * unknown/custom fall back to a stable readable grid. Consumes real links only.
 */
export function fabricLayout(
  model: FabricGraphInput,
  topology: FabricTopologyKind
): FabricLayout {
  const nodes = model.nodes;
  const n = nodes.length;
  if (n === 0) return { positions: [], width: 0, height: 0, viewBox: "0 0 0 0", placeholderPairs: [] };

  const edges = edgePairs(nodes, model.links);
  const adj = adjacency(edges);
  const centres: Array<{ x: number; y: number }> = new Array(n);
  const natural = nodes.map((_, i) => i);

  const circle = (order: number[], count: number) => {
    const r = Math.max(FABRIC_NODE_W * 0.8, (count * (FABRIC_NODE_W + FABRIC_GAP)) / (Math.PI * 2));
    order.forEach((nodeIdx, slot) => {
      const angle = (slot / order.length) * Math.PI * 2 - Math.PI / 2;
      centres[nodeIdx] = { x: r + Math.cos(angle) * r, y: r + Math.sin(angle) * r };
    });
  };

  const grid = (order: number[]) => {
    const cols = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(n))));
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / cols);
      const col = i - row * cols;
      const inRow = Math.min(cols, n - row * cols);
      centres[order[i]] = {
        x: (col + (cols - inRow) / 2) * (FABRIC_NODE_W + FABRIC_GAP),
        y: row * (FABRIC_NODE_H + FABRIC_GAP),
      };
    }
  };

  const triangle = (order: number[]) => {
    const side = FABRIC_NODE_W + FABRIC_GAP;
    centres[order[0]] = { x: side, y: 0 };
    centres[order[1]] = { x: 0, y: side * 0.866 };
    centres[order[2]] = { x: side * 2, y: side * 0.866 };
  };

  const star = () => {
    const hub = nodes.reduce((best, nd) => ((adj.get(nd.id)?.size ?? 0) > (adj.get(best.id)?.size ?? 0) ? nd : best), nodes[0]);
    const hubIdx = nodes.findIndex((nd) => nd.id === hub.id);
    const leaves = natural.filter((i) => i !== hubIdx);
    const r = Math.max(FABRIC_NODE_W, (leaves.length * (FABRIC_NODE_W + FABRIC_GAP)) / (Math.PI * 2));
    centres[hubIdx] = { x: r, y: r };
    circle(leaves, Math.max(1, leaves.length));
    leaves.forEach((nodeIdx, slot) => {
      const angle = (slot / Math.max(1, leaves.length)) * Math.PI * 2 - Math.PI / 2;
      centres[nodeIdx] = { x: r + Math.cos(angle) * r, y: r + Math.sin(angle) * r };
    });
  };

  switch (topology) {
    case "single":
      centres[natural[0]] = { x: 0, y: 0 };
      break;
    case "pair":
      natural.forEach((nodeIdx, slot) => {
        centres[nodeIdx] = { x: slot * (FABRIC_NODE_W + FABRIC_GAP), y: 0 };
      });
      break;
    case "triangle":
      triangle(natural);
      break;
    case "ring":
      circle(ringOrder(nodes, adj), n);
      break;
    case "mesh":
      if (n <= 8) circle(natural, n);
      else grid(natural);
      break;
    case "star":
      star();
      break;
    case "custom":
    case "unknown":
    default:
      grid(natural);
      break;
  }

  const raw = nodes.map((_, i) => ({
    index: i,
    x: centres[i].x - FABRIC_NODE_W / 2,
    y: centres[i].y - FABRIC_NODE_H / 2,
  }));
  const minX = Math.min(...raw.map((p) => p.x));
  const minY = Math.min(...raw.map((p) => p.y));
  const positions = raw.map((p) => ({ index: p.index, x: p.x - minX + FABRIC_PAD, y: p.y - minY + FABRIC_PAD }));

  const width = Math.max(...positions.map((p) => p.x)) + FABRIC_NODE_W + FABRIC_PAD;
  const height = Math.max(...positions.map((p) => p.y)) + FABRIC_NODE_H + FABRIC_PAD;

  const byRow = new Map<number, number[]>();
  for (const p of positions) byRow.set(p.y, [...(byRow.get(p.y) ?? []), p.index]);
  const placeholderPairs: Array<[number, number]> = [];
  for (const rowIndices of byRow.values()) {
    const sorted = [...rowIndices].sort((a, b) => positions[a].x - positions[b].x);
    for (let i = 0; i + 1 < sorted.length; i++) {
      if (positions[sorted[i + 1]].x - positions[sorted[i]].x <= FABRIC_NODE_W + FABRIC_GAP + 1) {
        placeholderPairs.push([sorted[i], sorted[i + 1]]);
      }
    }
  }

  return { positions, width: Math.round(width), height: Math.round(height), viewBox: `0 0 ${Math.round(width)} ${Math.round(height)}`, placeholderPairs };
}
