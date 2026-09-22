import { useMemo, useState } from "react";
import type { SparkSnapshot } from "../../api/types";
import type { DeploymentView } from "./fleetModel";
import { deriveFabric, derivePlacement, fabricLayout, type FabricHealth } from "./fabricModel";

export interface FabricPanelProps {
  sparks: readonly SparkSnapshot[];
  views: readonly DeploymentView[];
  navigate: (nodeId: string) => void;
  /** Obvious entry into the guided Add Compute wizard. */
  onAddCompute?: () => void;
}

const CARD_W = 236;
/** Tall enough for the full placed-models line to wrap, never clipped. */
const CARD_H = 118;

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
 * PHYSICAL fabric + DEPLOYMENT placement, kept as two distinct visual modes.
 *
 * Physical edges come ONLY from `deriveFabric().links`: CONFIGURED links are
 * solid, DISCOVERED shared-subnet links are dashed, and `wiringDiscovered=false`
 * stays honest. The deployment mode draws no physical edges at all — it shows
 * which model sits on which node, so the two graphs are never merged.
 */
export function FabricPanel({ sparks, views, navigate, onAddCompute }: FabricPanelProps) {
  const [mode, setMode] = useState<"physical" | "deployment">("physical");

  const fabric = useMemo(() => deriveFabric([...sparks], views), [sparks, views]);
  const placement = useMemo(() => derivePlacement([...sparks], views), [sparks, views]);
  const layout = useMemo(() => fabricLayout(fabric.nodes.length), [fabric.nodes.length]);

  const byNodePlacements = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of placement.placements) {
      map.set(p.nodeId, [...(map.get(p.nodeId) || []), p.modelName]);
    }
    return map;
  }, [placement]);

  if (fabric.nodes.length === 0) {
    return (
      <div className="cp-fabric">
        <div className="cp-fabric-head">
          <span className="cp-fabric-title">LAB FABRIC</span>
          <button type="button" className="cp-btn ghost" onClick={() => onAddCompute?.()}>
            + Add compute
          </button>
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

  const physical = mode === "physical";

  return (
    <div className="cp-fabric">
      <div className="cp-fabric-head">
        <span className="cp-fabric-title">LAB FABRIC</span>
        <div className="cp-fabric-modes" role="group" aria-label="Fabric view mode">
          <button
            type="button"
            className={`cp-btn ghost${physical ? " is-active" : ""}`}
            aria-pressed={physical}
            onClick={() => setMode("physical")}
          >
            Physical
          </button>
          <button
            type="button"
            className={`cp-btn ghost${!physical ? " is-active" : ""}`}
            aria-pressed={!physical}
            onClick={() => setMode("deployment")}
          >
            Deployment
          </button>
        </div>
        <span className="cp-fabric-count mono">{fabric.nodes.length}</span>
        {physical ? (
          <span className={`cp-fabric-wiring mono${fabric.wiringDiscovered ? "" : " is-honest"}`}>
            {fabric.wiringDiscovered ? `${fabric.links.length} LINKS DISCOVERED` : "WIRING NOT DISCOVERED"}
          </span>
        ) : (
          <span className="cp-fabric-wiring mono">{placement.placements.length} PLACEMENTS</span>
        )}
        <button type="button" className="cp-btn ghost" onClick={() => onAddCompute?.()}>
          + Add compute
        </button>
      </div>

      <div className="cp-fabric-legend" aria-hidden="true">
        {physical ? (
          <>
            <span className="cp-legend-item prov-configured">configured link</span>
            <span className="cp-legend-item prov-discovered">discovered link</span>
            <span className="cp-legend-item">wiring honest when unknown</span>
          </>
        ) : (
          <>
            <span className="cp-legend-item">model → node placement</span>
            <span className="cp-legend-item">no physical edges (separate graph)</span>
          </>
        )}
      </div>

      <div className="cp-fabric-canvas" style={{ width, height }}>
        {physical && fabric.wiringDiscovered ? (
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
                <g
                  key={l.id}
                  className={`cp-fabric-link prov-${l.provenance}${l.degraded ? " is-degraded" : ""}`}
                  data-provenance={l.provenance}
                >
                  <line x1={x1} y1={y1} x2={x2} y2={y2} strokeDasharray={l.provenance === "discovered" ? "6 5" : undefined} />
                  <text className="cp-fabric-link-speed mono" x={mx} y={my - 3} textAnchor="middle">
                    {l.provenance === "configured" ? "CONFIG · " : "DISCOVERED · "}
                    {l.kind.toUpperCase()} · {fmtSpeed(l.speedMbps)}
                  </text>
                </g>
              );
            })}
          </svg>
        ) : null}

        {physical && !fabric.wiringDiscovered ? (
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
        ) : null}

        {fabric.nodes.map((n, i) => {
          const p = layout[i];
          const placed = physical ? n.placedModels : byNodePlacements.get(n.id) || [];
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
              {physical ? <span className="cp-fabric-node-speed mono">{fmtSpeed(n.linkSpeedMbps)}</span> : null}
              {placed.length > 0 ? (
                <span className="cp-fabric-node-models">{placed.slice(0, 2).join(" · ")}</span>
              ) : !physical ? (
                <span className="cp-fabric-node-models is-empty muted">no model placed</span>
              ) : null}
            </button>
          );
        })}
      </div>

      {physical && !fabric.wiringDiscovered ? (
        <div className="cp-fabric-note">Fabric edges not discovered — placeholders are positional only.</div>
      ) : null}
      {!physical && placement.placements.length === 0 ? (
        <div className="cp-fabric-note">No deployment placement yet — placement is derived, never inferred from fleet size.</div>
      ) : null}
    </div>
  );
}
