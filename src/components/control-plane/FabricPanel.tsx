import { useMemo } from "react";
import type { SparkSnapshot } from "../../api/types";
import type { DeploymentView } from "./fleetModel";
import { deriveFabric, fabricLayout, type FabricHealth } from "./fabricModel";

export interface FabricPanelProps {
  sparks: readonly SparkSnapshot[];
  views: readonly DeploymentView[];
  navigate: (nodeId: string) => void;
}

const CARD_W = 236;
const CARD_H = 92;

const HEALTH_TONE: Record<FabricHealth, string> = {
  ok: "live",
  warn: "warn",
  error: "alert",
  offline: "off",
  unknown: "calm",
};

const HEALTH_LABEL: Record<FabricHealth, string> = {
  ok: "NOMINAL",
  warn: "WARN",
  error: "DEGRADED",
  offline: "OFFLINE",
  unknown: "UNKNOWN",
};

function fmtSpeed(mbps: number | null): string {
  if (mbps == null) return "—";
  if (mbps >= 1000) return `${Math.round(mbps / 1000)} Gb/s`;
  return `${mbps} Mb/s`;
}

/**
 * PHYSICAL fabric panel. Edges are drawn ONLY from `deriveFabric().links` —
 * three nodes never become a triangle, and node count never implies TP.
 * When no wiring was discovered the honest state is shown instead.
 */
export function FabricPanel({ sparks, views, navigate }: FabricPanelProps) {
  const fabric = useMemo(() => deriveFabric([...sparks], views), [sparks, views]);
  const layout = useMemo(() => fabricLayout(fabric.nodes.length), [fabric.nodes.length]);

  if (fabric.nodes.length === 0) {
    return (
      <div className="cp-fabric">
        <div className="cp-fabric-head">
          <span className="cp-fabric-title">LAB FABRIC</span>
        </div>
        <div className="cp-fabric-empty">No nodes registered.</div>
      </div>
    );
  }

  const cardW = CARD_W;
  const cardH = CARD_H;
  const width = layout.reduce((m, p) => Math.max(m, p.x + cardW), 0) + 24;
  const height = layout.reduce((m, p) => Math.max(m, p.y + cardH), 0) + 24;
  const byId = new Map(fabric.nodes.map((n, i) => [n.id, layout[i]]));

  return (
    <div className="cp-fabric">
      <div className="cp-fabric-head">
        <span className="cp-fabric-title">LAB FABRIC</span>
        <span className="cp-fabric-count mono">{fabric.nodes.length}</span>
        <span className={`cp-fabric-wiring mono${fabric.wiringDiscovered ? "" : " is-honest"}`}>
          {fabric.wiringDiscovered ? `${fabric.links.length} LINKS DISCOVERED` : "WIRING NOT DISCOVERED"}
        </span>
      </div>

      <div className="cp-fabric-canvas" style={{ width, height }}>
        {fabric.wiringDiscovered ? (
          <svg className="cp-fabric-links" width={width} height={height} aria-hidden="true">
            {fabric.links.map((l) => {
              const a = byId.get(l.from);
              const b = byId.get(l.to);
              if (!a || !b) return null;
              const x1 = a.x + cardW / 2;
              const y1 = a.y + cardH / 2;
              const x2 = b.x + cardW / 2;
              const y2 = b.y + cardH / 2;
              const mx = (x1 + x2) / 2;
              const my = (y1 + y2) / 2;
              return (
                <g key={l.id} className={`cp-fabric-link${l.degraded ? " is-degraded" : ""}`}>
                  <line x1={x1} y1={y1} x2={x2} y2={y2} />
                  <text className="cp-fabric-link-speed mono" x={mx} y={my - 3} textAnchor="middle">
                    {l.kind.toUpperCase()} · {fmtSpeed(l.speedMbps)}
                  </text>
                </g>
              );
            })}
          </svg>
        ) : (
          /* honest affordance: faint dashed placeholders between same-row
             neighbours — no edge is claimed until wiring is discovered. */
          <svg className="cp-fabric-placeholders" width={width} height={height} aria-hidden="true">
            {layout.map((p, i) => {
              const next = layout[i + 1];
              if (!next || next.y !== p.y) return null;
              const y = p.y + cardH / 2;
              return <line key={`ph-${i}`} x1={p.x + cardW} y1={y} x2={next.x} y2={y} />;
            })}
          </svg>
        )}

        {fabric.nodes.map((n, i) => {
          const p = layout[i];
          return (
            <button
              key={n.id}
              type="button"
              className={`cp-fabric-node tone-${HEALTH_TONE[n.health]}`}
              style={{ left: p.x, top: p.y, width: cardW, height: cardH }}
              onClick={() => navigate(n.id)}
              title={n.label}
            >
              <span className="cp-fabric-node-top">
                <span className="cp-fabric-node-dot" aria-hidden="true" />
                <span className="cp-fabric-node-name">{n.label}</span>
              </span>
              <span className="cp-fabric-node-meta mono">
                {HEALTH_LABEL[n.health]}
                {n.role === "head" ? " · HEAD" : n.role === "worker" ? " · WORKER" : ""}
              </span>
              {/* per-node link-speed badge */}
              <span className="cp-fabric-node-speed mono">{fmtSpeed(n.linkSpeedMbps)}</span>
              {n.placedModels.length > 0 ? (
                <span className="cp-fabric-node-models">{n.placedModels.slice(0, 2).join(" · ")}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      {!fabric.wiringDiscovered ? (
        <div className="cp-fabric-note">Fabric edges not discovered — placeholders are positional only.</div>
      ) : null}
    </div>
  );
}
