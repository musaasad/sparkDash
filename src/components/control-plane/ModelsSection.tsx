import { useMemo, useState } from "react";
import type { ModelEntry, RecipePublic, DeploymentStatus } from "../../api/types";
import type { Route } from "../../hooks/router";
import { DataTable, sortRows, type Column } from "../ui/DataTable";
import { StatusPill, Chip, EmptyState } from "../ui/Status";
import { Field, TextInput, FormFooter } from "../ui/form";
import { upsertModel } from "../../api/client";

interface ModelsProps {
  models: ModelEntry[];
  recipes: RecipePublic[];
  deployments: readonly DeploymentStatus[];
  navigate: (route: Route) => void;
  onSaved: () => void;
}

export function ModelsSection({ models, recipes, deployments, navigate, onSaved }: ModelsProps) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [family, setFamily] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [sortKey, setSortKey] = useState<string | null>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const active = useMemo(() => models.filter((m) => !m.archived), [models]);

  const columns: Column<ModelEntry>[] = [
    {
      key: "name",
      header: "Model",
      sortable: true,
      sortValue: (m) => m.name.toLowerCase(),
      render: (m) => (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 500 }}>{m.name}</span>
          {m.family ? <Chip>{m.family}</Chip> : null}
          {m.archived ? <Chip>archived</Chip> : null}
        </div>
      ),
    },
    { key: "id", header: "id", mono: true, muted: true, render: (m) => m.id },
    {
      key: "recipes",
      header: "Recipes",
      align: "right",
      sortable: true,
      sortValue: (m) => recipes.filter((r) => r.modelId === m.id && !r.archived).length,
      render: (m) => String(recipes.filter((r) => r.modelId === m.id && !r.archived).length),
    },
    {
      key: "status",
      header: "Deployment",
      render: (m) => {
        const deps = deployments.filter((d) => d.modelId === m.id);
        if (deps.length === 0) return <span className="muted">not deployed</span>;
        const worst = deps.find((d) => d.state === "error") || deps.find((d) => d.state === "running") || deps[0];
        return <StatusPill status={worst.state as never} />;
      },
    },
  ];

  const rows = useMemo(() => sortRows(active, columns.find((c) => c.key === sortKey), sortDir), [active, columns, sortKey, sortDir]);

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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div>
          <div className="cp-section-title">Models</div>
          <div className="cp-section-sub">The model registry — a model can have many deployment recipes.</div>
        </div>
        <button type="button" className="cp-btn primary" style={{ marginLeft: "auto" }} onClick={() => setAdding((a) => !a)}>
          {adding ? "Cancel" : "+ Add model"}
        </button>
      </div>

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

      <DataTable
        ariaLabel="Model registry"
        columns={columns}
        rows={rows}
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
        empty={
          <EmptyState
            title="No models registered"
            subtitle="Register a model, then add deployment recipes describing how it runs on your nodes."
            action={
              <button type="button" className="cp-btn primary" onClick={() => setAdding(true)}>
                + Add model
              </button>
            }
          />
        }
      />
    </div>
  );
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}