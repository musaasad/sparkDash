import { useEffect, useMemo, useState } from "react";
import type { ModelEntry, RecipePublic, DeploymentStatus, SparkSnapshot } from "../../api/types";
import type { Route } from "../../hooks/router";
import { fetchModel, archiveRecipe, cloneRecipe, fetchActivity } from "../../api/client";
import { useDeployments } from "../../hooks/domainStore";
import { StatusPill, Chip, EmptyState } from "../ui/Status";
import { Field, TextInput, FormFooter } from "../ui/form";
import { RecipeEditor } from "./RecipeEditor";
import { DeployControls } from "./DeployControls";
import { LiveConsole } from "./LiveConsole";
import { TimeSeriesChart, RangePicker, type Series } from "../ui/TimeSeriesChart";
import { useTimedMetricsHistory } from "../../hooks/metricsStore";

const TABS = ["Overview", "Performance", "Live Console", "Recipes", "Configuration", "History"] as const;
type Tab = (typeof TABS)[number];

interface ModelDetailProps {
  modelId: string;
  initialTab?: string;
  sparks: SparkSnapshot[];
  navigate: (route: Route) => void;
  onDataChanged: () => void;
}

export function ModelDetail({ modelId, initialTab, sparks, navigate, onDataChanged }: ModelDetailProps) {
  const [model, setModel] = useState<ModelEntry | null>(null);
  const [recipes, setRecipes] = useState<RecipePublic[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(normalizeTab(initialTab));
  const [editing, setEditing] = useState<RecipePublic | "new" | null>(null);
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
    setEditing(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId]);

  const deps = useMemo(() => deployments.filter((d) => d.modelId === modelId), [deployments, modelId]);
  const primaryRecipe = recipes.find((r) => !r.archived) ?? null;
  const primaryDep = deps.find((d) => d.recipeId === primaryRecipe?.id) ?? deps[0];

  if (error && !model) {
    return (
      <div className="cp-panel">
        <EmptyState title="Model not found" subtitle={error} action={<button type="button" className="cp-btn" onClick={() => navigate({ section: "models" })}>← All models</button>} />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <nav className="cp-crumb" aria-label="Breadcrumb">
        <a
          href="/models"
          onClick={(e) => {
            e.preventDefault();
            navigate({ section: "models" });
          }}
        >
          Models
        </a>
        <span className="cp-crumb-sep">/</span>
        <span className="cp-crumb-current">{model?.name ?? modelId}</span>
      </nav>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div>
          <div className="cp-section-title">{model?.name ?? "…"}</div>
          <div className="cp-section-sub">
            {model?.family ? `${model.family} · ` : ""}
            <span className="cp-chip mono">{modelId}</span>
          </div>
        </div>
        {primaryDep ? <StatusPill status={primaryDep.state as never} /> : <Chip>not deployed</Chip>}
      </div>

      <div className="cp-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            className={`cp-tab ${tab === t ? "is-active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Overview" ? (
        <OverviewTab model={model} recipes={recipes} deps={deps} sparks={sparks} onDeployChanged={() => { void load(); onDataChanged(); }} />
      ) : null}
      {tab === "Performance" ? <PerformanceTab sparks={sparks} recipe={primaryRecipe} /> : null}
      {tab === "Live Console" ? (
        primaryRecipe ? (
          <LiveConsole recipeId={primaryRecipe.id} logDir={primaryRecipe.logDir} />
        ) : (
          <div className="cp-panel">
            <EmptyState title="No recipe" subtitle="Add a deployment recipe with a log directory to enable the Live Console." />
          </div>
        )
      ) : null}
      {tab === "Recipes" ? (
        <RecipesTab
          recipes={recipes}
          deps={deps}
          editing={editing}
          setEditing={setEditing}
          sparks={sparks}
          modelId={modelId}
          onChanged={() => {
            void load();
            onDataChanged();
          }}
        />
      ) : null}
      {tab === "Configuration" ? <ConfigTab model={model} recipe={primaryRecipe} /> : null}
      {tab === "History" ? <HistoryTab modelId={modelId} /> : null}
    </div>
  );
}

function normalizeTab(t?: string): Tab {
  if (!t) return "Overview";
  const hit = TABS.find((x) => x.toLowerCase() === t.toLowerCase() || x.toLowerCase().replace(" ", "-") === t.toLowerCase());
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
  const dep = deps.find((d) => d.recipeId === primary?.id);
  const nodeNames = (primary?.nodeIds || []).map((id) => sparks.find((s) => s.id === id)?.name || id);

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
              <dd>{primary.runtime}</dd>
              <dt>Topology</dt>
              <dd>{primary.topology}</dd>
              <dt>Nodes</dt>
              <dd>{nodeNames.join(", ") || "—"}</dd>
              <dt>API port</dt>
              <dd>{primary.apiPort}</dd>
              <dt>Context</dt>
              <dd>{primary.contextLength != null ? primary.contextLength.toLocaleString() : "—"}</dd>
            </dl>
            <div style={{ marginTop: 14 }}>
              <DeployControls recipe={primary} deployment={dep} onUpdated={onDeployChanged} />
            </div>
          </>
        ) : (
          <EmptyState title="No deployment recipe" subtitle="Create a recipe to describe how this model runs." />
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
                {r.archived ? <Chip>archived</Chip> : null}
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
  const port = recipe?.apiPort;
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
function RecipesTab({
  recipes,
  deps,
  editing,
  setEditing,
  sparks,
  modelId,
  onChanged,
}: {
  recipes: RecipePublic[];
  deps: DeploymentStatus[];
  editing: RecipePublic | "new" | null;
  setEditing: (r: RecipePublic | "new" | null) => void;
  sparks: SparkSnapshot[];
  modelId: string;
  onChanged: () => void;
}) {
  if (editing) {
    return (
      <div className="cp-panel">
        <RecipeEditor
          modelId={modelId}
          existing={editing === "new" ? null : editing}
          sparks={sparks}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="button" className="cp-btn primary" onClick={() => setEditing("new")}>
          + New recipe
        </button>
      </div>
      {recipes.length === 0 ? (
        <div className="cp-panel">
          <EmptyState title="No recipes" subtitle="A recipe describes runtime, paths, topology, ports, env and launcher metadata." />
        </div>
      ) : (
        recipes.map((r) => {
          const dep = deps.find((d) => d.recipeId === r.id);
          return (
            <div key={r.id} className="cp-panel">
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{r.name}</span>
                <Chip>{r.runtime}</Chip>
                <Chip>{r.topology}</Chip>
                <Chip tone="mono">{r.nodeIds.join(", ")}</Chip>
                <Chip tone="mono">:{r.apiPort}</Chip>
                {r.archived ? <Chip>archived</Chip> : null}
                {dep ? <StatusPill status={dep.state as never} /> : null}
                <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <button type="button" className="cp-btn ghost" onClick={() => setEditing(r)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="cp-btn ghost"
                    onClick={async () => {
                      const newId = window.prompt("Clone as recipe id", `${r.id}-copy`);
                      if (!newId) return;
                      try {
                        await cloneRecipe(r.id, newId.trim());
                        onChanged();
                      } catch (err) {
                        window.alert(err instanceof Error ? err.message : String(err));
                      }
                    }}
                  >
                    Clone
                  </button>
                  {!r.archived ? (
                    <button
                      type="button"
                      className="cp-btn ghost danger"
                      onClick={async () => {
                        if (!window.confirm(`Archive recipe "${r.name}"? Weights are never deleted.`)) return;
                        try {
                          await archiveRecipe(r.id);
                          onChanged();
                        } catch (err) {
                          window.alert(err instanceof Error ? err.message : String(err));
                        }
                      }}
                    >
                      Archive
                    </button>
                  ) : null}
                </div>
              </div>
              <dl className="cp-kv" style={{ marginTop: 10 }}>
                <dt>model path</dt>
                <dd className="mono">{r.modelPath}</dd>
                <dt>workdir</dt>
                <dd className="mono">{r.workdir}</dd>
                <dt>env</dt>
                <dd>{r.env.length ? r.env.map((e) => e.name + (e.secret ? " •••" : `=${e.value}`)).join(", ") : "—"}</dd>
                <dt>log dir</dt>
                <dd className="mono">{r.logDir || "—"}</dd>
              </dl>
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
  return (
    <div className="cp-panel">
      <div className="cp-panel-title">Effective configuration (read-only)</div>
      <dl className="cp-kv">
        <dt>model.id</dt>
        <dd className="mono">{model?.id}</dd>
        <dt>recipe.id</dt>
        <dd className="mono">{recipe.id}</dd>
        <dt>runtime</dt>
        <dd className="mono">{recipe.runtime}</dd>
        <dt>modelPath</dt>
        <dd className="mono">{recipe.modelPath}</dd>
        <dt>workdir</dt>
        <dd className="mono">{recipe.workdir}</dd>
        <dt>apiPort</dt>
        <dd>{recipe.apiPort}</dd>
        <dt>healthPath</dt>
        <dd className="mono">{recipe.healthPath}</dd>
        <dt>contextLength</dt>
        <dd>{recipe.contextLength ?? "—"}</dd>
        <dt>cpuAffinity</dt>
        <dd className="mono">{recipe.cpuAffinity ?? "—"}</dd>
        <dt>launcher</dt>
        <dd className="mono">{recipe.launcher ?? "—"}</dd>
        <dt>logDir</dt>
        <dd className="mono">{recipe.logDir ?? "—"}</dd>
        <dt>metadata</dt>
        <dd className="mono">{JSON.stringify(recipe.metadata)}</dd>
      </dl>
      <div className="cp-panel-title" style={{ marginTop: 16 }}>
        Environment
      </div>
      <table className="cp-table">
        <tbody>
          {recipe.env.map((e) => (
            <tr key={e.name}>
              <td className="mono">{e.name}</td>
              <td className="mono">{e.secret ? "••• (stored, never sent to browser)" : e.value}</td>
            </tr>
          ))}
          {recipe.env.length === 0 ? (
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