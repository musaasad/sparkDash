import { useEffect, useMemo, useRef, useState } from "react";
import type { SparkSnapshot } from "../../api/types";
import type { DeploymentView } from "./fleetModel";
import {
  deriveFabric,
  deriveFabricTopology,
  derivePlacement,
  fabricLayout,
  fabricTopologyLabel,
  FABRIC_NODE_W,
  FABRIC_NODE_H,
  type FabricHealth,
  type FabricNode,
} from "./fabricModel";

export interface FabricPanelProps {
  sparks: readonly SparkSnapshot[];
  views: readonly DeploymentView[];
  navigate: (nodeId: string) => void;
  /** Obvious entry into the guided Add Compute wizard. */
  onAddCompute?: () => void;
}

/** Cards are SVG viewBox units — the viewBox scales them to the container. */
const CARD_W = FABRIC_NODE_W;
const CARD_H = FABRIC_NODE_H;
const AUTO_LIST_NODES = 9;

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

function roleLabel(role: string): string {
  return role === "head" ? "HEAD" : role === "worker" ? "WORKER" : "STANDALONE";
}

/**
 * PHYSICAL fabric + DEPLOYMENT placement, kept as two distinct visual modes.
 *
 * Physical edges come ONLY from `deriveFabric().links` and the physical shape is
 * classified from the edge set (`deriveFabricTopology`), never from node count.
 * CONFIGURED links are solid, DISCOVERED are dashed; `wiringDiscovered=false`
 * stays honest. Deployment mode draws no physical edges at all.
 *
 * The graph is one SVG with a viewBox (scales, never spills), with zoom/pan,
 * node select + detail, and a list/table fallback (explicit or auto on narrow
 * width / high node count).
 */
export function FabricPanel({ sparks, views, navigate, onAddCompute }: FabricPanelProps) {
  const [mode, setMode] = useState<"physical" | "deployment">("physical");
  const [listMode, setListMode] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(max-width: 900px)");
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);

  const fabric = useMemo(() => deriveFabric([...sparks], views), [sparks, views]);
  const placement = useMemo(() => derivePlacement([...sparks], views), [sparks, views]);
  const topology = useMemo(() => deriveFabricTopology(fabric), [fabric]);
  const layout = useMemo(() => fabricLayout(fabric, topology), [fabric, topology]);

  const byNodePlacements = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of placement.placements) {
      map.set(p.nodeId, [...(map.get(p.nodeId) || []), p.modelName]);
    }
    return map;
  }, [placement]);

  const physical = mode === "physical";
  const showList = listMode || narrow || fabric.nodes.length > AUTO_LIST_NODES;

  const nodeById = useMemo(() => new Map(fabric.nodes.map((n) => [n.id, n])), [fabric.nodes]);
  const linksByNode = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const l of fabric.links) {
      const a = nodeById.get(l.from)?.label ?? l.from;
      const b = nodeById.get(l.to)?.label ?? l.to;
      map.set(l.from, [...(map.get(l.from) || []), `${l.provenance.toUpperCase()} ${l.kind.toUpperCase()} → ${b} (${l.health})`]);
      map.set(l.to, [...(map.get(l.to) || []), `${l.provenance.toUpperCase()} ${l.kind.toUpperCase()} → ${a} (${l.health})`]);
    }
    return map;
  }, [fabric.links, nodeById]);

  if (fabric.nodes.length === 0) {
    return (
      <div className="cp-fabric">
        <div className="cp-fabric-head">
          <span className="cp-fabric-title">LAB FABRIC</span>
          <button type="button" className="cp-btn primary" onClick={() => onAddCompute?.()}>
            + Add compute
          </button>
        </div>
        <div className="cp-fabric-empty">No nodes registered.</div>
      </div>
    );
  }

  const byIndex = layout.positions;
  const nodeCentre = (i: number) => ({ x: byIndex[i].x + CARD_W / 2, y: byIndex[i].y + CARD_H / 2 });
  const selectedNode: FabricNode | null = selected ? nodeById.get(selected) ?? null : null;

  const nowZoom = (delta: number) => setZoom((z) => Math.max(0.5, Math.min(2.5, +(z + delta).toFixed(2))));
  const fit = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    setPan({
      x: drag.current.px + (e.clientX - drag.current.x),
      y: drag.current.py + (e.clientY - drag.current.y),
    });
  };
  const onPointerUp = () => {
    drag.current = null;
  };

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
          <span
            className={`cp-fabric-wiring mono${fabric.wiringDiscovered ? "" : " is-honest"}`}
            data-topology={topology}
          >
            {fabricTopologyLabel(topology, fabric.links)}
          </span>
        ) : (
          <span className="cp-fabric-wiring mono">{placement.placements.length} PLACEMENTS</span>
        )}
        <div className="cp-fabric-view" role="group" aria-label="Graph view controls">
          <button type="button" className="cp-btn ghost" aria-label="Zoom in" onClick={() => nowZoom(0.25)}>
            +
          </button>
          <button type="button" className="cp-btn ghost" aria-label="Zoom out" onClick={() => nowZoom(-0.25)}>
            −
          </button>
          <button type="button" className="cp-btn ghost" aria-label="Fit to view" onClick={fit}>
            Fit
          </button>
        </div>
        <button
          type="button"
          className={`cp-btn ghost${showList ? " is-active" : ""}`}
          aria-pressed={showList}
          onClick={() => setListMode((v) => !v)}
        >
          {showList ? "Graph" : "List"}
        </button>
        <button type="button" className="cp-btn primary" onClick={() => onAddCompute?.()}>
          + Add compute
        </button>
      </div>

      <div className="cp-fabric-legend" aria-hidden="true">
        {physical ? (
          <>
            <span className="cp-legend-item prov-configured">configured link</span>
            <span className="cp-legend-item prov-discovered">discovered link</span>
            <span className="cp-legend-item">solid / dashed = configured / discovered</span>
            <span className="cp-legend-item">wiring honest when unknown</span>
          </>
        ) : (
          <>
            <span className="cp-legend-item">model → node placement</span>
            <span className="cp-legend-item">no physical edges (separate graph)</span>
          </>
        )}
      </div>

      {showList ? (
        /* LIST FALLBACK — accessible without the graph (auto on narrow / high N). */
        <div className="cp-fabric-list" role="table" aria-label="Fabric nodes and links">
          <div className="cp-fabric-list-row is-head" role="row">
            <span role="columnheader">Node</span>
            <span role="columnheader">Role</span>
            <span role="columnheader">Health</span>
            <span role="columnheader">{physical ? "Links" : "Placed models"}</span>
          </div>
          {fabric.nodes.map((n) => {
            const links = physical ? linksByNode.get(n.id) ?? [] : [];
            const models = physical ? n.placedModels : byNodePlacements.get(n.id) ?? [];
            return (
              <button
                key={n.id}
                type="button"
                role="row"
                className={`cp-fabric-list-row tone-${HEALTH_TONE[n.health]}${selected === n.id ? " is-selected" : ""}`}
                aria-pressed={selected === n.id}
                onClick={() => setSelected(n.id)}
              >
                <span className="cp-fabric-list-name" role="cell">
                  <span className="cp-fabric-node-dot" aria-hidden="true" />
                  {n.label}
                </span>
                <span className="mono" role="cell">{roleLabel(n.role)}</span>
                <span className="mono" role="cell">{HEALTH_LABEL[n.health]}</span>
                <span className="cp-fabric-list-links mono" role="cell">
                  {physical
                    ? links.length > 0
                      ? links.join(" · ")
                      : "no link discovered"
                    : models.length > 0
                      ? models.join(" · ")
                      : "no model placed"}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div
          className="cp-fabric-canvas"
          style={{ width: "100%", aspectRatio: `${layout.width} / ${layout.height}` }}
        >
          <svg
            className={`cp-fabric-graph${physical && fabric.wiringDiscovered ? " cp-fabric-links" : ""}`}
            viewBox={layout.viewBox}
            preserveAspectRatio="xMidYMid meet"
            width="100%"
            height="100%"
            role="img"
            aria-label={`Physical fabric graph: ${topology}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          >
            <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
              {physical && fabric.wiringDiscovered
                ? fabric.links.map((l) => {
                    const ai = fabric.nodes.findIndex((n) => n.id === l.from);
                    const bi = fabric.nodes.findIndex((n) => n.id === l.to);
                    if (ai < 0 || bi < 0) return null;
                    const a = nodeCentre(ai);
                    const b = nodeCentre(bi);
                    const mx = (a.x + b.x) / 2;
                    const my = (a.y + b.y) / 2;
                    return (
                      <g
                        key={l.id}
                        className={`cp-fabric-link prov-${l.provenance}${l.degraded ? " is-degraded" : ""} tone-${HEALTH_TONE[l.health]}`}
                        data-provenance={l.provenance}
                        data-health={l.health}
                      >
                        <line
                          x1={a.x}
                          y1={a.y}
                          x2={b.x}
                          y2={b.y}
                          strokeDasharray={l.provenance === "discovered" ? "6 5" : undefined}
                        />
                        <text className="cp-fabric-link-speed mono" x={mx} y={my - 3} textAnchor="middle">
                          {l.provenance === "configured" ? "CONFIG · " : "DISCOVERED · "}
                          {l.kind.toUpperCase()} · {fmtSpeed(l.speedMbps)}
                        </text>
                      </g>
                    );
                  })
                : null}

              {physical && !fabric.wiringDiscovered ? (
                /* honest placeholders: positional only, no edge claimed. */
                <g className="cp-fabric-placeholders">
                  {layout.placeholderPairs.map(([ai, bi]) => {
                    const a = nodeCentre(ai);
                    const b = nodeCentre(bi);
                    return <line key={`ph-${ai}-${bi}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
                  })}
                </g>
              ) : null}

              {fabric.nodes.map((n, i) => {
                const p = byIndex[i];
                const placed = physical ? n.placedModels : byNodePlacements.get(n.id) || [];
                return (
                  <foreignObject key={n.id} x={p.x} y={p.y} width={CARD_W} height={CARD_H}>
                    <button
                      type="button"
                      className={`cp-fabric-node tone-${HEALTH_TONE[n.health]}${selected === n.id ? " is-selected" : ""}`}
                      style={{ width: CARD_W, height: CARD_H }}
                      aria-pressed={selected === n.id}
                      onClick={() => setSelected(n.id)}
                      onDoubleClick={() => navigate(n.id)}
                      title={`${n.label} — select for detail, double-click to open`}
                    >
                      <span className="cp-fabric-node-top">
                        <span className="cp-fabric-node-dot" aria-hidden="true" />
                        <span className="cp-fabric-node-name">{n.label}</span>
                      </span>
                      <span className="cp-fabric-node-meta mono">
                        {HEALTH_LABEL[n.health]} · {roleLabel(n.role)}
                      </span>
                      {physical ? <span className="cp-fabric-node-speed mono">{fmtSpeed(n.linkSpeedMbps)}</span> : null}
                      {placed.length > 0 ? (
                        <span className="cp-fabric-node-models" title={placed.join(" · ")}>
                          {placed.slice(0, 2).join(" · ")}
                        </span>
                      ) : !physical ? (
                        <span className="cp-fabric-node-models is-empty muted">no model placed</span>
                      ) : null}
                    </button>
                  </foreignObject>
                );
              })}
            </g>
          </svg>
        </div>
      )}

      {selectedNode ? (
        <div className="cp-fabric-detail" role="region" aria-label="Selected node detail">
          <span className="cp-fabric-detail-name">{selectedNode.label}</span>
          <span className="mono">{roleLabel(selectedNode.role)}</span>
          <span className="mono">{HEALTH_LABEL[selectedNode.health]}</span>
          {physical ? (
            <span className="mono">
              {fabric.links.some((l) => l.from === selectedNode.id || l.to === selectedNode.id)
                ? linksByNode.get(selectedNode.id)?.join(" · ")
                : "no link discovered"}
            </span>
          ) : null}
          <span className="mono">
            {selectedNode.placedModels.length > 0
              ? `models: ${selectedNode.placedModels.join(" · ")}`
              : "no model placed"}
          </span>
          <button type="button" className="cp-btn ghost" onClick={() => navigate(selectedNode.id)}>
            Open node
          </button>
        </div>
      ) : null}

      {physical && !fabric.wiringDiscovered ? (
        <div className="cp-fabric-note">Fabric edges not discovered — placeholders are positional only.</div>
      ) : null}
      {!physical && placement.placements.length === 0 ? (
        <div className="cp-fabric-note">No deployment placement yet — placement is derived, never inferred from fleet size.</div>
      ) : null}
    </div>
  );
}
