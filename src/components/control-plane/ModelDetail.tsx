import { useEffect, useMemo, useState } from "react";
import type { ModelEntry, RecipePublic, DeploymentStatus, SparkSnapshot } from "../../api/types";
import type { Route } from "../../hooks/router";
import {
  fetchModel,
  archiveModel,
  archiveRecipe,
  restoreModel,
  restoreRecipe,
  duplicateRecipe,
  validateRecipe,
  recipeLifecycle,
  createDeployment,
  deleteDeployment,
  listDecodeBench,
  fetchActivity,
} from "../../api/client";
import { useDeployments } from "../../hooks/domainStore";
import { StatusPill, Chip, EmptyState, LifecycleBadge, StatusDot } from "../ui/Status";
import { Modal } from "../ui/Modal";
import { TabStrip, CopyId } from "../ui/DataTable";
import { Breadcrumb } from "../ui/Breadcrumb";
import { KebabIcon, ExternalManagedIcon, CopyIcon } from "../ui/icons";
import { PageHeader } from "../ui/PageHeader";
import { Field, TextInput, TextArea } from "../ui/form";
import { RecipeEditor } from "./RecipeEditor";
import { DeployControls } from "./DeployControls";
import { LiveConsole } from "./LiveConsole";
import { TimeSeriesChart, RangePicker, type Series } from "../ui/TimeSeriesChart";
import { useTimedMetricsHistory } from "../../hooks/metricsStore";
import { externalConnectView, runtimeLabel, type ExternalConnect } from "./fleetModel";
import { useRuntimeLabels, useRuntimeOptions } from "./runtimeLabels";

const TABS = ["Overview", "Recipes", "Deployments", "Live Console", "Benchmarks"] as const;
type Tab = (typeof TABS)[number];

function copyText(text: string) {
  void navigator.clipboard?.writeText(text);
}

/**
 * Read-only connect panel for an externally launched runtime (the never-touch
 * Qwen/TabbyAPI process): copyable endpoint, masked key + show toggle when a
 * key exists, muted manage-elsewhere note and DISABLED lifecycle with tooltip.
 */
export function ExternalConnectPanel({ connect, recipe }: { connect: ExternalConnect; recipe: RecipePublic | null }) {
  const [showKey, setShowKey] = useState(false);
  const hasKey = connect.hasKey;
  const hint = connect.keyHint ?? "••••••••••••";
  const masked = hasKey ? (showKey ? `${connect.keyName ?? "API key"} · value stored in the node's secret store` : hint) : null;
  const runtime = runtimeLabel(recipe?.runtime, useRuntimeLabels());
  return (
    <div className="cp-connect" style={{ marginTop: 6 }}>
      <div className="cp-connect-row">
        <span className="cp-connect-label">Endpoint</span>
        <span className="cp-connect-val" title={connect.endpoint}>
          {connect.endpoint}
        </span>
        <div className="cp-connect-actions">
          <button type="button" className="cp-btn ghost" onClick={() => copyText(connect.endpoint)}>
            Copy
          </button>
        </div>
      </div>
      {masked ? (
        <div className="cp-connect-row">
          <span className="cp-connect-label">API key</span>
          <button
            type="button"
            className="cp-id"
            title={`${hint} — click to copy the masked hint`}
            onClick={() => copyText(hint)}
          >
            <span className="cp-id-text mono">{masked}</span>
            <span className="cp-id-copy" aria-hidden="true">
              <CopyIcon size={12} />
            </span>
          </button>
          <div className="cp-connect-actions">
            <button type="button" className="cp-btn ghost" onClick={() => setShowKey((s) => !s)} aria-pressed={showKey}>
              {showKey ? "Hide" : "Show"}
            </button>
          </div>
        </div>
      ) : null}
      <div className="cp-connect-row">
        <span className="cp-connect-note"><ExternalManagedIcon size={12} /> {connect.note}</span>
        <div className="cp-connect-actions">
          <button type="button" className="cp-btn" disabled title={`Externally managed — manage via ${runtime}`}>
            Stop
          </button>
          <button type="button" className="cp-btn" disabled title={`Externally managed — manage via ${runtime}`}>
            Restart
          </button>
        </div>
      </div>
      {connect.nodeNames.length ? (
        <div className="cp-connect-row">
          <span className="cp-connect-label">Nodes</span>
          <span className="muted" style={{ fontSize: 11 }}>
            {connect.nodeNames.join(", ")}
          </span>
          <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>
            recipe {recipe?.id ?? "—"}
          </span>
        </div>
      ) : null}
    </div>
  );
}

interface ModelDetailProps {
  modelId: string;
  initialTab?: string;
  /** Deep-link reqId to pre-seed the Live Console query. */
  initialReqId?: number;
  sparks: SparkSnapshot[];
  navigate: (route: Route) => void;
  onDataChanged: () => void;
}

export function ModelDetail({ modelId, initialTab, initialReqId, sparks, navigate, onDataChanged }: ModelDetailProps) {
  const [model, setModel] = useState<ModelEntry | null>(null);
  const [recipes, setRecipes] = useState<RecipePublic[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(normalizeTab(initialTab));
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const runtimeLabels = useRuntimeLabels();
  const runtimes = useRuntimeOptions();
  const deployments = useDeployments();

  const load = async () => {
    try {
      const res = await fetchModel(modelId);
      setModel(res.model);
      setRecipes(res.recipes);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId]);

  const deps = useMemo(() => deployments.filter((d) => d.modelId === modelId), [deployments, modelId]);
  const primaryRecipe = recipes.find((r) => !r.archived) ?? null;
  const primaryDep = deps.find((d) => d.recipeId === primaryRecipe?.id) ?? deps[0];
  const liveRecipes = useMemo(() => recipes.filter((r) => !r.archived), [recipes]);

  if (error && !model) {
    return (
      <div className="cp-panel">
        <EmptyState
          title="Model not found"
          subtitle={error}
          action={
            <button type="button" className="cp-btn" onClick={() => navigate({ section: "models" })}>
              ← All models
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Breadcrumb
        items={[{ label: "Models", route: { section: "models" } }, { label: model?.name ?? modelId }]}
        navigate={navigate}
      />

      <PageHeader
        title={model?.name ?? "…"}
        subtitle={model?.family ? `${model.family} · ${modelId}` : modelId}
        actions={
          <>
            {model?.archived ? <Chip>archived · weights kept</Chip> : null}
            {primaryDep ? <StatusPill status={primaryDep.display} /> : <Chip>not deployed</Chip>}
          </>
        }
        overflow={
          <>
            {model?.archived ? (
              <button
                type="button"
                className="cp-btn ghost"
                onClick={async () => {
                  try {
                    await restoreModel(modelId);
                    await load();
                    onDataChanged();
                  } catch (err) {
                    setArchiveError(err instanceof Error ? err.message : String(err));
                  }
                }}
              >
                Restore model
              </button>
            ) : (
              <button type="button" className="cp-btn ghost danger" onClick={() => setArchiveOpen(true)}>
                Archive model
              </button>
            )}
            <button type="button" className="cp-btn ghost" disabled title="Destructive storage deletion is a separate future action">
              Delete weights
            </button>
          </>
        }
      />

      <TabStrip tabs={TABS} active={tab} onSelect={setTab} ariaLabel="Model sections" panelId="model-panel" />

      {/* Overview: deployment summary + folded History */}
      {tab === "Overview" ? (
        <div id="model-panel-Overview" role="tabpanel" aria-labelledby="model-panel-Overview-tab" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <OverviewTab model={model} recipes={recipes} deps={deps} sparks={sparks} onDeployChanged={() => { void load(); onDataChanged(); }} />
          <HistoryTab modelId={modelId} />
        </div>
      ) : null}

      {/* Recipes — first-class assets + folded read-only Configuration */}
      {tab === "Recipes" ? (
        <div id="model-panel-Recipes" role="tabpanel" aria-labelledby="model-panel-Recipes-tab" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <RecipesTab
            recipes={recipes}
            sparks={sparks}
            runtimes={runtimes}
            modelId={modelId}
            navigate={navigate}
            onChanged={() => {
              void load();
              onDataChanged();
            }}
          />
          <ConfigTab model={model} recipe={primaryRecipe} />
        </div>
      ) : null}

      {/* Deployments — WS-1 bindings for this model's recipes */}
      {tab === "Deployments" ? (
        <div id="model-panel-Deployments" role="tabpanel" aria-labelledby="model-panel-Deployments-tab">
          <DeploymentsTab deps={deps} recipes={recipes} sparks={sparks} navigate={navigate} onChanged={() => { void load(); onDataChanged(); }} />
        </div>
      ) : null}

      {tab === "Live Console" ? (
        <div id="model-panel-Live Console" role="tabpanel" aria-labelledby="model-panel-Live Console-tab">
          {primaryRecipe ? (
            <LiveConsole recipeId={primaryRecipe.id} logDir={primaryRecipe.logDir} initialReqId={initialReqId} />
          ) : (
            <div className="cp-panel">
              <EmptyState title="No recipe" subtitle="Add a deployment recipe with a log directory to enable the Live Console." />
            </div>
          )}
        </div>
      ) : null}

      {/* Benchmarks + folded Performance */}
      {tab === "Benchmarks" ? (
        <div id="model-panel-Benchmarks" role="tabpanel" aria-labelledby="model-panel-Benchmarks-tab" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <PerformanceTab sparks={sparks} recipe={primaryRecipe} />
          <BenchmarksTab recipes={liveRecipes} sparks={sparks} navigate={navigate} />
        </div>
      ) : null}

      <Modal
        open={archiveOpen}
        title={`Archive model "${model?.name ?? modelId}"?`}
        consequence="Sets the archived flag so the model leaves active lists. WEIGHTS ARE NEVER DELETED — files stay exactly where they are."
        info="Archived models cannot back new deployments. Restore clears the flag."
        confirmLabel="Archive model"
        tone="danger"
        busy={archiveBusy}
        onClose={() => setArchiveOpen(false)}
        onConfirm={async () => {
          setArchiveBusy(true);
          setArchiveError(null);
          try {
            await archiveModel(modelId);
            setArchiveOpen(false);
            await load();
            onDataChanged();
          } catch (err) {
            setArchiveError(err instanceof Error ? err.message : String(err));
          } finally {
            setArchiveBusy(false);
          }
        }}
      >
        <div className="cp-kv">
          <dt>recipes kept</dt>
          <dd>{recipes.length}</dd>
          <dt>deployments kept</dt>
          <dd>{deps.length}</dd>
          <dt>weight files</dt>
          <dd className="mono">untouched</dd>
          {recipes.length || deps.length ? (
            <>
              <dt>hard delete</dt>
              <dd>blocked while referenced — archive instead (WS-1 rule)</dd>
            </>
          ) : null}
        </div>
        {archiveError ? (
          <div className="cp-field-error" role="alert">
            {archiveError}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function normalizeTab(t?: string): Tab {
  if (!t) return "Overview";
  // Legacy deep links fold into the spec's tab set:
  // Performance→Benchmarks, Configuration→Recipes, History→Overview.
  const alias: Record<string, Tab> = { performance: "Benchmarks", configuration: "Recipes", history: "Overview" };
  const key = t.toLowerCase();
  if (alias[key]) return alias[key];
  const hit = TABS.find((x) => x.toLowerCase() === key || x.toLowerCase().replace(" ", "-") === key);
  return hit ?? "Overview";
}

// ─── Overview tab ─────────────────────────────────────────
function OverviewTab({
  model,
  recipes,
  deps,
  sparks,
  onDeployChanged,
}: {
  model: ModelEntry | null;
  recipes: RecipePublic[];
  deps: DeploymentStatus[];
  sparks: SparkSnapshot[];
  onDeployChanged: () => void;
}) {
  const primary = recipes.find((r) => !r.archived) ?? null;
  const runtimeLabels = useRuntimeLabels();
  const dep = deps.find((d) => d.recipeId === primary?.id);
  const nodeNames = (primary?.nodeIds || []).map((id) => sparks.find((s) => s.id === id)?.name || id);
  const connect = dep && primary ? externalConnectView(dep, primary, sparks, runtimeLabels) : null;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
      <div className="cp-panel">
        <div className="cp-panel-title">Deployment</div>
        {primary ? (
          <>
            <dl className="cp-kv">
              <dt>Recipe</dt>
              <dd>{primary.name}</dd>
              <dt>Runtime</dt>
              <dd>{runtimeLabel(primary.engine?.runtime ?? primary.runtime, runtimeLabels)}</dd>
              <dt>Topology</dt>
              <dd>
                {primary.topologyBlock?.mode ?? primary.topology}
                {primary.topologyBlock?.mode && primary.topologyBlock.mode !== "single" ? `×${primary.topologyBlock.parallelism}` : ""}
              </dd>
              <dt>Nodes</dt>
              <dd>{nodeNames.join(", ") || "—"}</dd>
              <dt>API port</dt>
              <dd>{primary.endpoint?.port ?? primary.apiPort}</dd>
              <dt>Context</dt>
              <dd>{primary.serving?.contextLength != null ? primary.serving.contextLength.toLocaleString() : "—"}</dd>
            </dl>
            {connect ? <ExternalConnectPanel connect={connect} recipe={primary} /> : null}
            <div style={{ marginTop: 14 }}>
              <DeployControls recipe={primary} deployment={dep} onUpdated={onDeployChanged} />
            </div>
          </>
        ) : (
          <EmptyState title="No deployment recipe" subtitle="Open the Recipes tab to create one for this model." />
        )}
      </div>
      <div className="cp-panel">
        <div className="cp-panel-title">Notes</div>
        <p style={{ fontSize: 12, color: "var(--color-text)", lineHeight: 1.6, margin: 0 }}>
          {model?.notes || "No notes."}
        </p>
        {recipes.length > 1 ? (
          <>
            <div className="cp-panel-title" style={{ marginTop: 16 }}>
              All recipes
            </div>
            {recipes.map((r) => (
              <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 0", fontSize: 12 }}>
                <span style={{ fontWeight: 500 }}>{r.name}</span>
                <Chip>{r.topology}</Chip>
                {r.lifecycleState ? <LifecycleBadge state={r.lifecycleState} /> : r.archived ? <Chip>archived</Chip> : null}
                <span className="muted" style={{ marginLeft: "auto" }}>
                  {r.nodeIds.join(", ")}
                </span>
              </div>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}

// ─── Performance tab ──────────────────────────────────────
function PerformanceTab({ sparks, recipe }: { sparks: SparkSnapshot[]; recipe: RecipePublic | null }) {
  const [windowMs, setWindowMs] = useState(30 * 60_000);
  const nodeId = recipe?.nodeIds[0];
  const node = sparks.find((s) => s.id === nodeId);
  const port = recipe?.endpoint?.port ?? recipe?.apiPort;
  // LLM metrics are index-aligned with snapshot.llmPorts (LlmMetrics has no port field).
  const portIdx = node?.llmPorts?.indexOf(port ?? -1) ?? -1;
  const llm = node?.metrics?.llm?.[portIdx >= 0 ? portIdx : 0];
  const effectivePort = portIdx >= 0 ? port : node?.llmPorts?.[0];

  const decode = useTimedMetricsHistory(nodeId ?? "", llm && effectivePort != null ? `llm:${effectivePort}.tps` : "");
  const prefill = useTimedMetricsHistory(nodeId ?? "", llm && effectivePort != null ? `llm:${effectivePort}.prefill` : "");

  const series: Series[] = [
    { label: "Decode tok/s", color: "var(--color-accent)", data: decode },
    { label: "Prefill tok/s", color: "var(--color-info)", data: prefill },
  ];

  return (
    <div className="cp-panel">
      <div className="cp-panel-title">
        <span>Throughput · {node?.name ?? "—"} · port {port ?? "—"}</span>
        <RangePicker value={windowMs} onChange={setWindowMs} />
      </div>
      <TimeSeriesChart series={series} windowMs={windowMs} emptyLabel="No LLM telemetry for this deployment yet." />
      <div style={{ display: "flex", gap: 20, marginTop: 12, flexWrap: "wrap" }}>
        <Metric label="Model served" value={llm?.modelId ?? "—"} />
        <Metric label="Backend" value={llm?.backend ?? "—"} />
        <Metric label="Active slots" value={llm?.slotsActive != null ? `${llm.slotsActive}/${llm.slotsTotal}` : "—"} />
        <Metric label="GPU util" value={node?.metrics?.gpu ? `${Math.round(node.metrics.gpu.usage)}%` : "—"} />
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="cp-metric">
      <span className="cp-metric-label">{label}</span>
      <span className="cp-metric-value" style={{ fontSize: 13 }}>
        {value}
      </span>
    </div>
  );
}

// ─── Recipes tab ──────────────────────────────────────────

/** Legal onward lifecycle steps per current state (WS-1 state machine). */
function onwardSteps(state: RecipePublic["lifecycleState"]): { to: "validated" | "proven" | "deprecated" | "archived"; label: string }[] {
  switch (state) {
    case "draft":
      return [
        { to: "validated", label: "Validate → Validated" },
        { to: "deprecated", label: "Deprecate" },
      ];
    case "validated":
      return [
        { to: "proven", label: "Mark Proven" },
        { to: "deprecated", label: "Deprecate" },
      ];
    case "proven":
    case undefined:
      return [{ to: "deprecated", label: "Deprecate" }];
    case "deprecated":
      return [{ to: "archived", label: "Archive" }];
    default:
      return [];
  }
}

function RecipesTab({
  recipes,
  sparks,
  runtimes,
  modelId,
  navigate,
  onChanged,
}: {
  recipes: RecipePublic[];
  sparks: SparkSnapshot[];
  runtimes: { id: RecipePublic["runtime"]; label: string }[];
  modelId: string;
  navigate: (route: Route) => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<RecipePublic | "new" | null>(null);
  const [dupeTarget, setDupeTarget] = useState<RecipePublic | null>(null);
  const [dupeId, setDupeId] = useState("");
  const [dupeBusy, setDupeBusy] = useState(false);
  const [deployTarget, setDeployTarget] = useState<RecipePublic | null>(null);
  const [deployNodes, setDeployNodes] = useState<string[]>([]);
  const [deployBusy, setDeployBusy] = useState(false);
  const [lifeTarget, setLifeTarget] = useState<{ recipe: RecipePublic; to: "validated" | "proven" | "deprecated" | "archived" } | null>(null);
  const labelMap = useMemo(() => Object.fromEntries(runtimes.map((x) => [x.id, x.label])), [runtimes]);
  const [lifeNote, setLifeNote] = useState("");
  const [lifeBusy, setLifeBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [openKebab, setOpenKebab] = useState<string | null>(null);

  if (editing) {
    return (
      <div className="cp-panel">
        <RecipeEditor
          modelId={modelId}
          existing={editing === "new" ? null : editing}
          sparks={sparks}
          runtimes={runtimes}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  }

  const bounds = (r: RecipePublic) => {
    const b = r.topologyBlock;
    if (!b || b.mode === "single") return { min: 1, max: 1 };
    const min = b.minNodes ?? b.parallelism ?? 1;
    return { min, max: Math.max(min, b.maxNodes ?? min) };
  };

  function openDeploy(r: RecipePublic) {
    if (r.lifecycleState === "archived" || r.archived) return;
    const b = bounds(r);
    setDeployTarget(r);
    setDeployNodes(r.nodeIds.slice(0, b.max));
    setErrors([]);
  }

  const deployBounds = deployTarget ? bounds(deployTarget) : { min: 1, max: 1 };

  async function runValidate(r: RecipePublic) {
    setOpenKebab(null);
    setErrors([]);
    setWarnings([]);
    try {
      const res = await validateRecipe(r.id, r.nodeIds);
      setErrors(res.errors.map((e) => `${r.name}: ${e}`));
      setWarnings(res.warnings.map((w) => `${r.name}: ${w}`));
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="muted" style={{ fontSize: 12 }}>
          Recipes are protected reusable assets — duplicating never touches the proven original.
        </span>
        <button type="button" className="cp-btn primary" onClick={() => setEditing("new")}>
          + New recipe
        </button>
      </div>

      {errors.length > 0 ? (
        <div className="cp-panel" style={{ borderColor: "var(--color-danger)" }} role="alert">
          {errors.map((e, i) => (
            <div key={i} className="cp-field-error">
              {e}
            </div>
          ))}
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <div className="cp-panel" style={{ borderColor: "var(--color-warning)" }}>
          {warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 11, color: "var(--color-warning)" }}>
              {w}
            </div>
          ))}
        </div>
      ) : null}

      {recipes.length === 0 ? (
        <div className="cp-panel">
          <EmptyState title="No recipes" subtitle="A recipe describes runtime, paths, topology, ports, env and launcher metadata." />
        </div>
      ) : (
        recipes.map((r) => {
          const b = bounds(r);
          const archived = r.archived || r.lifecycleState === "archived";
          return (
            <div key={r.id} className="cp-panel">
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{r.name}</span>
                {r.lifecycleState ? <LifecycleBadge state={r.lifecycleState} /> : r.archived ? <Chip>archived</Chip> : null}
                <Chip tone="accent">{runtimeLabel(r.engine?.runtime ?? r.runtime, labelMap)}</Chip>
                <Chip tone="mono">
                  {b.min === b.max ? b.min : `${b.min}–${b.max}`} node{b.max === 1 ? "" : "s"}
                </Chip>
                <Chip tone="mono">{r.serving?.contextLength != null ? `${Math.round(r.serving.contextLength / 1000)}k ctx` : "ctx —"}</Chip>
                {r.nodeIds.length ? <Chip tone="mono">{r.nodeIds.join(", ")}</Chip> : <Chip>unbound</Chip>}
                <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
                  <button type="button" className="cp-btn ghost" disabled={archived} onClick={() => openDeploy(r)} title={archived ? "Archived — cannot back a new deployment" : "Create a binding"}>
                    Deploy
                  </button>
                  <button
                    type="button"
                    className="cp-btn ghost"
                    onClick={() => {
                      setDupeTarget(r);
                      setDupeId(`${r.id}-copy`);
                    }}
                  >
                    Duplicate
                  </button>
                  <button type="button" className="cp-btn ghost" onClick={() => setEditing(r)}>
                    {archived ? "View" : "Edit"}
                  </button>
                  {onwardSteps(r.lifecycleState).length ? (
                    <div className="cp-kebab-wrap">
                      <button
                        type="button"
                        className="cp-kebab"
                        aria-expanded={openKebab === r.id}
                        aria-label={`More actions for ${r.name}`}
                        onClick={() => setOpenKebab((k) => (k === r.id ? null : r.id))}
                      >
                        <KebabIcon size={14} />
                      </button>
                      {openKebab === r.id ? (
                        <div className="cp-menu" role="menu">
                          {r.lifecycleState === "draft" ? (
                            <button type="button" role="menuitem" className="cp-menu-item" onClick={() => void runValidate(r)}>
                              Validate
                            </button>
                          ) : null}
                          {onwardSteps(r.lifecycleState).map((s) => (
                            <button
                              key={s.to}
                              type="button"
                              role="menuitem"
                              className="cp-menu-item"
                              onClick={() => {
                                setOpenKebab(null);
                                setLifeTarget({ recipe: r, to: s.to });
                                setLifeNote("");
                              }}
                            >
                              {s.label}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="cp-btn ghost"
                      onClick={async () => {
                        try {
                          await restoreRecipe(r.id);
                          onChanged();
                        } catch (err) {
                          setErrors([err instanceof Error ? err.message : String(err)]);
                        }
                      }}
                    >
                      Restore
                    </button>
                  )}
                </div>
              </div>

              <dl className="cp-kv" style={{ marginTop: 10 }}>
                <dt>quantization</dt>
                <dd className="mono">{r.engine?.quantization || "—"}</dd>
                <dt>endpoint</dt>
                <dd className="mono">
                  {r.endpoint?.scheme ?? "http"}://{r.endpoint?.hostTemplate ?? "{nodeIp}"}:{r.endpoint?.port ?? r.apiPort}
                  {r.endpoint?.path ?? "/v1"}
                </dd>
                <dt>env</dt>
                <dd className="mono">{r.launch?.env?.length || r.env.length ? (r.launch?.env ?? r.env).map((e) => e.name + (e.secret ?? e.secretRef ? "→secretRef" : "")).join(", ") : "—"}</dd>
                <dt>log dir</dt>
                <dd className="mono">{r.logSource?.path ?? r.logDir ?? "—"}</dd>
              </dl>
            </div>
          );
        })
      )}

      {/* Duplicate — headline feature: deep-copy, proven original untouched */}
      <Modal
        open={dupeTarget != null}
        title={`Duplicate "${dupeTarget?.name ?? ""}"?`}
        consequence="Deep-copies the recipe as a NEW draft. The original is untouched, so you can change quantization, context, flags, env or topology safely."
        info="Secret refs re-point at the new id; provenance records the source recipe."
        confirmLabel="Duplicate recipe"
        busy={dupeBusy}
        onClose={() => setDupeTarget(null)}
        onConfirm={async () => {
          if (!dupeTarget) return;
          if (!/^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/.test(dupeId.trim())) {
            setErrors(["New recipe id must be a lowercase slug."]);
            return;
          }
          setDupeBusy(true);
          try {
            const res = await duplicateRecipe(dupeTarget.id, dupeId.trim());
            setDupeTarget(null);
            setEditing(res.recipe);
            onChanged();
          } catch (err) {
            setErrors([err instanceof Error ? err.message : String(err)]);
          } finally {
            setDupeBusy(false);
          }
        }}
      >
        <Field label="New recipe id" htmlFor="dupe-id" hint="Unique lowercase slug">
          <TextInput id="dupe-id" mono value={dupeId} onChange={(e) => setDupeId(e.target.value)} />
        </Field>
        <div className="cp-kv" style={{ marginTop: 8 }}>
          <dt>source</dt>
          <dd className="mono">{dupeTarget?.id}</dd>
          <dt>new lifecycle</dt>
          <dd>draft</dd>
          <dt>proven original</dt>
          <dd>untouched</dd>
        </div>
      </Modal>

      {/* Deploy — binding only, honoring topology bounds */}
      <Modal
        open={deployTarget != null}
        title={`Deploy "${deployTarget?.name ?? ""}"?`}
        consequence="Creates a deployment BINDING (config only). No process is started; desiredState is recorded for a later dry-run start."
        info="The recipe and its weights are never modified."
        confirmLabel="Create binding"
        busy={deployBusy}
        onClose={() => setDeployTarget(null)}
        onConfirm={async () => {
          const t = deployTarget;
          if (!t) return;
          const b = bounds(t);
          if (deployNodes.length < b.min || deployNodes.length > b.max) {
            setErrors([`Topology ${t.topology} requires ${b.min}–${b.max} node(s).`]);
            return;
          }
          setDeployBusy(true);
          try {
            await createDeployment({ modelId, recipeId: t.id, nodeIds: deployNodes, desiredState: t.launch?.mechanism === "external" ? "unknown" : "stopped" });
            setDeployTarget(null);
            onChanged();
            navigate({ section: "model", modelId, tab: "deployments" });
          } catch (err) {
            setErrors([err instanceof Error ? err.message : String(err)]);
          } finally {
            setDeployBusy(false);
          }
        }}
      >
        <div className="cp-section-legend">
          Nodes ({deployNodes.length}/{deployBounds.min === deployBounds.max ? deployBounds.min : `${deployBounds.min}–${deployBounds.max}`})
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {sparks.map((n) => {
            const b = deployBounds;
            return (
              <button
                key={n.id}
                type="button"
                className={`cp-pick ${deployNodes.includes(n.id) ? "is-selected" : ""}`}
                aria-pressed={deployNodes.includes(n.id)}
                onClick={() =>
                  setDeployNodes((prev) => {
                    if (prev.includes(n.id)) return prev.filter((x) => x !== n.id);
                    if (prev.length >= b.max) return [...prev.slice(1), n.id];
                    return [...prev, n.id];
                  })
                }
              >
                <StatusDot status={n.online ? "online" : "offline"} />
                {n.name}
              </button>
            );
          })}
        </div>
        <div className="cp-kv" style={{ marginTop: 8 }}>
          <dt>desired state</dt>
          <dd className="mono">{deployTarget?.launch?.mechanism === "external" ? "unknown (external)" : "stopped"}</dd>
          <dt>weights</dt>
          <dd>untouched</dd>
        </div>
      </Modal>

      {/* Lifecycle transition with from → to */}
      <Modal
        open={lifeTarget != null}
        title={
          lifeTarget
            ? `${lifeTarget.to === "validated" ? "Validate" : lifeTarget.to === "proven" ? "Mark proven" : lifeTarget.to === "deprecated" ? "Deprecate" : "Archive"} "${lifeTarget.recipe.name}"?`
            : ""
        }
        consequence={
          lifeTarget?.to === "validated"
            ? "Runs the dry-run validate; on success the recipe flips to Validated."
            : lifeTarget?.to === "proven"
              ? "Marks the recipe Proven — a proven recipe is the safe thing to duplicate."
              : lifeTarget?.to === "deprecated"
                ? "Flags the recipe Deprecated. It can still serve, but should be replaced."
                : "Flips to Archived. It can no longer back new deployments; weights stay untouched."
        }
        diagram={
          lifeTarget ? (
            <span className="cp-modal-diagram-row">
              <LifecycleBadge state={lifeTarget.recipe.lifecycleState ?? "draft"} />
              <span aria-hidden="true">→</span>
              <LifecycleBadge state={lifeTarget.to} />
            </span>
          ) : null
        }
        info={lifeTarget?.to === "archived" ? "Archived recipes render read-only. Restore brings it back to Deprecated." : undefined}
        confirmLabel={lifeTarget?.to === "archived" ? "Archive recipe" : "Confirm"}
        tone={lifeTarget?.to === "archived" || lifeTarget?.to === "deprecated" ? "danger" : "primary"}
        busy={lifeBusy}
        onClose={() => setLifeTarget(null)}
        onConfirm={async () => {
          const t = lifeTarget;
          if (!t) return;
          setLifeBusy(true);
          try {
            await recipeLifecycle(t.recipe.id, t.to, t.to === "proven" ? lifeNote : undefined);
            setLifeTarget(null);
            onChanged();
          } catch (err) {
            setErrors([err instanceof Error ? err.message : String(err)]);
          } finally {
            setLifeBusy(false);
          }
        }}
      >
        <div className="cp-kv">
          <dt>from</dt>
          <dd>{lifeTarget?.recipe.lifecycleState ?? "draft"}</dd>
          <dt>to</dt>
          <dd>{lifeTarget?.to}</dd>
          <dt>weights</dt>
          <dd>untouched</dd>
        </div>
        {lifeTarget?.to === "proven" ? (
          <Field label="Proven note" htmlFor="life-note" hint="Required for validated → proven" error={lifeNote.trim() ? null : "A note is required."}>
            <TextArea id="life-note" rows={2} value={lifeNote} onChange={(e) => setLifeNote(e.target.value)} />
          </Field>
        ) : null}
      </Modal>
    </div>
  );
}

// ─── Deployments tab (bindings for this model's recipes) ──
function DeploymentsTab({
  deps,
  recipes,
  sparks,
  navigate,
  onChanged,
}: {
  deps: DeploymentStatus[];
  recipes: RecipePublic[];
  sparks: SparkSnapshot[];
  navigate: (route: Route) => void;
  onChanged: () => void;
}) {
  const [removeTarget, setRemoveTarget] = useState<DeploymentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (deps.length === 0) {
    return (
      <div className="cp-panel">
        <EmptyState title="No deployments" subtitle="Use Deploy on a recipe card to create a binding (config only)." />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {error ? (
        <div className="cp-panel" style={{ borderColor: "var(--color-danger)" }} role="alert">
          <div className="cp-field-error">{error}</div>
        </div>
      ) : null}
      {deps.map((d) => {
        const r = recipes.find((x) => x.id === d.recipeId);
        return (
          <div key={d.deploymentId ?? d.recipeId} className="cp-deploy-row">
            <StatusPill status={d.display} className="cp-deploy-state" />
            <div className="cp-deploy-model">
              <span className="cp-deploy-name">{r?.name ?? d.recipeId}</span>
              <CopyId value={d.recipeId} className="cp-deploy-id" />
            </div>
            <div className="cp-deploy-nodes">
              <span className="cp-node-cluster">
                {d.nodeIds.length > 1 ? (
                  <span className="cp-node-cluster-label">
                    {String(r?.topologyBlock?.mode ?? r?.topology ?? "").toUpperCase()} · {d.nodeIds.length} nodes
                  </span>
                ) : null}
                <span className="cp-node-cluster-chips">
                  {d.nodeIds.map((id) => (
                    <span key={id} className="cp-node-chip">
                      <StatusDot status={sparks.find((s) => s.id === id)?.online ? "online" : "offline"} />
                      {sparks.find((s) => s.id === id)?.name ?? id}
                    </span>
                  ))}
                </span>
              </span>
            </div>
            <div className="cp-deploy-right">
              <span className="cp-deploy-port mono">:{d.apiPort}</span>
            </div>
            <div className="cp-row-actions">
              <button type="button" className="cp-btn ghost" onClick={() => navigate({ section: "model", modelId: d.modelId, tab: "live-console" })}>
                View logs
              </button>
              <button type="button" className="cp-kebab" aria-label="Remove binding" onClick={() => setRemoveTarget(d)}>
                <KebabIcon size={14} />
              </button>
            </div>
          </div>
        );
      })}

      <Modal
        open={removeTarget != null}
        title={`Remove deployment binding "${removeTarget?.recipeId ?? ""}"?`}
        consequence="Deletes the deployment BINDING only. The model, recipe and weight files all stay exactly as they are."
        info="The recipe returns to its prior lifecycle state; nothing is archived."
        confirmLabel="Remove binding"
        tone="danger"
        busy={busy}
        onClose={() => setRemoveTarget(null)}
        onConfirm={async () => {
          const t = removeTarget;
          if (!t) return;
          setBusy(true);
          try {
            await deleteDeployment(t.deploymentId ?? t.recipeId);
            setRemoveTarget(null);
            onChanged();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="cp-kv">
          <dt>recipe</dt>
          <dd className="mono">{removeTarget?.recipeId}</dd>
          <dt>nodes</dt>
          <dd className="mono">{removeTarget?.nodeIds.join(", ")}</dd>
          <dt>weights</dt>
          <dd>untouched</dd>
          <dt>recipe/model</dt>
          <dd>kept</dd>
        </div>
      </Modal>
    </div>
  );
}

// ─── Benchmarks tab ───────────────────────────────────────
function BenchmarksTab({ recipes, sparks, navigate }: { recipes: RecipePublic[]; sparks: SparkSnapshot[]; navigate: (route: Route) => void }) {
  const [rows, setRows] = useState<{ id: string; recipeId: string; tps: number | null; status: string; node: string }[]>([]);

  useEffect(() => {
    const nodeId = recipes.find((r) => r.nodeIds.length)?.nodeIds[0];
    const recipe = recipes.find((r) => r.nodeIds.includes(nodeId ?? ""));
    const port = recipe?.endpoint?.port ?? recipe?.apiPort;
    if (!nodeId || port == null) return;
    let alive = true;
    listDecodeBench(nodeId, port)
      .then((r) => {
        if (!alive) return;
        const all = [r.active, r.last, ...r.history].filter(Boolean) as NonNullable<typeof r.active>[];
        setRows(
          all.slice(0, 8).map((j) => ({
            id: j.benchId,
            recipeId: j.config.recipeId ?? recipe?.id ?? "",
            tps: j.results[0]?.meanDecodeTps ?? null,
            status: j.status,
            node: nodeId,
          }))
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [recipes]);

  if (recipes.length === 0) {
    return (
      <div className="cp-panel">
        <EmptyState title="No recipes" subtitle="Benchmarks are attributed to recipes — create one first." />
      </div>
    );
  }

  return (
    <div className="cp-panel">
      <div className="cp-panel-title">
        <span>Recent decode benchmarks</span>
        <button type="button" className="cp-btn ghost" onClick={() => navigate({ section: "benchmarks" })}>
          Open Benchmarks
        </button>
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No benchmark runs" subtitle="Start a decode bench from the Benchmarks surface." />
      ) : (
        rows.map((j) => {
          const r = recipes.find((x) => x.id === j.recipeId);
          return (
            <div key={j.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "7px 0", borderBottom: "1px solid var(--color-border)", fontSize: 12 }}>
              <StatusPill status={j.status === "completed" ? "running" : j.status === "failed" ? "error" : "loading"} />
              <span>{r?.name ?? j.recipeId}</span>
              <Chip tone="mono">{sparks.find((s) => s.id === j.node)?.name ?? j.node}</Chip>
              <span className="mono" style={{ marginLeft: "auto" }}>
                {j.tps != null ? `${Math.round(j.tps)} tok/s` : "—"}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}

// ─── Configuration tab (read-only view of the recipe config) ──
function ConfigTab({ model, recipe }: { model: ModelEntry | null; recipe: RecipePublic | null }) {
  if (!recipe) {
    return (
      <div className="cp-panel">
        <EmptyState title="No recipe" subtitle="Configuration comes from the deployment recipe." />
      </div>
    );
  }
  const env = recipe.launch?.env ?? recipe.env;
  return (
    <div className="cp-panel">
      <div className="cp-panel-title">Effective configuration (read-only)</div>
      <dl className="cp-kv">
        <dt>model.id</dt>
        <dd className="mono">{model?.id}</dd>
        <dt>recipe.id</dt>
        <dd className="mono">{recipe.id}</dd>
        <dt>runtime</dt>
        <dd className="mono">{recipe.engine?.runtime ?? recipe.runtime}</dd>
        <dt>modelPath</dt>
        <dd className="mono">{recipe.modelPath}</dd>
        <dt>executable</dt>
        <dd className="mono">{recipe.launch?.executable ?? "—"}</dd>
        <dt>apiPort</dt>
        <dd>{recipe.endpoint?.port ?? recipe.apiPort}</dd>
        <dt>healthPath</dt>
        <dd className="mono">{recipe.healthProbe?.path ?? recipe.healthPath}</dd>
        <dt>contextLength</dt>
        <dd>{recipe.serving?.contextLength ?? "—"}</dd>
        <dt>affinity</dt>
        <dd className="mono">{recipe.launch?.affinity ?? "—"}</dd>
        <dt>logSource</dt>
        <dd className="mono">{recipe.logSource?.path ?? recipe.logDir ?? "—"}</dd>
        <dt>tags</dt>
        <dd className="mono">{(recipe.tags ?? []).join(", ") || "—"}</dd>
      </dl>
      <div className="cp-panel-title" style={{ marginTop: 16 }}>
        Environment (secret values never sent to the browser)
      </div>
      <table className="cp-table">
        <tbody>
          {env.map((e) => (
            <tr key={e.name}>
              <td className="mono">{e.name}</td>
              <td className="mono">{e.secret || e.secretRef ? "••• secretRef" : e.value ?? "—"}</td>
            </tr>
          ))}
          {env.length === 0 ? (
            <tr>
              <td className="muted">No environment variables</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

// ─── History tab (activity events for this model) ─────────
function HistoryTab({ modelId }: { modelId: string }) {
  const [events, setEvents] = useState<{ seq: number; ts: string; kind: string; summary: string }[]>([]);
  useEffect(() => {
    fetchActivity(200)
      .then((r) => setEvents(r.events.filter((e) => (e.subject || "").includes(modelId) || (e.meta && JSON.stringify(e.meta).includes(modelId)))))
      .catch(() => {});
  }, [modelId]);

  if (events.length === 0) {
    return (
      <div className="cp-panel">
        <EmptyState title="No history yet" subtitle="Lifecycle, benchmark and node events for this model will appear here." />
      </div>
    );
  }
  return (
    <div className="cp-panel">
      {events.map((e) => (
        <div key={e.seq} style={{ display: "flex", gap: 10, padding: "7px 0", borderBottom: "1px solid var(--color-border)", fontSize: 12 }}>
          <span className="muted mono" style={{ flex: "0 0 140px" }}>
            {e.ts.slice(0, 19).replace("T", " ")}
          </span>
          <Chip>{e.kind}</Chip>
          <span>{e.summary}</span>
        </div>
      ))}
    </div>
  );
}
