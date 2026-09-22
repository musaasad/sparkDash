import type { SparkSnapshot, RecipePublic, DeploymentStatus } from "../../api/types";
import { recipesOnNode } from "./fleetModel";

interface TopologyProps {
  sparks: SparkSnapshot[];
  recipes: readonly RecipePublic[];
  deployments: readonly DeploymentStatus[];
  onNodeClick: (nodeId: string) => void;
}

const NODE_W = 172;
const NODE_H = 56;

/** Deterministic layout: single row for ≤3, 2-col grid beyond. No force sim. */
function layout(count: number): { x: number; y: number }[] {
  const gapX = NODE_W + 96;
  const gapY = NODE_H + 56;
  if (count <= 3) {
    return Array.from({ length: count }, (_, i) => ({ x: 24 + i * gapX, y: 24 }));
  }
  const perRow = Math.ceil(count / 2);
  return Array.from({ length: count }, (_, i) => ({
    x: 24 + (i % perRow) * gapX,
    y: 24 + Math.floor(i / perRow) * gapY,
  }));
}

/**
 * Operationally-useful topology: nodes + shard edges that carry meaning
 * (which nodes serve which model, degraded when a worker is unreachable).
 * Falls back to nothing above 4 nodes (Fleet table is the primary view there).
 */
export function Topology({ sparks, recipes, deployments, onNodeClick }: TopologyProps) {
  const nodes = sparks.slice(0, 4);
  if (nodes.length === 0) return null;
  const pos = layout(nodes.length);
  const idIndex = new Map(nodes.map((n, i) => [n.id, i]));
  const online = new Map(nodes.map((n) => [n.id, n.online]));

  // Edges: for each multi-node recipe, connect its node group; label with model.
  const edges: { a: number; b: number; label: string; degraded: boolean }[] = [];
  for (const r of recipes) {
    if (r.nodeIds.length < 2) continue;
    const idxs = r.nodeIds.map((id) => idIndex.get(id)).filter((i): i is number => i != null);
    const dep = deployments.find((d) => d.recipeId === r.id);
    const degraded = dep ? dep.state === "error" : idxs.some((i) => !online.get(nodes[i].id));
    for (let i = 0; i < idxs.length - 1; i++) {
      edges.push({ a: idxs[i], b: idxs[i + 1], label: r.modelId, degraded });
    }
  }

  const width = Math.max(...pos.map((p) => p.x)) + NODE_W + 24;
  const height = Math.max(...pos.map((p) => p.y)) + NODE_H + 24;

  return (
    <svg className="cp-topology" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Fleet topology">
      {edges.map((e, i) => {
        const pa = pos[e.a];
        const pb = pos[e.b];
        const x1 = pa.x + NODE_W;
        const y1 = pa.y + NODE_H / 2;
        const x2 = pb.x;
        const y2 = pb.y + NODE_H / 2;
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        return (
          <g key={i}>
            <path
              className={`cp-topo-edge ${e.degraded ? "degraded" : ""}`}
              d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
              fill="none"
            />
            <text className="cp-topo-edge-label" x={mx} y={my - 4} textAnchor="middle">
              {e.label}
            </text>
          </g>
        );
      })}
      {nodes.map((n, i) => {
        const p = pos[i];
        const onNode = recipesOnNode(recipes, n.id);
        const modelLabel = onNode[0]?.modelId ?? (n.workerLabel || n.workerDerivedLabel || null);
        const vram = n.metrics?.gpu?.vram;
        const vramPct = vram && vram.total > 0 ? Math.round((vram.used / vram.total) * 100) : null;
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
              {vramPct != null ? ` · ${vramPct}% mem` : ""}
            </text>
          </g>
        );
      })}
    </svg>
  );
}