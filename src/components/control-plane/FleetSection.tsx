import { useMemo, useState } from "react";
import type { SparkSnapshot, DeploymentStatus, RecipePublic, ModelEntry } from "../../api/types";
import type { Route } from "../../hooks/router";
import { DataTable, CountedTabs, EntityChip, type Column } from "../ui/DataTable";
import { StatusPill, StatusDot, Chip, EmptyState } from "../ui/Status";
import { SectionBand } from "../ui/SectionBand";
import { Toolbar, DensityToggle } from "../ui/Toolbar";
import { KebabIcon, NetworkIcon } from "../ui/icons";
import { fleetNodes, recipesOnNode, fmtUptime, nodeHealthRail, nodeMatchesRail } from "./fleetModel";
import { Topology } from "./Topology";
import { nodeRole } from "../../shared/inventory.js";

interface FleetProps {
  sparks: SparkSnapshot[];
  deployments: readonly DeploymentStatus[];
  recipes: readonly RecipePublic[];
  navigate: (route: Route) => void;
  /** Model registry — friendly topology labels; falls back to raw ids. */
  models?: ModelEntry[];
  /** Obvious entry into the guided Add Compute wizard. */
  onAddCompute?: () => void;
}

function fmtTemp(celsius: number): string {
  return `${Math.round(celsius)}°C`;
}

export function FleetSection({ sparks, deployments, recipes, navigate, models = [], onAddCompute }: FleetProps) {
  const [rail, setRail] = useState("all");
  const [query, setQuery] = useState("");
  const [dense, setDense] = useState(false);

  // CANONICAL inventory: every configured/adopted node, workers included. A
  // worker node never disappears — its cluster role rides as a badge.
  const nodes = useMemo(() => fleetNodes(sparks), [sparks]);
  // Data-driven compact switch: at larger N the fleet stops assuming the three
  // giant cards / topology block reading and tightens to a dense list.
  const compact = nodes.length > 6;
  // One rail vocabulary for both the side rail and the toolbar tabs so a chip
  // persists when the other surface is used.
  const railItems = useMemo(() => nodeHealthRail(nodes, deployments), [nodes, deployments]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return nodes.filter((n) => {
      if (!nodeMatchesRail(n, rail, deployments)) return false;
      if (q && !`${n.name} ${n.lanIp ?? ""} ${n.role ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [nodes, rail, deployments, query]);

  const columns: Column<SparkSnapshot>[] = [
    {
      key: "name",
      header: "Node",
      render: (n) => (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <EntityChip icon={<NetworkIcon />} label={n.name} title={n.lanIp ?? n.name} />
          <Chip>{n.kind === "host" ? "host" : "spark"}</Chip>
          <Chip tone={nodeRole(n) === "head" ? "accent" : undefined}>{nodeRole(n)}</Chip>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (n) => <StatusPill status={n.online ? "online" : "offline"} />,
    },
    {
      key: "gpu",
      header: "GPU",
      align: "right",
      render: (n) =>
        n.metrics?.gpu && n.metricsCollectSuccess?.gpu !== false ? (
          <span className="cp-metric-chip">
            {Math.round(n.metrics.gpu.usage)}
            <span className="cp-unit"> %</span>
          </span>
        ) : (
          <span className="cp-nodata">—</span>
        ),
    },
    {
      key: "vram",
      header: "VRAM",
      align: "right",
      muted: true,
      render: (n) => {
        const v = n.metrics?.gpu?.vram;
        if (n.metricsCollectSuccess?.gpu !== false || !v || v.total <= 0) return "—";
        return (
          <span className="cp-metric-chip">
            {Math.round(v.used / 1024)}/{Math.round(v.total / 1024)} GB
          </span>
        );
      },
    },
    {
      key: "temp",
      header: "Temp",
      align: "right",
      muted: true,
      render: (n) =>
        n.metrics?.gpu?.temperature != null && n.metricsCollectSuccess?.gpu !== false ? (
          <span className={`cp-metric-chip${n.metrics.gpu.temperature > 85 ? " cp-over" : ""}`}>{fmtTemp(n.metrics.gpu.temperature)}</span>
        ) : (
          <span className="cp-nodata">—</span>
        ),
    },
    {
      key: "power",
      header: "Power",
      align: "right",
      muted: true,
      render: (n) => {
        if (n.metricsCollectSuccess?.gpu !== false) return "—";
        const p = n.metrics?.gpu?.power?.systemDraw ?? n.metrics?.gpu?.power?.draw;
        return p != null ? `${Math.round(p)} W` : "—";
      },
    },
    {
      key: "uptime",
      header: "Uptime",
      align: "right",
      muted: true,
      render: (n) => fmtUptime(n.uptime),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (n) => (
        <div className="cp-row-actions">
          <button
            type="button"
            className="cp-kebab"
            aria-label={`Open ${n.name}`}
            onClick={(e) => {
              e.stopPropagation();
              navigate({ section: "node", nodeId: n.id });
            }}
          >
            <KebabIcon size={14} />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Toolbar
        search={
          <input
            type="search"
            aria-label="Search nodes"
            placeholder="Search name, address, role…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        }
        filters={
          <CountedTabs
            tabs={railItems.filter((r) => r.key !== "running").map((r) => ({ key: r.key, label: r.label, count: r.count }))}
            active={rail}
            onSelect={setRail}
            ariaLabel="Node status filters"
            panelId="fleet-nodes"
          />
        }
        utilities={<DensityToggle dense={dense} onChange={setDense} />}
        primary={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {query ? (
              <button type="button" className="cp-link" onClick={() => setQuery("")}>
                Clear
              </button>
            ) : null}
            <button type="button" className="cp-btn primary" onClick={() => onAddCompute?.()}>
              + Add compute
            </button>
          </div>
        }
      />

      {nodes.length === 0 ? (
        <div className="cp-panel">
          <EmptyState
            icon={<NetworkIcon />}
            title="No compute nodes found"
            subtitle="Add a Spark or host to start observing your lab."
            action={
              <button type="button" className="cp-btn primary" onClick={() => onAddCompute?.()}>
                + Add compute
              </button>
            }
            learnMore={
              <button type="button" className="cp-link" onClick={() => navigate({ section: "settings" })}>
                Learn more
              </button>
            }
          />
        </div>
      ) : (
        <>
          <SectionBand icon={<NetworkIcon />} title="Compute nodes" count={rows.length} />
          {compact ? (
            <div className="cp-fleet-compact-note muted" style={{ fontSize: 12 }}>
              Compact representation — {nodes.length} nodes rendered data-driven; fleet size never implies parallelism degree.
            </div>
          ) : null}
          <div className="cp-fleet-layout">
            {/* Aggregate health rail — clicking a count filters the table */}
            <div className="cp-rail" aria-label="Fleet health rail">
              {railItems.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  className={`cp-rail-item ${r.tone} ${rail === r.key ? "is-active" : ""}`}
                  aria-pressed={rail === r.key}
                  onClick={() => setRail(r.key)}
                >
                  <StatusDot status={r.key === "offline" ? "offline" : "online"} />
                  <span>{r.label}</span>
                  <span className="cp-rail-count">{r.count}</span>
                </button>
              ))}
            </div>

            <div id="fleet-nodes">
              <DataTable
                ariaLabel="Compute nodes"
                dense={dense || compact}
                columns={columns}
                rows={rows}
                rowKey={(n) => n.id}
                rowClassName={(n) => (n.online ? "" : "is-offline")}
                onRowClick={(n) => navigate({ section: "node", nodeId: n.id })}
                empty={<div className="cp-table-empty-box">No nodes match this filter.</div>}
              />
            </div>
          </div>

          {nodes.length <= 4 && !compact ? (
            <div className="cp-panel">
              <div className="cp-panel-title">Topology</div>
              <Topology sparks={sparks} recipes={recipes} deployments={deployments} models={models} onNodeClick={(id) => navigate({ section: "node", nodeId: id })} />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
