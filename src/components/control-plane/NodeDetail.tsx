import { useEffect, useMemo, useState } from "react";
import type { SparkSnapshot, RecipePublic, DeploymentStatus } from "../../api/types";
import type { Route } from "../../hooks/router";
import { SparkPage } from "../SparkPage/SparkPage";
import { SparkTabs } from "../SparkTabs";
import { StatusPill, StatusDot, Chip, EmptyState } from "../ui/Status";
import { TabStrip } from "../ui/DataTable";
import { Breadcrumb } from "../ui/Breadcrumb";
import { PageHeader } from "../ui/PageHeader";
import { TimeSeriesChart, RangePicker, type Series } from "../ui/TimeSeriesChart";
import { useTimedMetricsHistory } from "../../hooks/metricsStore";
import { recipesOnNode, relativeAge, externalConnectView, runtimeLabel } from "./fleetModel";
import { LiveConsole } from "./LiveConsole";
import { ExternalConnectPanel } from "./ModelDetail";
import { DiscoveredRuntimes } from "./DiscoveredRuntimes";

interface NodeDetailProps {
  spark: SparkSnapshot;
  allSparks: SparkSnapshot[];
  recipes: readonly RecipePublic[];
  deployments: readonly DeploymentStatus[];
  temperatureUnit: "celsius" | "fahrenheit";
  benchShareImage?: boolean;
  navigate: (route: Route) => void;
  onEdit: () => void;
  onAddNode: () => void;
  /** Reload control-plane entities after a discovery adoption (config-only). */
  onSaved?: () => void;
}

const TABS = ["Overview", "GPUs", "Models", "Logs", "Settings"] as const;
type Tab = (typeof TABS)[number];

function copyText(text: string) {
  void navigator.clipboard?.writeText(text);
}

function fmtTempLabel(celsius: number, unit: "celsius" | "fahrenheit"): string {
  const v = unit === "fahrenheit" ? (celsius * 9) / 5 + 32 : celsius;
  return `${Math.round(v)}${unit === "fahrenheit" ? "°F" : "°C"}`;
}

/**
 * Node drill-down: breadcrumb + ownership header, underline tabs, an explicit
 * SSH-unreachable amber banner (never a blank pane), and an Overview with
 * big-number GPU/VRAM above a 2-col chart grid. Deeper GPU/资源 panels stay on
 * the proven SparkPage surface under the GPUs/Settings tabs.
 */
export function NodeDetail({
  spark,
  allSparks,
  recipes,
  deployments,
  temperatureUnit,
  benchShareImage,
  navigate,
  onEdit,
  onAddNode,
  onSaved = () => {},
}: NodeDetailProps) {
  const [tab, setTab] = useState<Tab>("Overview");
  const [windowMs, setWindowMs] = useState(30 * 60_000);
  const [now, setNow] = useState(() => Date.now());

  const onNode = useMemo(() => recipesOnNode(recipes, spark.id), [recipes, spark.id]);
  const deps = useMemo(() => deployments.filter((d) => d.nodeIds.includes(spark.id)), [deployments, spark.id]);

  const usage = useTimedMetricsHistory(spark.id, "gpu.usage");
  const temp = useTimedMetricsHistory(spark.id, "gpu.temp");

  const lastContactAt = usage.length ? usage[usage.length - 1].at : null;
  const freshness = lastContactAt ? relativeAge(lastContactAt, now) : "no samples yet";

  // Recompute relative freshness periodically.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const gpu = spark.metrics?.gpu;
  const vram = gpu?.vram;

  const vramViews = deps.filter((d) => d.managedBy === "external").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Breadcrumb
        items={[{ label: "Fleet", route: { section: "fleet" } }, { label: spark.name }]}
        navigate={navigate}
      />

      {/* Node header: host id + freshness; status and actions right-aligned */}
      <PageHeader
        title={spark.name}
        subtitle={`updated ${freshness}`}
        actions={
          <>
            <button type="button" className="cp-chip mono cp-host" title="Copy host address" onClick={() => copyText(spark.lanIp ?? spark.id)}>
              {spark.lanIp ?? spark.id}
              <span className="muted" aria-hidden="true">
                ⧉
              </span>
            </button>
            <StatusPill status={spark.online ? "online" : "offline"} />
            <button
              type="button"
              className="cp-btn ghost"
              disabled={!spark.online}
              title={spark.online ? "Edit node" : "Offline — last-known config shown; edits apply on next contact"}
              onClick={onEdit}
            >
              Edit
            </button>
          </>
        }
      />

      {/* SSH-unreachable = amber banner + last-contact time, never blank */}
      {!spark.online ? (
        <div className="cp-banner is-amber" role="status">
          <StatusDot status="offline" />
          <span>
            SSH unreachable — {spark.name} is offline. Last contact {freshness === "no samples yet" ? "unknown" : freshness}. Metrics below are last-known.
          </span>
        </div>
      ) : null}

      {/* Node sub-nav — proven tab strip, demoted from primary navigation */}
      <SparkTabs
        sparks={allSparks}
        activeId={spark.id}
        onSelect={(id) => navigate({ section: "node", nodeId: id })}
        onAdd={onAddNode}
        onEdit={() => onEdit()}
      />

      <TabStrip tabs={TABS} active={tab} onSelect={setTab} ariaLabel="Node sections" panelId="node-panel" />

      {tab === "Overview" ? (
        <div id="node-panel-Overview" role="tabpanel" aria-labelledby="node-panel-Overview-tab" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Discovered externally-launched runtimes on this node */}
          <DiscoveredRuntimes sparks={allSparks} nodeId={spark.id} recipes={recipes} onSaved={onSaved} />
          <div className="cp-panel">
            <div className="cp-panel-title">
              <span>Node health · last {windowMs / 60_000}m</span>
              <RangePicker value={windowMs} onChange={setWindowMs} />
            </div>
            <div className="cp-bignum-grid" style={{ marginBottom: 14 }}>
              <div className="cp-bignum">
                <span className="cp-bignum-label">GPU utilisation</span>
                <span className="cp-bignum-value">
                  {gpu ? Math.round(gpu.usage) : "—"}
                  {gpu ? <span className="cp-unit"> %</span> : null}
                </span>
                <span className="cp-bignum-sub">{spark.hardware?.gpuChip ?? "GPU"}</span>
              </div>
              <div className="cp-bignum">
                <span className="cp-bignum-label">VRAM</span>
                <span className="cp-bignum-value">
                  {vram && vram.total > 0 ? Math.round((vram.used / vram.total) * 100) : "—"}
                  {vram && vram.total > 0 ? <span className="cp-unit"> %</span> : null}
                </span>
                <span className="cp-bignum-sub">
                  {vram && vram.total > 0 ? `${Math.round(vram.used / 1024)} / ${Math.round(vram.total / 1024)} GB` : "No VRAM sensor"}
                </span>
              </div>
            </div>
            <div className="cp-chart-grid">
              <div className="cp-chart-cell">
                <div className="cp-metric-label">GPU utilisation %</div>
                <div className="cp-chart-body">
                  <TimeSeriesChart
                    series={[{ label: "GPU %", color: "var(--color-accent)", data: usage } as Series]}
                    windowMs={windowMs}
                    height={190}
                    emptyLabel="No GPU samples yet"
                  />
                </div>
              </div>
              <div className="cp-chart-cell">
                <div className="cp-metric-label">GPU temp {temperatureUnit === "fahrenheit" ? "°F" : "°C"}</div>
                <div className="cp-chart-body">
                  <TimeSeriesChart
                    series={[
                      {
                        label: "GPU temp",
                        color: "var(--color-info)",
                        data: temp,
                        format: (v) => fmtTempLabel(v, temperatureUnit),
                      } as Series,
                    ]}
                    windowMs={windowMs}
                    height={190}
                    emptyLabel="No temp samples yet"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="cp-panel" style={{ padding: "10px 14px" }}>
            <div className="cp-panel-title" style={{ margin: 0, marginBottom: 8 }}>
              Deployments on this node
            </div>
            {onNode.length === 0 ? (
              <span style={{ fontSize: 12, color: "var(--color-muted)" }}>
                None —{" "}
                <a
                  href="/models"
                  className="cp-alert-link"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate({ section: "models" });
                  }}
                >
                  assign a recipe
                </a>{" "}
                from a model page.
              </span>
            ) : (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {onNode.map((r) => {
                  const dep = deployments.find((d) => d.recipeId === r.id);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      className="cp-chip"
                      style={{ cursor: "pointer" }}
                      onClick={() => navigate({ section: "model", modelId: r.modelId })}
                      title={`${r.name} · ${r.runtime}`}
                    >
                      <span style={{ fontWeight: 600 }}>{r.modelId}</span>
                      <Chip>{r.runtime}</Chip>
                      {dep ? <StatusPill status={dep.display} /> : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {tab === "GPUs" ? (
        <div id="node-panel-GPUs" role="tabpanel" aria-labelledby="node-panel-GPUs-tab">
          <SparkPage spark={spark} temperatureUnit={temperatureUnit} benchShareImage={benchShareImage} onEdit={onEdit} />
        </div>
      ) : null}

      {tab === "Models" ? (
        <div id="node-panel-Models" role="tabpanel" aria-labelledby="node-panel-Models-tab" className="cp-panel">
          <div className="cp-panel-title">Deployments on {spark.name}</div>
          {deps.length === 0 ? (
            <EmptyState title="No deployments on this node" subtitle="Recipes targeting this node will appear here." />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {deps.map((d) => {
                const recipe = recipes.find((r) => r.id === d.recipeId) ?? null;
                const connect = recipe ? externalConnectView(d, recipe, [spark]) : null;
                return (
                  <div key={d.recipeId}>
                    <div
                      className="cp-deploy-row"
                      role="button"
                      tabIndex={0}
                      onClick={() => navigate({ section: "model", modelId: d.modelId })}
                      onKeyDown={(e) => e.key === "Enter" && navigate({ section: "model", modelId: d.modelId })}
                    >
                      <StatusPill status={d.display} className="cp-deploy-state" />
                      <div className="cp-deploy-model">
                        <span className="cp-deploy-name">{d.modelId}</span>
                        <span className="cp-deploy-id">{d.recipeId}</span>
                      </div>
                      <div className="cp-deploy-meta">
                        <Chip>{d.managedBy === "external" ? "external" : "managed"}</Chip>
                        {recipe ? <Chip tone="mono">{recipe.runtime}</Chip> : null}
                        {recipe ? <Chip>{recipe.topology}</Chip> : null}
                      </div>
                      <div className="cp-deploy-nodes">
                        <span className="cp-node-chip">
                          <StatusDot status={spark.online ? "online" : "offline"} />
                          {spark.name}
                        </span>
                      </div>
                      <div className="cp-deploy-right">
                        <span className="cp-deploy-port mono">:{d.apiPort}</span>
                      </div>
                      <div className="cp-row-actions">
                        <button
                          type="button"
                          className="cp-btn ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate({ section: "model", modelId: d.modelId, tab: "live-console" });
                          }}
                        >
                          View logs
                        </button>
                      </div>
                    </div>
                    {connect ? <ExternalConnectPanel connect={connect} recipe={recipe} /> : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      {tab === "Logs" ? (
        <div id="node-panel-Logs" role="tabpanel" aria-labelledby="node-panel-Logs-tab">
          {(() => {
            const logRecipe = onNode.find((r) => r.logDir) ?? null;
            return logRecipe ? (
              <LiveConsole recipeId={logRecipe.id} logDir={logRecipe.logDir} />
            ) : (
              <div className="cp-panel">
                <EmptyState title="No log directory" subtitle="Add a log directory to a recipe on this node to tail logs here." />
              </div>
            );
          })()}
        </div>
      ) : null}

      {tab === "Settings" ? (
        <div id="node-panel-Settings" role="tabpanel" aria-labelledby="node-panel-Settings-tab" className="cp-panel">
          <div className="cp-panel-title">
            Node settings
            <a
              href="/settings"
              className="cp-alert-link"
              onClick={(e) => {
                e.preventDefault();
                navigate({ section: "settings" });
              }}
            >
              Open Settings →
            </a>
          </div>
          <dl className="cp-kv">
            <dt>role</dt>
            <dd>{spark.role ?? "standalone"}</dd>
            <dt>kind</dt>
            <dd>{spark.kind ?? "spark"}</dd>
            <dt>host</dt>
            <dd className="mono">{spark.lanIp ?? "—"}</dd>
            <dt>llm ports</dt>
            <dd className="mono">{(spark.llmPorts || []).join(", ") || "—"}</dd>
            <dt>external deployments</dt>
            <dd>{vramViews}</dd>
          </dl>
        </div>
      ) : null}
    </div>
  );
}

/** Convenience: external connect panel for a deployment row in this node. */
export function nodeConnectPanel(view: { deployment: DeploymentStatus; nodes: SparkSnapshot[] } | null, recipe: RecipePublic | null) {
  if (!view || view.deployment.managedBy !== "external") return null;
  return (
    <ExternalConnectPanel
      connect={{
        endpoint: `http://${view.nodes[0]?.lanIp ?? view.deployment.nodeIds[0] ?? "localhost"}:${view.deployment.apiPort}/v1`,
        hasKey: !!recipe?.env.some((e) => e.secret && (e.hasValue ?? !!e.value)),
        nodeNames: view.nodes.map((n) => n.name),
        note: `Launched outside SparkDash — manage via ${runtimeLabel(recipe?.runtime)}`,
      }}
      recipe={recipe}
    />
  );
}
