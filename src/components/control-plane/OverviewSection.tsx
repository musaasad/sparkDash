import { useMemo, useState } from "react";
import type { SparkSnapshot, DeploymentStatus, RecipePublic } from "../../api/types";
import type { Route as AppRoute } from "../../hooks/router";
import { DataTable, sortRows, type Column } from "../ui/DataTable";
import { StatusPill, Chip, Skeleton } from "../ui/Status";
import {
  computeFleetHealth,
  computeFleetAlerts,
  primaryNodes,
  recipesOnNode,
  fmtUptime,
} from "./fleetModel";
import { Topology } from "./Topology";

interface OverviewProps {
  sparks: SparkSnapshot[];
  deployments: readonly DeploymentStatus[];
  recipes: readonly RecipePublic[];
  navigate: (route: AppRoute) => void;
  loaded: boolean;
}

function HealthCell({ label, value, unit, meta }: { label: string; value: string | number; unit?: string; meta?: string }) {
  return (
    <div className="cp-health-cell">
      <span className="cp-health-label">{label}</span>
      <span className="cp-health-value">
        {value}
        {unit ? <span className="cp-health-unit"> {unit}</span> : null}
      </span>
      {meta ? <span className="cp-health-meta">{meta}</span> : null}
    </div>
  );
}

export function OverviewSection({ sparks, deployments, recipes, navigate, loaded }: OverviewProps) {
  const [sortKey, setSortKey] = useState<string | null>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const health = useMemo(() => computeFleetHealth(sparks, deployments), [sparks, deployments]);
  const alerts = useMemo(() => computeFleetAlerts(sparks, deployments), [sparks, deployments]);
  const nodes = useMemo(() => primaryNodes(sparks), [sparks]);
  const columns = useMemo(() => COLUMNS(recipes, deployments), [recipes, deployments]);

  const rows = useMemo(() => {
    const col = columns.find((c) => c.key === sortKey);
    return sortRows(nodes, col, sortDir);
  }, [nodes, columns, sortKey, sortDir]);

  const onSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  if (!loaded && sparks.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Skeleton height={70} />
        <Skeleton height={120} />
        <Skeleton height={240} />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div className="cp-section-title">Lab Overview</div>
        <div className="cp-section-sub">Operational summary — drill into Fleet and Models for detail.</div>
      </div>

      {/* Health strip */}
      <div className="cp-health">
        <HealthCell
          label="Nodes online"
          value={`${health.nodesOnline}/${health.nodesTotal}`}
          meta={health.nodesOnline < health.nodesTotal ? "some nodes offline" : "all nodes up"}
        />
        <HealthCell
          label="Models"
          value={health.modelsRunning}
          unit="running"
          meta={health.modelsLoading > 0 ? `${health.modelsLoading} loading` : "none loading"}
        />
        <HealthCell
          label="Active alerts"
          value={health.activeAlerts}
          meta={health.activeAlerts === 0 ? "all clear" : "needs attention"}
        />
        <HealthCell
          label="Fleet throughput"
          value={health.fleetDecodeTps}
          unit="tok/s"
          meta="aggregate decode"
        />
      </div>

      {/* Exceptions-first */}
      {alerts.length > 0 ? (
        <div>
          <div className="cp-panel-title" style={{ marginBottom: 6 }}>
            Attention ({alerts.length})
          </div>
          <div className="cp-alerts" style={{ borderRadius: 10, overflow: "hidden", border: "1px solid var(--color-border)" }}>
            {alerts.slice(0, 8).map((a) => (
              <div key={a.id} className={`cp-alert ${a.severity === "error" ? "is-error" : a.severity === "info" ? "is-info" : ""}`}>
                <span className={`cp-dot ${a.severity === "error" ? "error" : "stopping"}`} />
                <span className="cp-alert-msg">{a.message}</span>
                {a.target ? (
                  <button type="button" className="cp-alert-link" onClick={() => navigate(a.target as AppRoute)}>
                    View →
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="cp-panel" style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 8 }}>
          <span className="cp-dot running" />
          <span style={{ fontSize: 12, color: "var(--color-muted)" }}>No active alerts — lab is healthy.</span>
        </div>
      )}

      {/* Fleet table */}
      <div>
        <div className="cp-panel-title" style={{ marginBottom: 6 }}>
          <span>Compute nodes</span>
          <button type="button" className="cp-alert-link" onClick={() => navigate({ section: "fleet" })}>
            Fleet →
          </button>
        </div>
        <DataTable
          ariaLabel="Compute nodes"
          columns={columns}
          rows={rows}
          rowKey={(n) => n.id}
          onRowClick={(n) => navigate({ section: "node", nodeId: n.id })}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          empty={<div className="cp-table-empty">No compute nodes registered.</div>}
        />
      </div>

      {/* Topology */}
      {nodes.length > 0 && nodes.length <= 4 ? (
        <div className="cp-panel">
          <div className="cp-panel-title">Topology</div>
          <Topology sparks={sparks} recipes={recipes} deployments={deployments} onNodeClick={(id) => navigate({ section: "node", nodeId: id })} />
        </div>
      ) : null}
    </div>
  );
}

function COLUMNS(recipes: readonly RecipePublic[], deployments: readonly DeploymentStatus[]): Column<SparkSnapshot>[] {
  const modelsForNode = (nodeId: string) => {
    const onNode = recipesOnNode(recipes, nodeId);
    return onNode.map((r) => {
      const dep = deployments.find((d) => d.recipeId === r.id);
      return { recipe: r, state: dep?.state };
    });
  };
  return [
    {
      key: "name",
      header: "Node",
      sortable: true,
      sortValue: (n) => n.name.toLowerCase(),
      render: (n) => (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className={`cp-dot ${n.online ? "running" : "stopped"}`} />
          <span style={{ fontWeight: 500 }}>{n.name}</span>
          {n.role === "head" ? <Chip tone="accent">head</Chip> : null}
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      sortable: true,
      sortValue: (n) => (n.online ? 1 : 0),
      render: (n) => <StatusPill status={n.online ? "online" : "offline"} />,
    },
    {
      key: "gpu",
      header: "GPU",
      align: "right",
      sortable: true,
      sortValue: (n) => n.metrics?.gpu?.usage ?? 0,
      render: (n) => (n.metrics?.gpu ? `${Math.round(n.metrics.gpu.usage)}%` : "—"),
    },
    {
      key: "mem",
      header: "Memory",
      align: "right",
      sortable: true,
      sortValue: (n) => n.metrics?.unifiedMemory?.percentage ?? 0,
      render: (n) => {
        const um = n.metrics?.unifiedMemory;
        if (!um || um.total <= 0) return "—";
        return (
          <span title={`${Math.round(um.used)} / ${Math.round(um.total)} GB`}>
            {Math.round(um.percentage)}%
          </span>
        );
      },
    },
    {
      key: "temp",
      header: "Temp",
      align: "right",
      sortable: true,
      sortValue: (n) => n.metrics?.gpu?.temperature ?? 0,
      render: (n) => (n.metrics?.gpu ? `${Math.round(n.metrics.gpu.temperature)}°` : "—"),
    },
    {
      key: "models",
      header: "Models",
      render: (n) => {
        const models = modelsForNode(n.id);
        if (models.length === 0) return <span className="muted">—</span>;
        return (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {models.map((m) => (
              <StatusPill
                key={m.recipe.id}
                status={(m.state ?? "available") as never}
                label={m.recipe.modelId}
              />
            ))}
          </div>
        );
      },
    },
    {
      key: "uptime",
      header: "Uptime",
      align: "right",
      muted: true,
      sortable: true,
      sortValue: (n) => n.uptime ?? 0,
      render: (n) => fmtUptime(n.uptime),
    },
  ];
}