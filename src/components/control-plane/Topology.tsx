import type { SparkSnapshot, RecipePublic, DeploymentStatus, ModelEntry } from "../../api/types";
import { recipesOnNode, friendlyName } from "./fleetModel";

interface TopologyProps {
  sparks: SparkSnapshot[];
  recipes: readonly RecipePublic[];
  deployments: readonly DeploymentStatus[];
  onNodeClick: (nodeId: string) => void;
  /** Optional model registry — friendly enclosure labels; falls back to raw ids. */
  models?: ModelEntry[];
}

const NODE_W = 172;
const NODE_H = 56;
const PAD = 12;
const CLUSTER_TOP = 26;

/** Deterministic layout: single row for ≤3, 2-col grid beyond. No force sim. */
function layout(count: number): { x: number; y: number }[] {
  const gapX = NODE_W + 96;
  const gapY = NODE_H + 72;
  if (count <= 3) {
    return Array.from({ length: count }, (_, i) => ({ x: 24 + i * gapX, y: 24 + CLUSTER_TOP }));
  }
  const perRow = Math.ceil(count / 2);
  return Array.from({ length: count }, (_, i) => ({
    x: 24 + (i % perRow) * gapX,
    y: 24 + CLUSTER_TOP + Math.floor(i / perRow) * gapY,
  }));
}

/**
 * Operationally-useful topology: deployment enclosures. Multi-node recipe
 * members share a rounded boundary (the deployment reads as ONE unit); standalone
 * nodes sit outside any boundary. Deterministic layout, no dependencies.
 */
export function Topology({ sparks, recipes, deployments, onNodeClick, models = [] }: TopologyProps) {
  const nodes = sparks.slice(0, 4);
  if (nodes.length === 0) return null;

  const idIndex = new Map(nodes.map((n, i) => [n.id, i]));
  const online = new Map(nodes.map((n) => [n.id, n.online]));

  // Phase 1 — enumerate deployment groups (multi-node recipes on visible nodes).
  const clusters = recipes
    .filter((r) => !r.archived && r.nodeIds.length > 1)
    .map((r) => {
      const dep = deployments.find((d) => d.recipeId === r.id);
      const memberIds = r.nodeIds.filter((id) => idIndex.has(id));
      return { recipe: r, dep, memberIds };
    })
    .filter((c) => c.memberIds.length > 1);

  // Phase 2 — order nodes so cluster members are contiguous, then the rest.
  const ordered: string[] = [];
  for (const c of clusters) for (const id of c.memberIds) if (!ordered.includes(id)) ordered.push(id);
  for (const n of nodes) if (!ordered.includes(n.id)) ordered.push(n.id);

  const pos = layout(ordered.length);
  const posOf = (id: string) => pos[ordered.indexOf(id)];

  const width = Math.max(...pos.map((p) => p.x)) + NODE_W + PAD + 24;
  const height = Math.max(...pos.map((p) => p.y)) + NODE_H + PAD + 12;

  return (
    <svg className="cp-topology" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Fleet topology">
      {/* Internal TP links inside a cluster (secondary) */}
      {clusters.map((c) =>
        c.memberIds.slice(0, -1).map((id, i) => {
          const a = posOf(id);
          const b = posOf(c.memberIds[i + 1]);
          const x1 = a.x + NODE_W;
          const y1 = a.y + NODE_H / 2;
          const x2 = b.x;
          const y2 = b.y + NODE_H / 2;
          const mx = (x1 + x2) / 2;
          const degraded = c.dep ? c.dep.state === "error" : c.memberIds.some((id2) => !online.get(id2));
          return (
            <path
              key={`${c.recipe.id}-${i}`}
              className={`cp-topo-edge ${degraded ? "degraded" : ""}`}
              d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
              fill="none"
            />
          );
        })
      )}

      {/* Deployment enclosures — the primary read */}
      {clusters.map((c) => {
        const pts = c.memberIds.map(posOf);
        const minX = Math.min(...pts.map((p) => p.x)) - PAD;
        const minY = Math.min(...pts.map((p) => p.y)) - PAD;
        const maxX = Math.max(...pts.map((p) => p.x)) + NODE_W + PAD;
        const maxY = Math.max(...pts.map((p) => p.y)) + NODE_H + PAD;
        const degraded = c.dep ? c.dep.state === "error" : c.memberIds.some((id) => !online.get(id));
        const label = `${friendlyName(c.recipe.modelId, models)} · ${c.recipe.topology.toUpperCase()}`;
        return (
          <g key={`cluster-${c.recipe.id}`} className={`cp-topo-cluster ${degraded ? "is-degraded" : ""}`}>
            <rect x={minX} y={minY} width={maxX - minX} height={maxY - minY} rx={10} />
            <text className="cp-topo-cluster-label" x={minX + 10} y={minY - 8}>
              {label}
            </text>
          </g>
        );
      })}

      {/* Node boxes */}
      {ordered.map((id, i) => {
        const n = nodes[idIndex.get(id) as number];
        const p = pos[i];
        const onNode = recipesOnNode(recipes, n.id);
        const cluster = clusters.find((c) => c.memberIds.includes(n.id));
        const modelLabel = cluster
          ? friendlyName(cluster.recipe.modelId, models)
          : onNode[0]
            ? friendlyName(onNode[0].modelId, models)
            : (n.workerLabel || n.workerDerivedLabel || null);
        const um = n.metrics?.unifiedMemory;
        const memPct = um && um.total > 0 ? Math.round(um.percentage) : null;
        return (
          <g
            key={n.id}
            className={`cp-topo-node ${n.online ? "" : "is-offline"}`}
            onClick={() => onNodeClick(n.id)}
            style={{ cursor: "pointer" }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && onNodeClick(n.id)}
          >
            <rect x={p.x} y={p.y} width={NODE_W} height={NODE_H} rx={8} />
            <circle
              cx={p.x + 14}
              cy={p.y + 18}
              r={4}
              fill={n.online ? "var(--color-status-running)" : "var(--color-status-stopped)"}
            />
            <text x={p.x + 24} y={p.y + 22}>
              {n.name}
            </text>
            <text className="cp-topo-sub" x={p.x + 24} y={p.y + 38}>
              {modelLabel ?? (n.online ? "idle" : "offline")}
              {memPct != null ? ` · ${memPct}% mem` : ""}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
