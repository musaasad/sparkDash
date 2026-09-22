import { useMemo, useState } from "react";
import type { RecipePublic, RecipeRuntime, RecipeTopology, SparkSnapshot } from "../../api/types";
import { upsertRecipe } from "../../api/client";
import { Field, TextInput, Select, TextArea, FormSection, AdvancedDisclosure, FormFooter } from "../ui/form";

const RUNTIMES: RecipeRuntime[] = ["tabbyapi-exl3", "vllm", "sglang", "llama.cpp", "custom"];
const TOPOLOGIES: { id: RecipeTopology; label: string; nodes: number }[] = [
  { id: "single", label: "Single node", nodes: 1 },
  { id: "tp2", label: "Tensor-parallel ×2", nodes: 2 },
  { id: "tp3", label: "Tensor-parallel ×3", nodes: 3 },
];

interface RecipeEditorProps {
  modelId: string;
  existing?: RecipePublic | null;
  sparks: SparkSnapshot[];
  onSaved: () => void;
  onCancel: () => void;
}

interface Draft {
  id: string;
  name: string;
  runtime: RecipeRuntime;
  topology: RecipeTopology;
  nodeIds: string[];
  modelPath: string;
  workdir: string;
  apiPort: string;
  contextLength: string;
  healthPath: string;
  cpuAffinity: string;
  logDir: string;
  launcher: string;
  notes: string;
  env: { name: string; value: string; secret: boolean }[];
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

/** 3-step wizard (Model implicit) + collapsed Advanced + diff-style Review. */
export function RecipeEditor({ modelId, existing, sparks, onSaved, onCancel }: RecipeEditorProps) {
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => ({
    id: existing?.id ?? "",
    name: existing?.name ?? "",
    runtime: existing?.runtime ?? "tabbyapi-exl3",
    topology: existing?.topology ?? "single",
    nodeIds: existing?.nodeIds ?? [],
    modelPath: existing?.modelPath ?? "",
    workdir: existing?.workdir ?? "",
    apiPort: existing ? String(existing.apiPort) : "8889",
    contextLength: existing?.contextLength != null ? String(existing.contextLength) : "",
    healthPath: existing?.healthPath ?? "/v1/models",
    cpuAffinity: existing?.cpuAffinity ?? "",
    logDir: existing?.logDir ?? "",
    launcher: existing?.launcher ?? "",
    notes: existing?.notes ?? "",
    env: (existing?.env ?? []).map((e) => ({ name: e.name, value: e.value ?? "", secret: e.secret })),
  }));

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const topoNodes = TOPOLOGIES.find((t) => t.id === draft.topology)?.nodes ?? 1;

  const nodeOptions = useMemo(() => sparks.map((s) => ({ id: s.id, name: s.name })), [sparks]);

  function toggleNode(id: string) {
    setDraft((d) => {
      const has = d.nodeIds.includes(id);
      if (has) return { ...d, nodeIds: d.nodeIds.filter((n) => n !== id) };
      if (d.nodeIds.length >= topoNodes) return { ...d, nodeIds: [...d.nodeIds.slice(1), id] };
      return { ...d, nodeIds: [...d.nodeIds, id] };
    });
  }

  function validateStep(): string[] {
    const e: string[] = [];
    if (step === 0) {
      if (!draft.name.trim()) e.push("Recipe name is required");
      if (!draft.id.trim()) e.push("Recipe id is required");
      else if (!/^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/.test(draft.id)) e.push("Recipe id must be a lowercase slug");
    }
    if (step === 1) {
      if (!/^\/[A-Za-z0-9._/:@+-]+$/.test(draft.modelPath)) e.push("Model path must be an absolute POSIX path");
      if (!/^\/[A-Za-z0-9._/:@+-]+$/.test(draft.workdir)) e.push("Working directory must be an absolute POSIX path");
      const port = Number(draft.apiPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) e.push("API port must be 1–65535");
      if (draft.nodeIds.length !== topoNodes) e.push(`${draft.topology} requires exactly ${topoNodes} node(s)`);
      if (draft.cpuAffinity && !/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(draft.cpuAffinity)) e.push("CPU affinity must look like 5-9,15-19");
    }
    return e;
  }

  function next() {
    const e = validateStep();
    setErrors(e);
    if (e.length === 0) setStep((s) => Math.min(2, s + 1));
  }

  async function save() {
    setSaving(true);
    setErrors([]);
    try {
      await upsertRecipe({
        id: draft.id,
        modelId,
        name: draft.name,
        runtime: draft.runtime,
        topology: draft.topology,
        nodeIds: draft.nodeIds,
        modelPath: draft.modelPath,
        workdir: draft.workdir,
        logDir: draft.logDir || null,
        apiPort: Number(draft.apiPort),
        healthPath: draft.healthPath || "/v1/models",
        contextLength: draft.contextLength ? Number(draft.contextLength) : null,
        cpuAffinity: draft.cpuAffinity || null,
        launcher: draft.launcher || null,
        notes: draft.notes,
        metadata: existing?.metadata ?? {},
        env: draft.env.filter((e) => e.name.trim()),
      });
      onSaved();
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
    } finally {
      setSaving(false);
    }
  }

  const steps = ["Identity", "Runtime & Compute", "Review"];

  return (
    <div>
      <div className="cp-steps">
        {steps.map((label, i) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div className={`cp-step ${i === step ? "is-active" : i < step ? "is-done" : ""}`}>
              <span className="cp-step-num">{i < step ? "✓" : i + 1}</span>
              {label}
            </div>
            {i < steps.length - 1 ? <span className="cp-step-line" /> : null}
          </div>
        ))}
      </div>

      {errors.length > 0 ? (
        <div className="cp-panel" style={{ borderColor: "var(--color-danger)", marginBottom: 14 }}>
          {errors.map((e, i) => (
            <div key={i} className="cp-field-error">
              {e}
            </div>
          ))}
        </div>
      ) : null}

      {step === 0 ? (
        <FormSection legend="Recipe identity" columns={2}>
          <Field label="Friendly name" htmlFor="r-name">
            <TextInput
              id="r-name"
              value={draft.name}
              placeholder="TabbyAPI EXL3 (dgx-3)"
              onChange={(e) => {
                const name = e.target.value;
                setDraft((d) => ({ ...d, name, id: d.id || slugify(name) }));
              }}
            />
          </Field>
          <Field label="Recipe id" htmlFor="r-id" hint="Lowercase slug; unique across the lab">
            <TextInput id="r-id" mono value={draft.id} disabled={Boolean(existing)} onChange={(e) => set("id", e.target.value)} />
          </Field>
          <Field label="Notes" htmlFor="r-notes" style={{ gridColumn: "1 / -1" }}>
            <TextArea id="r-notes" rows={2} value={draft.notes} onChange={(e) => set("notes", e.target.value)} />
          </Field>
        </FormSection>
      ) : null}

      {step === 1 ? (
        <>
          <FormSection legend="Runtime & compute" columns={2}>
            <Field label="Runtime" htmlFor="r-runtime">
              <Select id="r-runtime" value={draft.runtime} onChange={(e) => set("runtime", e.target.value as RecipeRuntime)}>
                {RUNTIMES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Topology" htmlFor="r-topo">
              <Select id="r-topo" value={draft.topology} onChange={(e) => set("topology", e.target.value as RecipeTopology)}>
                {TOPOLOGIES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Model path" htmlFor="r-model" hint="Absolute POSIX path (validated)">
              <TextInput id="r-model" mono value={draft.modelPath} onChange={(e) => set("modelPath", e.target.value)} />
            </Field>
            <Field label="Working directory" htmlFor="r-workdir">
              <TextInput id="r-workdir" mono value={draft.workdir} onChange={(e) => set("workdir", e.target.value)} />
            </Field>
            <Field label="API port" htmlFor="r-port">
              <TextInput id="r-port" mono inputMode="numeric" value={draft.apiPort} onChange={(e) => set("apiPort", e.target.value)} />
            </Field>
            <Field label="Context length" htmlFor="r-ctx" hint="Optional">
              <TextInput id="r-ctx" mono inputMode="numeric" value={draft.contextLength} onChange={(e) => set("contextLength", e.target.value)} />
            </Field>
          </FormSection>

          <div style={{ marginBottom: 16 }}>
            <div className="cp-section-legend">Assigned nodes ({draft.nodeIds.length}/{topoNodes})</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {nodeOptions.length === 0 ? (
                <span className="cp-field-hint">No nodes registered — add one in Settings first.</span>
              ) : (
                nodeOptions.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    className={`cp-btn ${draft.nodeIds.includes(n.id) ? "primary" : ""}`}
                    onClick={() => toggleNode(n.id)}
                    aria-pressed={draft.nodeIds.includes(n.id)}
                  >
                    {n.name}
                  </button>
                ))
              )}
            </div>
          </div>

          <AdvancedDisclosure>
            <FormSection legend="Advanced" columns={2}>
              <Field label="Health path" htmlFor="r-health">
                <TextInput id="r-health" mono value={draft.healthPath} onChange={(e) => set("healthPath", e.target.value)} />
              </Field>
              <Field label="CPU affinity" htmlFor="r-affinity" hint='taskset list, e.g. "5-9,15-19"'>
                <TextInput id="r-affinity" mono value={draft.cpuAffinity} onChange={(e) => set("cpuAffinity", e.target.value)} />
              </Field>
              <Field label="Log directory" htmlFor="r-log" hint="Enables the Live Console (read-only tail)">
                <TextInput id="r-log" mono value={draft.logDir} onChange={(e) => set("logDir", e.target.value)} />
              </Field>
              <Field label="Launcher" htmlFor="r-launch" hint="Recorded metadata; never executed this phase">
                <TextInput id="r-launch" mono value={draft.launcher} onChange={(e) => set("launcher", e.target.value)} />
              </Field>
            </FormSection>
            <div className="cp-section-legend">Environment variables</div>
            {draft.env.map((e, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 2fr auto auto", gap: 8, marginBottom: 6, alignItems: "center" }}>
                <TextInput mono placeholder="NAME" value={e.name} onChange={(ev) => setDraft((d) => ({ ...d, env: d.env.map((x, j) => (j === i ? { ...x, name: ev.target.value } : x)) }))} />
                <TextInput mono placeholder="value" type={e.secret ? "password" : "text"} value={e.value} onChange={(ev) => setDraft((d) => ({ ...d, env: d.env.map((x, j) => (j === i ? { ...x, value: ev.target.value } : x)) }))} />
                <label style={{ fontSize: 11, display: "flex", gap: 4, alignItems: "center", color: "var(--color-muted)" }}>
                  <input type="checkbox" checked={e.secret} onChange={(ev) => setDraft((d) => ({ ...d, env: d.env.map((x, j) => (j === i ? { ...x, secret: ev.target.checked } : x)) }))} />
                  secret
                </label>
                <button type="button" className="cp-btn ghost" onClick={() => setDraft((d) => ({ ...d, env: d.env.filter((_, j) => j !== i) }))}>
                  ✕
                </button>
              </div>
            ))}
            <button type="button" className="cp-btn ghost" onClick={() => setDraft((d) => ({ ...d, env: [...d.env, { name: "", value: "", secret: false }] }))}>
              + Add variable
            </button>
          </AdvancedDisclosure>
        </>
      ) : null}

      {step === 2 ? (
        <div className="cp-panel">
          <div className="cp-panel-title">Review changes</div>
          <dl className="cp-kv">
            <dt>Recipe</dt>
            <dd>{draft.name}</dd>
            <dt>id</dt>
            <dd className="mono">{draft.id}</dd>
            <dt>Runtime</dt>
            <dd>{draft.runtime}</dd>
            <dt>Topology</dt>
            <dd>{draft.topology}</dd>
            <dt>Nodes</dt>
            <dd className="mono">{draft.nodeIds.join(", ") || "—"}</dd>
            <dt>Model path</dt>
            <dd className="mono">{draft.modelPath}</dd>
            <dt>Workdir</dt>
            <dd className="mono">{draft.workdir}</dd>
            <dt>API port</dt>
            <dd>{draft.apiPort}</dd>
            <dt>Context</dt>
            <dd>{draft.contextLength || "—"}</dd>
            <dt>Env vars</dt>
            <dd>{draft.env.filter((e) => e.name.trim()).map((e) => (e.secret ? `${e.name}=•••` : `${e.name}=${e.value}`)).join(", ") || "—"}</dd>
            <dt>Log dir</dt>
            <dd className="mono">{draft.logDir || "—"}</dd>
          </dl>
        </div>
      ) : null}

      <FormFooter onCancel={onCancel}>
        {step > 0 ? (
          <button type="button" className="cp-btn" onClick={() => setStep((s) => s - 1)}>
            Back
          </button>
        ) : null}
        {step < 2 ? (
          <button type="button" className="cp-btn primary" onClick={next}>
            Continue
          </button>
        ) : (
          <button type="button" className="cp-btn primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : existing ? "Save recipe" : "Create recipe"}
          </button>
        )}
      </FormFooter>
    </div>
  );
}