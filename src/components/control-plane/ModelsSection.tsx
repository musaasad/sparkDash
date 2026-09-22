import { useEffect, useMemo, useState } from "react";
import type { ModelEntry, RecipePublic, DeploymentStatus, SparkSnapshot, ActivityEvent } from "../../api/types";
import type { Route } from "../../hooks/router";
import { DataTable, sortRows, CountedTabs, CopyId, type Column } from "../ui/DataTable";
import { StatusPill, StatusDot, Chip, EmptyState, LifecycleBadge, SkeletonRows } from "../ui/Status";
import { Field, TextInput, FormFooter } from "../ui/form";
import { SectionBand } from "../ui/SectionBand";
import { Toolbar, DensityToggle } from "../ui/Toolbar";
import { ColumnsPopover } from "../ui/ColumnsPopover";
import { BotIcon, PanelIcon } from "../ui/icons";
import { upsertModel, fetchActivity } from "../../api/client";
import {
  deploymentViews,
  deploymentTabCounts,
  deploymentMatchesTab,
  isErrorRow,
  errorLogLines,
  familyGroups,
  modelGlyph,
  externalConnectView,
  fmtAgeFromISO,
  runtimeLabel,
  type DeploymentView,
} from "./fleetModel";
import { ExternalConnectPanel } from "./ModelDetail";
import { DiscoveredRuntimes } from "./DiscoveredRuntimes";

interface ModelsProps {
  models: ModelEntry[];
  recipes: RecipePublic[];
  deployments: readonly DeploymentStatus[];
  navigate: (route: Route) => void;
  onSaved: () => void;
  /** Node snapshots for cluster chips (optional; names fall back to ids). */
  sparks?: SparkSnapshot[];
  /** Recent runtime activity for inline error-row logs (optional). */
  activity?: ActivityEvent[];
}

function provenanceOf(v: DeploymentView): string {
  return v.deployment.managedBy === "external" ? "external" : `managed · ${runtimeLabel(v.runtime)}`;
}

export function ModelsSection({ models, recipes, deployments, navigate, onSaved, sparks = [], activity }: ModelsProps) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [family, setFamily] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [sortKey, setSortKey] = useState<string | null>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [tab, setTab] = useState("all");
  const [query, setQuery] = useState("");
  const [runtimeFilter, setRuntimeFilter] = useState("all");
  const [nodeFilter, setNodeFilter] = useState("all");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [localActivity, setLocalActivity] = useState<ActivityEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [dense, setDense] = useState(false);
  const [visibleCols, setVisibleCols] = useState<ReadonlySet<string>>(new Set(["name", "recipes", "deployment", "update"]));

  // Error rows expand with the last ~10 log lines. Prefer caller-supplied
  // activity; otherwise fetch the client-side activity feed as a fallback.
  useEffect(() => {
    if (activity) return;
    fetchActivity(200).then((r) => setLocalActivity(r.events)).catch(() => {});
  }, [activity]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const feed = activity ?? localActivity;
  const active = useMemo(() => models.filter((m) => !m.archived), [models]);
  const views = useMemo(() => deploymentViews(sparks, deployments, recipes, models), [sparks, deployments, recipes, models]);
  const nodeNames = useMemo(() => new Map(sparks.map((s) => [s.id, s.name])), [sparks]);

  const tabCounts = useMemo(() => deploymentTabCounts(deployments), [deployments]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return views.filter((v) => {
      if (!deploymentMatchesTab(v.deployment, tab)) return false;
      if (runtimeFilter !== "all" && v.runtime !== runtimeFilter) return false;
      if (nodeFilter !== "all" && !v.deployment.nodeIds.includes(nodeFilter)) return false;
      if (q && !`${v.modelName} ${v.rawModelId} ${v.recipe?.name ?? ""} ${v.runtime}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [views, tab, runtimeFilter, nodeFilter, query]);

  const runtimes = useMemo(() => [...new Set(views.map((v) => v.runtime))].filter((r) => r !== "—"), [views]);

  const catalogColumns: Column<ModelEntry>[] = useMemo(
    () => [
      {
        key: "name",
        header: "Model",
        sortable: true,
        sortValue: (m) => m.name.toLowerCase(),
        render: (m) => (
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <span className="cp-glyph" aria-hidden="true">
              {modelGlyph(m.name)}
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
              <span style={{ fontWeight: 500 }}>{m.name}</span>
              <CopyId value={m.weightPaths?.default ?? recipes.find((r) => r.modelId === m.id && !r.archived)?.modelPath ?? m.id} className="cp-cell-sub" />
            </div>
          </div>
        ),
      },
      {
        key: "recipes",
        header: "Recipes",
        align: "right",
        sortable: true,
        sortValue: (m) => recipes.filter((r) => r.modelId === m.id && !r.archived).length,
        render: (m) => String(recipes.filter((r) => r.modelId === m.id && !r.archived).length),
      },
      {
        key: "deployment",
        header: "Deployment",
        align: "right",
        render: (m) => {
          const deps = deployments.filter((d) => d.modelId === m.id);
          if (deps.length === 0) return <span className="muted">not deployed</span>;
          // Worst-first: degraded outranks expected-missing outranks running.
          const worst =
            deps.find((d) => d.display === "degraded") ||
            deps.find((d) => d.display === "expected-not-detected") ||
            deps.find((d) => d.display === "running" || d.display === "running-external") ||
            deps[0];
          return <StatusPill status={worst.display} />;
        },
      },
      {
        key: "update",
        header: "Updated",
        align: "right",
        muted: true,
        sortable: true,
        sortValue: (m) => m.updatedAt,
        render: (m) => fmtAgeFromISO(new Date(m.updatedAt).toISOString(), now),
      },
    ],
    [recipes, deployments, now]
  );

  const groups = useMemo(() => familyGroups(active, deployments), [active, deployments]);
  const shownColumns = useMemo(() => catalogColumns.filter((c) => visibleCols.has(c.key)), [catalogColumns, visibleCols]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await upsertModel({ id: id || slug(name), name, family: family || null });
      setAdding(false);
      setName("");
      setId("");
      setFamily("");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function toggleOpen(key: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Toolbar: search left · filters middle · utilities + primary right */}
      <Toolbar
        search={
          <input
            type="search"
            aria-label="Search deployments"
            placeholder="Search model, recipe, runtime…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        }
        filters={
          <>
          <select className="cp-btn ghost" aria-label="Runtime filter" value={runtimeFilter} onChange={(e) => setRuntimeFilter(e.target.value)}>
            <option value="all">All runtimes</option>
            {runtimes.map((r) => (
              <option key={r} value={r}>
                {runtimeLabel(r)}
              </option>
            ))}
          </select>
          <select className="cp-btn ghost" aria-label="Node filter" value={nodeFilter} onChange={(e) => setNodeFilter(e.target.value)}>
            <option value="all">All nodes</option>
            {sparks.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {query || runtimeFilter !== "all" || nodeFilter !== "all" ? (
            <button
              type="button"
              className="cp-btn ghost"
              onClick={() => {
                setQuery("");
                setRuntimeFilter("all");
                setNodeFilter("all");
              }}
            >
              Clear
            </button>
          ) : null}
          </>
        }
        utilities={
          <>
            <DensityToggle dense={dense} onChange={setDense} />
            <ColumnsPopover columns={catalogColumns.map((c) => ({ key: c.key, label: String(c.header) }))} visible={visibleCols} onChange={setVisibleCols} />
          </>
        }
        primary={
          <button
            type="button"
            className={`cp-btn ${adding ? "ghost" : "primary"}`}
            onClick={() => setAdding((a) => !a)}
          >
            {adding ? "Cancel" : "+ Add model"}
          </button>
        }
      />

      {adding ? (
        <div className="cp-panel">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <Field label="Model name" htmlFor="m-name">
              <TextInput id="m-name" value={name} placeholder="Qwen 3.8 Flash Next" onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="id" htmlFor="m-id" hint="Auto-slug if blank">
              <TextInput id="m-id" mono value={id} onChange={(e) => setId(e.target.value)} />
            </Field>
            <Field label="Family" htmlFor="m-fam" hint="Optional">
              <TextInput id="m-fam" value={family} placeholder="Qwen" onChange={(e) => setFamily(e.target.value)} />
            </Field>
          </div>
          {error ? <div className="cp-field-error" role="alert">{error}</div> : null}
          <FormFooter onCancel={() => setAdding(false)}>
            <button type="button" className="cp-btn primary" onClick={save} disabled={saving || !name.trim()}>
              {saving ? "Saving…" : "Add model"}
            </button>
          </FormFooter>
        </div>
      ) : null}

      {/* Discovered externally-launched runtimes — no band when nothing new */}
      <DiscoveredRuntimes sparks={sparks} recipes={recipes} onSaved={onSaved} />

      {/* Deployments — counted tabs replace a repeated status column */}
      <div className="cp-section-block">
        <SectionBand icon={<PanelIcon />} title="Deployments" count={filtered.length} />
        <CountedTabs tabs={tabCounts} active={tab} onSelect={setTab} ariaLabel="Deployment status filters" panelId="models-deployments" />
        {filtered.length === 0 ? (
          <div id="models-deployments" className="cp-table-empty-box">No deployments match these filters.</div>
        ) : (
          <div id="models-deployments" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {filtered.map((v) => {
              const key = v.key;
              const expandable = isErrorRow(v.deployment);
              const expanded = open.has(key);
              const connect = externalConnectView(v.deployment, v.recipe, sparks);
              return (
                <div key={key}>
                  <div
                    className="cp-deploy-row"
                    role="button"
                    tabIndex={0}
                    aria-expanded={expandable ? expanded : undefined}
                    onClick={() => navigate({ section: "model", modelId: v.rawModelId })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        navigate({ section: "model", modelId: v.rawModelId });
                      }
                    }}
                  >
                    <StatusPill status={v.deployment.display} className="cp-deploy-state" />

                    <div className="cp-deploy-model">
                      <span className="cp-deploy-name">{v.modelName}</span>
                      <CopyId value={v.recipe?.id ?? v.deployment.recipeId} className="cp-deploy-id" />
                    </div>

                    {v.lifecycleState && v.lifecycleState !== "draft" ? (
                      <LifecycleBadge state={v.lifecycleState} />
                    ) : null}

                    <div className="cp-deploy-meta">
                      <span className="muted" style={{ fontSize: 10 }} title={v.deployment.managedBy === "external" ? "Launched outside SparkDash" : undefined}>
                        {v.deployment.updatedAt ? fmtAgeFromISO(new Date(v.deployment.updatedAt).toISOString(), now) : "—"} · {provenanceOf(v)}
                      </span>
                      {v.contextLength ? <Chip tone="mono">{Math.round(v.contextLength / 1000)}k ctx</Chip> : null}
                    </div>

                    <div className="cp-deploy-nodes">
                      {v.nodes.length > 1 ? (
                        <div className="cp-node-cluster">
                          <span className="cp-node-cluster-label">
                            {v.topology.toUpperCase()} · {v.nodes.length} nodes
                          </span>
                          <span className="cp-node-cluster-chips">
                            {v.deployment.nodeIds.map((id) => {
                              const n = v.nodes.find((x) => x.id === id);
                              return (
                                <span key={id} className="cp-node-chip" title={n?.lanIp}>
                                  <StatusDot status={n?.online ? "online" : "offline"} />
                                  {n?.name ?? nodeNames.get(id) ?? id}
                                </span>
                              );
                            })}
                          </span>
                        </div>
                      ) : (
                        <span className="cp-node-chip">
                          <StatusDot status={v.nodes[0]?.online ? "online" : "offline"} />
                          {v.nodes[0]?.name ?? nodeNames.get(v.deployment.nodeIds[0]) ?? "—"}
                        </span>
                      )}
                    </div>

                    <div className="cp-deploy-right">
                      <span className={`cp-deploy-tps${v.decodeTps == null ? " is-idle" : ""}`}>
                        {v.decodeTps == null ? "—" : v.decodeTps}
                        {v.decodeTps != null ? <span className="cp-unit"> tok/s</span> : null}
                      </span>
                      <span className="cp-deploy-port mono">:{v.port}</span>
                    </div>

                    <div className="cp-row-actions">
                      <button
                        type="button"
                        className="cp-btn ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate({ section: "model", modelId: v.rawModelId, tab: "live-console" });
                        }}
                      >
                        View logs
                      </button>
                      {expandable ? (
                        <button
                          type="button"
                          className="cp-kebab"
                          aria-expanded={expanded}
                          aria-label={expanded ? "Collapse details" : "Expand details"}
                          title="Details"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleOpen(key);
                          }}
                        >
                          {expanded ? "▴" : "▾"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="cp-kebab"
                          aria-label="Open model"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate({ section: "model", modelId: v.rawModelId });
                          }}
                        >
                          ⋯
                        </button>
                      )}
                    </div>
                  </div>

                  {expanded ? (
                    <div className="cp-expand-body">
                      <div className="cp-expand-head">
                        <span className="cp-chip">error</span>
                        <span className="muted">{v.deployment.lastError ?? "Degraded — see recent log lines."}</span>
                        <a
                          href={`/models/${encodeURIComponent(v.rawModelId)}/live-console`}
                          className="cp-alert-link"
                          style={{ marginLeft: "auto" }}
                          onClick={(e) => {
                            e.preventDefault();
                            navigate({ section: "model", modelId: v.rawModelId, tab: "live-console" });
                          }}
                        >
                          Open Live Console →
                        </a>
                      </div>
                      {errorLogLines(feed, [v.deployment.recipeId, v.rawModelId, v.deployment.modelId]).length === 0 ? (
                        <div className="muted" style={{ fontSize: 11 }}>
                          No recent log lines for this deployment.
                        </div>
                      ) : (
                        <div className="cp-log-lines">
                          {errorLogLines(feed, [v.deployment.recipeId, v.rawModelId, v.deployment.modelId]).map((e) => (
                            <div key={e.seq} className="cp-log-line" title={e.summary}>
                              <span className="cp-log-ts">{e.ts.slice(0, 19).replace("T", " ")}</span>
                              <span>{e.summary}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}

                  {connect ? <ExternalConnectPanel connect={connect} recipe={v.recipe} /> : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Model catalog — family grouping with variant counts */}
      <div className="cp-section-block">
        <SectionBand icon={<BotIcon />} title="Model catalog" count={active.length} />
        {groups.length === 0 ? (
          <EmptyState
            icon={<BotIcon />}
            title="No models found"
            subtitle="Register a model, then add deployment recipes describing how it runs on your nodes."
            action={
              <button type="button" className="cp-btn primary" onClick={() => setAdding(true)}>
                + Add model
              </button>
            }
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {groups.map((g) => (
              <div key={g.family}>
                <div className="cp-family-head">
                  <span className="cp-family-name">{g.family}</span>
                  <Chip>{g.variantCount} variant{g.variantCount === 1 ? "" : "s"}</Chip>
                  {g.deployedCount > 0 ? <Chip tone="accent">{g.deployedCount} deployed</Chip> : null}
                </div>
                <DataTable
                  ariaLabel={`${g.family} models`}
                  dense={dense}
                  columns={shownColumns}
                  rows={sortRows(g.models, catalogColumns.find((c) => c.key === sortKey), sortDir)}
                  rowKey={(m) => m.id}
                  onRowClick={(m) => navigate({ section: "model", modelId: m.id })}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={(k) => {
                    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                    else {
                      setSortKey(k);
                      setSortDir("asc");
                    }
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}
