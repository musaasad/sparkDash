import { useEffect, useMemo, useState } from "react";
import type { SparkSnapshot, DeploymentStatus, RecipePublic, ModelEntry, ActivityEvent } from "../../api/types";
import type { Route as AppRoute } from "../../hooks/router";
import { DataTable, sortRows, type Column } from "../ui/DataTable";
import { StatusPill, StatusDot, Chip, EmptyState, Skeleton } from "../ui/Status";
import { SectionBand } from "../ui/SectionBand";
import { ActivityIcon, BotIcon, CheckIcon, NetworkIcon, PanelIcon } from "../ui/icons";
import { relativeTs, absoluteTs } from "./activityModel";
import {
  computeFleetHealth,
  attentionDigest,
  allNodes,
  deploymentViews,
  deploymentsForNode,
  friendlyName,
  fmtUptime,
  relativeAge,
  runtimeLabel,
} from "./fleetModel";
import { Topology } from "./Topology";
import { useRuntimeLabels } from "./runtimeLabels";

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

const WINDOWS = [
  { key: 15 * 60_000, label: "Last 15m" },
  { key: 60 * 60_000, label: "Last 1h" },
  { key: 24 * 60 * 60_000, label: "Last 24h" },
] as const;

function WindowPicker({ value, onChange, ariaLabel }: { value: number; onChange: (v: number) => void; ariaLabel: string }) {
  return (
    <div className="cp-activity-windows" role="group" aria-label={ariaLabel}>
      {WINDOWS.map((w) => (
        <button
          key={w.key}
          type="button"
          className={`cp-activity-window${value === w.key ? " is-active" : ""}`}
          aria-pressed={value === w.key}
          onClick={() => onChange(w.key)}
        >
          {w.label}
        </button>
      ))}
    </div>
  );
}



export function OverviewSection({ sparks, deployments, recipes, navigate, loaded, models = [], activity = [], temperatureUnit = "celsius" }: OverviewProps) {
  const runtimeLabels = useRuntimeLabels();
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [lastUpdated, setLastUpdated] = useState(() => Date.now());
  const [depWindow, setDepWindow] = useState<number>(WINDOWS[0].key);
  const [nodeWindow, setNodeWindow] = useState<number>(WINDOWS[0].key);
  const [activityWindow, setActivityWindow] = useState<number>(WINDOWS[0].key);

  const health = useMemo(() => computeFleetHealth(sparks, deployments), [sparks, deployments]);
  const attention = useMemo(() => attentionDigest(sparks, deployments, models), [sparks, deployments, models]);
  const views = useMemo(() => deploymentViews(sparks, deployments, recipes, models), [sparks, deployments, recipes, models]);
  const nodes = useMemo(() => allNodes(sparks), [sparks]);
  const columns = useMemo(() => COLUMNS(deployments, models, temperatureUnit), [deployments, models, temperatureUnit]);

  // Last-updated stamp + periodic relative refresh.
  useEffect(() => {
    setLastUpdated(Date.now());
  }, [sparks, deployments]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  /** Latest activity ts attributed to a node — the per-section window proxy. */
  const lastSeenAt = (id: string) =>
    activity.reduce((m, e) => (e.subject === id ? Math.max(m, Date.parse(e.ts)) : m), 0);

  const windowedViews = useMemo(() => {
    const cutoff = now - depWindow;
    return views.filter((v) => !v.deployment.updatedAt || v.deployment.updatedAt >= cutoff);
  }, [views, now, depWindow]);

  const windowedNodes = useMemo(() => {
    const cutoff = now - nodeWindow;
    return nodes.filter((n) => n.online || lastSeenAt(n.id) === 0 || lastSeenAt(n.id) >= cutoff);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, now, nodeWindow, activity]);

  const recent = useMemo(() => {
    const cutoff = now - activityWindow;
    return activity.filter((e) => Date.parse(e.ts) >= cutoff).slice(0, 5);
  }, [activity, now, activityWindow]);

  const rows = useMemo(() => {
    const col = columns.find((c) => c.key === sortKey);
    return sortRows(windowedNodes, col, sortDir);
  }, [windowedNodes, columns, sortKey, sortDir]);

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

  const offline = health.nodesTotal - health.nodesOnline;

  // Spec §7/§8: getting-started checklist layer while the lab is fresh.
  const fresh = sparks.length === 0 && deployments.length === 0 && models.length === 0 && recipes.length === 0;
  const GET_STARTED = [
    { label: "Register a model", done: models.length > 0, past: "Model registered", route: { section: "models" } as AppRoute },
    { label: "Author a recipe", done: recipes.length > 0, past: "Recipe authored", route: { section: "models" } as AppRoute },
    { label: "Create a deployment", done: deployments.length > 0, past: "Deployment created", route: { section: "models" } as AppRoute },
    { label: "Connect a node", done: sparks.length > 0, past: "Node connected", route: { section: "fleet" } as AppRoute },
  ];
  const doneCount = GET_STARTED.filter((s) => s.done).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {fresh ? (
        <div className="cp-getstarted">
          <div className="cp-getstarted-overline">LET&apos;S GET STARTED</div>
          <div className="cp-getstarted-head">
            <h2 className="cp-getstarted-title">Bring your first model online</h2>
            <span className="cp-getstarted-count">{doneCount}/{GET_STARTED.length}</span>
          </div>
          <div className="cp-getstarted-cards">
            {GET_STARTED.map((s) => (
              <button
                key={s.label}
                type="button"
                className={`cp-getstarted-card${s.done ? " is-done" : ""}`}
                onClick={() => navigate(s.route)}
              >
                <span className="cp-getstarted-check" aria-hidden="true">
                  {s.done ? <CheckIcon size={14} /> : null}
                </span>
                <span className="cp-getstarted-card-title">{s.done ? s.past : s.label}</span>
                <span className="cp-getstarted-arrow" aria-hidden="true">↗</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {/* Health verdict + last-updated + auto-refresh toggle */}
      <div className={`cp-verdict${attention.length > 0 ? " is-warn" : ""}`} role="status">
        <span className={`cp-dot ${attention.length > 0 ? "warn" : "running"}`} aria-hidden="true" />
        <div>
          <div className="cp-verdict-text">
            {attention.length === 0
              ? "All systems normal"
              : `${attention.length} issue${attention.length === 1 ? "" : "s"} need${attention.length === 1 ? "s" : ""} attention`}
          </div>
          <div className="cp-verdict-meta">
            updated {relativeAge(lastUpdated, now)} · auto-refresh {autoRefresh ? "on" : "paused"}
          </div>
        </div>
        <div className="cp-verdict-right">
          <button
            type="button"
            className={`cp-btn ghost${autoRefresh ? " is-active" : ""}`}
            aria-pressed={autoRefresh}
            onClick={() => setAutoRefresh((v) => !v)}
          >
            {autoRefresh ? "Auto-refresh on" : "Auto-refresh off"}
          </button>
        </div>
      </div>

      {/* Layer 1 — fleet health (throughput lives on deployment rows, not here) */}
      <div className="cp-health is-3">
        <HealthCell
          label="Nodes online"
          value={`${health.nodesOnline}/${health.nodesTotal}`}
          meta={offline > 0 ? `${offline} offline · last 15m` : "last 15m"}
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
                : "steady"
          }
        />
        <HealthCell
          label="Active alerts"
          value={health.activeAlerts}
          tone="warning"
          meta={health.activeAlerts === 0 ? "all clear" : "needs attention"}
        />
      </div>

      {/* Attention digest — deduped by condition+resource with ×N badges */}
      {attention.length > 0 ? (
        <div className="cp-section-block">
          <SectionBand icon={<PanelIcon />} title="Attention" count={attention.length} />
          <div className="cp-alerts">
            {attention.slice(0, 8).map((a) => (
              <div key={a.id} className={`cp-alert ${a.severity === "error" ? "is-error" : a.severity === "info" ? "is-info" : ""}`}>
                <span className={`cp-dot ${a.severity === "error" ? "error" : a.severity === "warn" ? "warn" : "info"}`} />
                <span className="cp-alert-msg">{a.message}</span>
                {a.count > 1 ? <Chip>×{a.count}</Chip> : null}
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
      <div className="cp-section-block">
        <SectionBand
          icon={<BotIcon />}
          title="Deployments"
          count={windowedViews.length}
          local={<WindowPicker value={depWindow} onChange={setDepWindow} ariaLabel="Deployment window" />}
          actions={
            <button type="button" className="cp-alert-link" onClick={() => navigate({ section: "models" })}>
              Models →
            </button>
          }
        />
        {windowedViews.length === 0 ? (
          <div className="cp-table-empty">No deployments registered in this window.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {windowedViews.map((v) => {
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
                  <StatusPill status={v.deployment.display} className="cp-deploy-state" />

                  <div className="cp-deploy-model">
                    <span className="cp-deploy-name">{v.modelName}</span>
                    <span className="cp-deploy-id" title={v.rawModelId}>{v.rawModelId}</span>
                    {v.deployment.lastError ? <span className="cp-deploy-err">{v.deployment.lastError}</span> : null}
                  </div>

                  <div className="cp-deploy-meta">
                    <Chip>{runtimeLabel(v.runtime, runtimeLabels)}</Chip>
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
        <div className="cp-section-block">
          <SectionBand icon={<NetworkIcon />} title="Topology" />
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
      <div className="cp-section-block">
        <SectionBand
          icon={<ActivityIcon />}
          title="Runtime activity"
          count={recent.length}
          local={<WindowPicker value={activityWindow} onChange={setActivityWindow} ariaLabel="Activity window" />}
          actions={
            <button type="button" className="cp-alert-link" onClick={() => navigate({ section: "activity" })}>
              Activity →
            </button>
          }
        />
        {recent.length === 0 ? (
          <EmptyState title="No runtime activity in this window." />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {recent.map((e) => (
              <div key={e.seq} className="cp-activity-row">
                <Chip>{e.kind}</Chip>
                <span className="cp-activity-msg">{e.summary}</span>
                <span className="cp-activity-ts mono" title={absoluteTs(e.ts)}>
                  {relativeTs(e.ts)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Layer 4 — node telemetry */}
      <div className="cp-section-block">
        <SectionBand
          icon={<NetworkIcon />}
          title="Compute nodes"
          count={rows.length}
          local={<WindowPicker value={nodeWindow} onChange={setNodeWindow} ariaLabel="Node window" />}
          actions={
            <button type="button" className="cp-alert-link" onClick={() => navigate({ section: "fleet" })}>
              Fleet →
            </button>
          }
        />
        <DataTable
          ariaLabel="Compute nodes"
          columns={columns}
          rows={rows}
          rowKey={(n) => n.id}
          onRowClick={(n) => navigate({ section: "node", nodeId: n.id })}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          rowClassName={(n) => (n.online ? "" : "is-offline")}
          empty={<div className="cp-table-empty-box">No compute nodes registered in this window.</div>}
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
          <span className="cp-nodata">—</span>
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
        if (!um || um.total <= 0) return <span className="cp-nodata">—</span>;
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
          <span className={n.metrics.gpu.temperature > 85 ? "cp-over" : undefined}>
            {fmtTemp(n.metrics.gpu.temperature, temperatureUnit)}
            <span className="cp-unit"> {temperatureUnit === "fahrenheit" ? "°F" : "°C"}</span>
          </span>
        ) : (
          <span className="cp-nodata">—</span>
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
              <StatusPill key={d.recipeId} status={d.display} label={friendlyName(d.modelId, models)} title={d.modelId} />
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
