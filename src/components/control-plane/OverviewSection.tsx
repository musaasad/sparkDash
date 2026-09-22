import { useMemo, useState } from "react";
import type { SparkSnapshot, DeploymentStatus, RecipePublic, ModelEntry, ActivityEvent } from "../../api/types";
import type { Route as AppRoute } from "../../hooks/router";
import { DataTable, sortRows, type Column } from "../ui/DataTable";
import { StatusPill, StatusDot, Chip, EmptyState, Skeleton } from "../ui/Status";
import {
  computeFleetHealth,
  computeFleetAlerts,
  allNodes,
  deploymentViews,
  deploymentsForNode,
  friendlyName,
  fmtUptime,
} from "./fleetModel";
import { Topology } from "./Topology";

interface OverviewProps {
  sparks: SparkSnapshot[];
  deployments: readonly DeploymentStatus[];
  recipes: readonly RecipePublic[];
  navigate: (route: AppRoute) => void;
  loaded: boolean;
  /** Optional model registry — friendly names; falls back to raw ids. */
  models?: ModelEntry[];
  /** Optional recent runtime activity for layer 3. */
  activity?: ActivityEvent[];
  /** Temp scale from settings; never implied. */
  temperatureUnit?: "celsius" | "fahrenheit";
}

function HealthCell({
  label,
  value,
  unit,
  meta,
  tone,
  muted,
}: {
  label: string;
  value: string | number;
  unit?: string;
  meta?: string;
  tone?: "warning";
  muted?: boolean;
}) {
  return (
    <div className="cp-health-cell">
      <span className="cp-health-label">{label}</span>
      <span className={`cp-health-value${tone === "warning" && Number(value) > 0 ? " is-warning" : ""}${muted ? " is-muted" : ""}`}>
        {value}
        {unit ? <span className="cp-health-unit"> {unit}</span> : null}
      </span>
      {meta ? <span className="cp-health-meta">{meta}</span> : null}
    </div>
  );
}

function fmtContext(ctx: number | null): string | null {
  if (!ctx) return null;
  if (ctx >= 1000) return `${Math.round(ctx / 1000)}k`;
  return String(ctx);
}

const RUNTIME_LABELS: Record<string, string> = {
  "tabbyapi-exl3": "TabbyAPI",
  vllm: "vLLM",
  sglang: "SGLang",
  "llama.cpp": "llama.cpp",
  custom: "custom",
};

export function OverviewSection({ sparks, deployments, recipes, navigate, loaded, models = [], activity = [], temperatureUnit = "celsius" }: OverviewProps) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const health = useMemo(() => computeFleetHealth(sparks, deployments), [sparks, deployments]);
  const alerts = useMemo(() => computeFleetAlerts(sparks, deployments, models), [sparks, deployments, models]);
  const views = useMemo(() => deploymentViews(sparks, deployments, recipes, models), [sparks, deployments, recipes, models]);
  const nodes = useMemo(() => allNodes(sparks), [sparks]);
  const columns = useMemo(() => COLUMNS(deployments, models, temperatureUnit), [deployments, models, temperatureUnit]);

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

  const recent = useMemo(() => activity.slice(0, 5), [activity]);

  if (!loaded && sparks.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Skeleton height={70} />
        <Skeleton height={120} />
        <Skeleton height={240} />
      </div>
    );
  }

  const offline = health.nodesTotal - health.nodesOnline;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div className="cp-section-title">Lab Overview</div>
        <div className="cp-section-sub">Operational summary — drill into Fleet and Models for detail.</div>
      </div>

      {/* Layer 1 — fleet health (throughput lives on deployment rows, not here) */}
      <div className="cp-health is-3">
        <HealthCell
          label="Nodes online"
          value={`${health.nodesOnline}/${health.nodesTotal}`}
          meta={offline > 0 ? `${offline} offline` : undefined}
        />
        <HealthCell
          label="Deployments"
          value={health.modelsRunning}
          unit="running"
          meta={
            health.modelsStopped > 0 || health.modelsError > 0
              ? `${health.modelsStopped + health.modelsError} not running`
              : health.modelsLoading > 0
                ? `${health.modelsLoading} loading`
                : undefined
          }
        />
        <HealthCell
          label="Active alerts"
          value={health.activeAlerts}
          tone="warning"
          meta={health.activeAlerts === 0 ? "all clear" : "needs attention"}
        />
      </div>

      {/* Attention */}
      {alerts.length > 0 ? (
        <div>
          <div className="cp-panel-title" style={{ marginBottom: 6 }}>
            Attention ({alerts.length})
          </div>
          <div className="cp-alerts">
            {alerts.slice(0, 8).map((a) => (
              <div key={a.id} className={`cp-alert ${a.severity === "error" ? "is-error" : a.severity === "info" ? "is-info" : ""}`}>
                <span className={`cp-dot ${a.severity === "error" ? "error" : a.severity === "warn" ? "warn" : "info"}`} />
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
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <StatusDot status="running" />
          <span style={{ fontSize: 12, color: "var(--color-muted)" }}>No active alerts — lab is healthy.</span>
        </div>
      )}

      {/* Layer 2 — deployments (hero) */}
      <div>
        <div className="cp-panel-title" style={{ marginBottom: 6 }}>
          <span>Deployments ({views.length})</span>
          <button type="button" className="cp-alert-link" onClick={() => navigate({ section: "models" })}>
            Models →
          </button>
        </div>
        {views.length === 0 ? (
          <div className="cp-table-empty">No deployments registered.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {views.map((v) => {
              const ctx = fmtContext(v.contextLength);
              const multi = v.nodes.length > 1;
              return (
                <div
                  key={v.deployment.recipeId}
                  className="cp-deploy-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate({ section: "model", modelId: v.deployment.modelId })}
                  onKeyDown={(e) => e.key === "Enter" && navigate({ section: "model", modelId: v.deployment.modelId })}
                >
                  <StatusPill status={v.deployment.state} className="cp-deploy-state" />

                  <div className="cp-deploy-model">
                    <span className="cp-deploy-name">{v.modelName}</span>
                    <span className="cp-deploy-id" title={v.rawModelId}>{v.rawModelId}</span>
                    {v.deployment.lastError ? <span className="cp-deploy-err">{v.deployment.lastError}</span> : null}
                  </div>

                  <div className="cp-deploy-meta">
                    <Chip>{RUNTIME_LABELS[v.runtime] ?? v.runtime}</Chip>
                    {v.topology !== "single" ? <Chip>{v.topology.toUpperCase()}</Chip> : <Chip>single</Chip>}
                    {ctx ? <Chip tone="mono">{ctx} ctx</Chip> : null}
                    {v.deployment.managedBy === "external" ? <Chip>external</Chip> : null}
                  </div>

                  <div className="cp-deploy-nodes">
                    {multi ? (
                      <div className="cp-node-cluster">
                        <span className="cp-node-cluster-label">{v.topology.toUpperCase()} · {v.nodes.length} nodes</span>
                        <span className="cp-node-cluster-chips">
                          {v.nodes.map((n) => (
                            <span key={n.id} className="cp-node-chip">
                              <StatusDot status={n.online ? "online" : "offline"} />
                              {n.name}
                              {n.role === "worker" ? <span className="cp-node-chip-role">worker</span> : null}
                            </span>
                          ))}
                        </span>
                      </div>
                    ) : (
                      <span className="cp-node-chip">
                        <StatusDot status={v.nodes[0]?.online ? "online" : "offline"} />
                        {v.nodes[0]?.name ?? v.deployment.nodeIds[0] ?? "—"}
                      </span>
                    )}
                  </div>

                  <div className="cp-deploy-right">
                    <span className={`cp-deploy-tps${v.decodeTps == null ? " is-idle" : ""}`}>
                      {v.decodeTps == null ? "—" : v.decodeTps}
                      {v.decodeTps != null ? <span className="cp-unit"> tok/s</span> : null}
                    </span>
                    <span className="cp-deploy-port mono">{v.port}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Layer 2 (visual) — topology, deployment enclosures */}
      {nodes.length > 0 && nodes.length <= 4 ? (
        <div>
          <div className="cp-panel-title">Topology</div>
          <Topology
            sparks={sparks}
            recipes={recipes}
            deployments={deployments}
            models={models}
            onNodeClick={(id) => navigate({ section: "node", nodeId: id })}
          />
        </div>
      ) : null}

      {/* Layer 3 — runtime activity */}
      <div>
        <div className="cp-panel-title" style={{ marginBottom: 6 }}>
          <span>Runtime activity</span>
          <button type="button" className="cp-alert-link" onClick={() => navigate({ section: "activity" })}>
            Activity →
          </button>
        </div>
        {recent.length === 0 ? (
          <EmptyState title="No runtime activity yet." />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {recent.map((e) => (
              <div key={e.seq} className="cp-activity-row">
                <Chip>{e.kind}</Chip>
                <span className="cp-activity-msg">{e.summary}</span>
                <span className="cp-activity-ts mono">{e.ts.slice(0, 19).replace("T", " ")}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Layer 4 — node telemetry */}
      <div>
        <div className="cp-panel-title" style={{ marginBottom: 6 }}>
          <span>Compute nodes ({nodes.length})</span>
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
    </div>
  );
}

function fmtTemp(celsius: number, unit: "celsius" | "fahrenheit"): string {
  const v = unit === "fahrenheit" ? (celsius * 9) / 5 + 32 : celsius;
  return String(Math.round(v));
}

function COLUMNS(
  deployments: readonly DeploymentStatus[],
  models: readonly ModelEntry[],
  temperatureUnit: "celsius" | "fahrenheit" = "celsius"
): Column<SparkSnapshot>[] {
  return [
    {
      key: "name",
      header: "Node",
      sortable: true,
      sortValue: (n) => n.name.toLowerCase(),
      render: (n) => (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <StatusDot status={n.online ? "online" : "offline"} />
          <span style={{ fontWeight: 500 }}>{n.name}</span>
          {n.role === "head" ? <Chip>head</Chip> : null}
          {n.role === "worker" ? <Chip>worker</Chip> : null}
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
      header: "GPU Util",
      align: "right",
      sortable: true,
      sortValue: (n) => n.metrics?.gpu?.usage ?? 0,
      render: (n) =>
        n.metrics?.gpu ? (
          <span>
            {Math.round(n.metrics.gpu.usage)}
            <span className="cp-unit"> %</span>
          </span>
        ) : (
          "—"
        ),
    },
    {
      key: "mem",
      header: "Memory Used",
      align: "right",
      sortable: true,
      sortValue: (n) => n.metrics?.unifiedMemory?.percentage ?? 0,
      render: (n) => {
        const um = n.metrics?.unifiedMemory;
        if (!um || um.total <= 0) return "—";
        // used/total are MB (collector convention, cf. RamPanel formatMb).
        return (
          <span title={`${Math.round(um.used / 1024)} / ${Math.round(um.total / 1024)} GB unified`}>
            {Math.round(um.percentage)}
            <span className="cp-unit"> %</span>
            <span className="cp-cell-sub"> · {Math.round(um.used / 1024)}/{Math.round(um.total / 1024)} GB</span>
          </span>
        );
      },
    },
    {
      key: "temp",
      header: "GPU Temp",
      align: "right",
      sortable: true,
      sortValue: (n) => n.metrics?.gpu?.temperature ?? 0,
      render: (n) =>
        n.metrics?.gpu ? (
          <span>
            {fmtTemp(n.metrics.gpu.temperature, temperatureUnit)}
            <span className="cp-unit"> {temperatureUnit === "fahrenheit" ? "°F" : "°C"}</span>
          </span>
        ) : (
          "—"
        ),
    },
    {
      key: "deployments",
      header: "Deployments",
      render: (n) => {
        const deps = deploymentsForNode(deployments, n.id);
        if (deps.length === 0) return <span className="muted">—</span>;
        return (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {deps.map((d) => (
              <StatusPill key={d.recipeId} status={d.state} label={friendlyName(d.modelId, models)} title={d.modelId} />
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
