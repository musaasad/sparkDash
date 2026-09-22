import { useMemo, useState } from "react";
import type {
  RecipePublic,
  RecipeRuntime,
  RecipeTopology,
  RecipeTopologyBlock,
  TopologyMode,
  RecipeValidateResponse,
  SparkSnapshot,
} from "../../api/types";
import { upsertRecipe, validateDraftRecipe } from "../../api/client";
import { Field, TextInput, Select, TextArea, FormSection, AdvancedDisclosure, FormFooter } from "../ui/form";
import { Modal } from "../ui/Modal";
import { CloseIcon } from "../ui/icons";
import { LifecycleBadge, Chip } from "../ui/Status";
import { Stepper as RecipeStepper } from "../ui/Stepper";
import { useRuntimeOptions } from "./runtimeLabels";

/** v2 topology modes → default parallelism (chip-picker over the mode, not a slug). */
export const TOPOLOGY_MODES: { id: TopologyMode; label: string; nodes: number }[] = [
  { id: "single", label: "Single node", nodes: 1 },
  { id: "tp", label: "Tensor-parallel", nodes: 2 },
  { id: "pp", label: "Pipeline-parallel", nodes: 2 },
  { id: "dp", label: "Data-parallel", nodes: 2 },
  { id: "ep", label: "Expert-parallel", nodes: 2 },
];

const MECHANISMS = ["command", "systemd", "docker", "external"] as const;

export const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

/** Structured v2 recipe draft — engine / serving / launch / topology / probe / log / tags. */
export interface RecipeDraft {
  id: string;
  name: string;
  notes: string;
  tags: string;
  runtime: RecipeRuntime;
  quantization: string;
  apiProtocol: "openai" | "custom";
  contextLength: string;
  maxParallel: string;
  flags: { name: string; value: string }[];
  mechanism: (typeof MECHANISMS)[number];
  executable: string;
  args: string;
  workdir: string;
  cpuAffinity: string;
  env: { name: string; value: string; secret: boolean }[];
  scheme: "http" | "https";
  hostTemplate: string;
  apiPort: string;
  endpointPath: string;
  topoMode: TopologyMode;
  parallelism: string;
  minNodes: string;
  maxNodes: string;
  /** DEPLOYMENT topology degrees — explicit, NEVER inferred from node count. */
  tp: string;
  pp: string;
  dp: string;
  ep: string;
  /** PHYSICAL placement hints (separate from topology). */
  coordinator: string;
  workers: string;
  healthPath: string;
  logDir: string;
  nodeIds: string[];
}

export function emptyRecipeDraft(modelId: string, weightId?: string | null): RecipeDraft {
  void modelId;
  void weightId;
  return {
    id: "",
    name: "",
    notes: "",
    tags: "",
    runtime: "tabbyapi-exl3",
    quantization: "",
    apiProtocol: "openai",
    contextLength: "",
    maxParallel: "",
    flags: [],
    mechanism: "command",
    executable: "",
    args: "",
    workdir: "",
    cpuAffinity: "",
    env: [],
    scheme: "http",
    hostTemplate: "{nodeIp}",
    apiPort: "8889",
    endpointPath: "/v1",
    topoMode: "single",
    parallelism: "1",
    minNodes: "1",
    maxNodes: "1",
    tp: "",
    pp: "",
    dp: "",
    ep: "",
    coordinator: "",
    workers: "",
    healthPath: "/v1/models",
    logDir: "",
    nodeIds: [],
  };
}

export function draftFromRecipe(r: RecipePublic): RecipeDraft {
  return {
    id: r.id,
    name: r.name,
    notes: r.notes ?? "",
    tags: (r.tags ?? []).join(", "),
    runtime: r.engine?.runtime ?? r.runtime,
    quantization: r.engine?.quantization ?? "",
    apiProtocol: r.engine?.apiProtocol ?? "openai",
    contextLength: r.serving?.contextLength != null ? String(r.serving.contextLength) : "",
    maxParallel: r.serving?.maxParallel != null ? String(r.serving.maxParallel) : "",
    flags: (r.serving?.flags ?? []).map((f) => ({ name: f.name, value: f.value ?? "" })),
    mechanism: r.launch?.mechanism ?? "command",
    executable: r.launch?.executable ?? "",
    args: (r.launch?.args ?? []).join("\n"),
    workdir: r.launch?.workdir ?? r.workdir ?? "",
    cpuAffinity: r.launch?.affinity ?? r.cpuAffinity ?? "",
    env: (r.launch?.env ?? r.env ?? []).map((e) => ({ name: e.name, value: e.value ?? "", secret: Boolean(e.secret ?? e.secretRef) })),
    scheme: r.endpoint?.scheme ?? "http",
    hostTemplate: r.endpoint?.hostTemplate ?? "{nodeIp}",
    apiPort: String(r.endpoint?.port ?? r.apiPort),
    endpointPath: r.endpoint?.path ?? "/v1",
    topoMode: r.topologyBlock?.mode ?? "single",
    parallelism: String(r.topologyBlock?.parallelism ?? 1),
    minNodes: String(r.topologyBlock?.minNodes ?? (r.topologyBlock?.parallelism || 1)),
    maxNodes: String(r.topologyBlock?.maxNodes ?? (r.topologyBlock?.minNodes ?? r.topologyBlock?.parallelism ?? 1)),
    tp: r.topologyBlock?.tp != null ? String(r.topologyBlock.tp) : "",
    pp: r.topologyBlock?.pp != null ? String(r.topologyBlock.pp) : "",
    dp: r.topologyBlock?.dp != null ? String(r.topologyBlock.dp) : "",
    ep: r.topologyBlock?.ep != null ? String(r.topologyBlock.ep) : "",
    coordinator: r.topologyBlock?.coordinator ?? "",
    workers: r.topologyBlock?.workers != null ? String(r.topologyBlock.workers) : "",
    healthPath: r.healthProbe?.path ?? r.healthPath ?? "/v1/models",
    logDir: r.logSource?.path ?? r.logDir ?? "",
    nodeIds: [...(r.nodeIds ?? [])],
  };
}

/** Product of the SET degrees; 0 when NONE is set (⇒ topology unknown). */
export function degreeProduct(draft: RecipeDraft): number {
  const parts = [draft.tp, draft.pp, draft.dp, draft.ep].map(Number).filter((n) => n > 0);
  return parts.length ? parts.reduce((a, b) => a * b, 1) : 0;
}

/** >1 node placed but no degree set — must surface as "topology unknown". */
export function topologyUnknown(draft: RecipeDraft): boolean {
  return degreeProduct(draft) === 0 && draft.nodeIds.length > 1;
}

/** Structured WS-4 topology block for the draft. Degrees stay explicit/null. */
export function topologyBlockFromDraft(draft: RecipeDraft): RecipeTopologyBlock {
  const prod = degreeProduct(draft);
  const unknown = topologyUnknown(draft);
  const mode: TopologyMode =
    Number(draft.tp) > 1 ? "tp" : Number(draft.pp) > 1 ? "pp" : Number(draft.dp) > 1 ? "dp" : Number(draft.ep) > 1 ? "ep" : "single";
  return {
    mode,
    parallelism: prod || 1,
    tp: Number(draft.tp) || null,
    pp: Number(draft.pp) || null,
    dp: Number(draft.dp) || null,
    ep: Number(draft.ep) || null,
    coordinator: draft.coordinator || null,
    workers: Number(draft.workers) || null,
    minNodes: prod || Number(draft.minNodes) || 1,
    maxNodes: prod || Number(draft.maxNodes) || Number(draft.minNodes) || 1,
    nodeConstraints: {},
    unknown,
  };
}

/** Draft → v2 structured write body. Secret entries carry a stable secretRef. */
export function recipeBodyFromDraft(draft: RecipeDraft, modelId: string, weightId?: string | null): Record<string, unknown> {
  return {
    id: draft.id,
    modelRef: { modelId, weightId: weightId ?? null },
    name: draft.name.trim(),
    engine: { runtime: draft.runtime, quantization: draft.quantization || null, apiProtocol: draft.apiProtocol },
    serving: {
      contextLength: draft.contextLength ? Number(draft.contextLength) : null,
      maxParallel: draft.maxParallel ? Number(draft.maxParallel) : null,
      flags: draft.flags.filter((f) => f.name.trim()),
    },
    launch: {
      mechanism: draft.mechanism,
      executable: draft.executable || null,
      args: draft.args.split("\n").map((a) => a.trim()).filter(Boolean),
      workdir: draft.workdir || null,
      affinity: draft.cpuAffinity || null,
      env: draft.env
        .filter((e) => e.name.trim())
        .map((e) => ({
          name: e.name.trim(),
          value: e.value,
          secret: e.secret,
          secretRef: e.secret ? `recipe:${draft.id}:${e.name.trim()}` : null,
        })),
    },
    endpoint: { scheme: draft.scheme, hostTemplate: draft.hostTemplate || "{nodeIp}", port: Number(draft.apiPort), path: draft.endpointPath || "/v1" },
    topology: topologyBlockFromDraft(draft),
    healthProbe: { kind: "http", path: draft.healthPath || "/v1/models", expectUp: [200, 401, 403] },
    logSource: { kind: "file", path: draft.logDir || null },
    tags: draft.tags.split(",").map((t) => t.trim()).filter(Boolean),
    notes: draft.notes,
    nodeIds: draft.nodeIds,
    // Ownership follows mechanism: external is observe-only, else SparkDash-managed.
    metadata: { managedBy: draft.mechanism === "external" ? "external" : "sparkdash" },
  };
}

/** Inline local validation for the identity + compute steps. */
export function validateRecipeDraft(draft: RecipeDraft, step: "identity" | "runtime"): string[] {
  const e: string[] = [];
  if (step === "identity") {
    if (!draft.name.trim()) e.push("Recipe name is required.");
    if (!draft.id.trim()) e.push("Recipe id is required.");
    else if (!/^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/.test(draft.id)) e.push("Recipe id must be a lowercase slug.");
  }
  if (step === "runtime") {
    const port = Number(draft.apiPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) e.push("API port must be 1–65535.");
    if (draft.workdir && !/^\/[A-Za-z0-9._/:@+-]+$/.test(draft.workdir)) e.push("Working directory must be an absolute POSIX path.");
    if (draft.topoMode !== "single" && draft.mechanism === "systemd") e.push("systemd launcher is single-node only.");
    if (Number(draft.maxNodes) < Number(draft.minNodes)) e.push("maxNodes must be ≥ minNodes.");
  }
  return e;
}

export function topologyNodeRange(draft: RecipeDraft): { min: number; max: number } {
  return ((): { min: number; max: number } => {
    // Explicit degrees pin the node count exactly.
    const prod = degreeProduct(draft);
    if (prod > 0) return { min: prod, max: prod };
    // No degree yet ⇒ topology unknown and the node count stays free.
    return { min: 1, max: Math.max(2, draft.nodeIds.length + 1, Number(draft.maxNodes) || 1) };
  })();
}

interface RecipeEditorProps {
  modelId: string;
  existing?: RecipePublic | null;
  sparks: SparkSnapshot[];
  /** Runtime chips from the WS-3 registry (falls back to the registry hook). */
  runtimes?: { id: RecipeRuntime; label: string }[];
  onSaved: () => void;
  onCancel: () => void;
}

const STEPS = [
  { id: "identity", label: "Identity" },
  { id: "runtime", label: "Runtime & compute" },
  { id: "advanced", label: "Advanced" },
  { id: "review", label: "Review" },
];

/**
 * Structured v2 recipe editor. Common settings first, advanced behind a
 * disclosure, inline validation deferred to Continue/Save. Never executes a
 * command — validation is a DRY-RUN POST to the WS-1 validate route.
 */
export function RecipeEditor({ modelId, existing, sparks, runtimes, onSaved, onCancel }: RecipeEditorProps) {
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [draft, setDraft] = useState<RecipeDraft>(() => (existing ? draftFromRecipe(existing) : emptyRecipeDraft(modelId)));

  const readOnly = Boolean(existing?.archived) || existing?.lifecycleState === "archived";
  // Dirty guard (spec §6): any edit from the initial draft.
  const initialDraft = useMemo(
    () => JSON.stringify(existing ? draftFromRecipe(existing) : emptyRecipeDraft(modelId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const dirty = JSON.stringify(draft) !== initialDraft;
  const set = <K extends keyof RecipeDraft>(k: K, v: RecipeDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const range = topologyNodeRange(draft);
  const registryOptions = useRuntimeOptions();
  const runtimesList = useMemo<{ id: string; label: string }[]>(() => {
    if (runtimes?.length) return runtimes;
    if (registryOptions.length) return registryOptions;
    return [{ id: draft.runtime, label: draft.runtime }];
  }, [runtimes, registryOptions, draft.runtime]);

  const nodeOptions = useMemo(() => sparks.map((s) => ({ id: s.id, name: s.name, online: s.online })), [sparks]);

  function toggleNode(id: string) {
    setDraft((d) => {
      const has = d.nodeIds.includes(id);
      if (has) return { ...d, nodeIds: d.nodeIds.filter((n) => n !== id) };
      if (d.nodeIds.length >= range.max) return { ...d, nodeIds: [...d.nodeIds.slice(1), id] };
      return { ...d, nodeIds: [...d.nodeIds, id] };
    });
  }

  function next() {
    const stage = step === 0 ? "identity" : step === 1 ? "runtime" : null;
    const e = stage ? validateRecipeDraft(draft, stage) : [];
    setErrors(e);
    if (e.length === 0) setStep((s) => Math.min(STEPS.length - 1, s + 1));
  }

  async function persist(): Promise<RecipePublic | null> {
    const res = await upsertRecipe(recipeBodyFromDraft(draft, modelId));
    return res.recipe;
  }

  async function runValidate() {
    setValidating(true);
    setErrors([]);
    setWarnings([]);
    try {
      const local = validateRecipeDraft(draft, "identity").concat(validateRecipeDraft(draft, "runtime"));
      if (local.length) {
        setErrors(local);
        return;
      }
      // Validate the UNSAVED body — no entities are materialised here, so
      // cancelling leaves nothing behind. Save persists atomically.
      const res: RecipeValidateResponse = await validateDraftRecipe(
        recipeBodyFromDraft(draft, modelId),
        draft.nodeIds
      );
      setWarnings(res.warnings);
      setErrors(res.errors);
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
    } finally {
      setValidating(false);
    }
  }

  async function save(): Promise<boolean> {
    const local = validateRecipeDraft(draft, "identity").concat(validateRecipeDraft(draft, "runtime"));
    setErrors(local);
    if (local.length) {
      setStep(0);
      return false;
    }
    setSaving(true);
    try {
      await persist();
      onSaved();
      return true;
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
      return false;
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <span className={`cp-step-label`} style={{ fontSize: 14, fontWeight: 600 }}>
          {existing ? "Edit recipe" : "New recipe"}
        </span>
        {existing?.lifecycleState ? <LifecycleBadge state={existing.lifecycleState} /> : null}
        {readOnly ? <Chip>read-only</Chip> : null}
      </div>

      <RecipeStepper steps={STEPS} current={step} onSelect={setStep} />

      {errors.length > 0 ? (
        <div className="cp-panel" style={{ borderColor: "var(--color-danger)", marginBottom: 14 }} role="alert">
          {errors.map((e, i) => (
            <div key={i} className="cp-field-error">
              {e}
            </div>
          ))}
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <div className="cp-panel" style={{ borderColor: "var(--color-warning)", marginBottom: 14 }}>
          {warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 11, color: "var(--color-warning)" }}>
              {w}
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
              disabled={readOnly}
              placeholder="TabbyAPI EXL3 (dgx-3)"
              onChange={(e) => {
                const name = e.target.value;
                setDraft((d) => ({ ...d, name, id: d.id || slugify(name) }));
              }}
            />
          </Field>
          <Field label="Recipe id" htmlFor="r-id" hint="Lowercase slug; unique across the lab">
            <TextInput id="r-id" mono value={draft.id} disabled={readOnly || Boolean(existing)} onChange={(e) => set("id", e.target.value)} />
          </Field>
          <Field label="Tags" htmlFor="r-tags" hint="Comma separated">
            <TextInput id="r-tags" value={draft.tags} disabled={readOnly} onChange={(e) => set("tags", e.target.value)} />
          </Field>
          <Field label="Notes" htmlFor="r-notes">
            <TextArea id="r-notes" rows={2} value={draft.notes} disabled={readOnly} onChange={(e) => set("notes", e.target.value)} />
          </Field>
        </FormSection>
      ) : null}

      {step === 1 ? (
        <>
          <FormSection legend="Runtime & serving" columns={2}>
            <Field label="Runtime provider" htmlFor="r-runtime" hint="Source: WS-3 provider registry">
              <div role="radiogroup" aria-label="Runtime provider" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {runtimesList.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    role="radio"
                    aria-checked={draft.runtime === r.id}
                    className={`cp-pick ${draft.runtime === r.id ? "is-selected" : ""}`}
                    disabled={readOnly}
                    onClick={() => set("runtime", r.id)}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="quantization" htmlFor="r-quant" hint="e.g. EXL3 4.0bpw">
              <TextInput id="r-quant" mono value={draft.quantization} disabled={readOnly} onChange={(e) => set("quantization", e.target.value)} />
            </Field>
            <Field label="Context length" htmlFor="r-ctx" hint="Tokens">
              <TextInput id="r-ctx" mono inputMode="numeric" value={draft.contextLength} disabled={readOnly} onChange={(e) => set("contextLength", e.target.value)} />
            </Field>
            <Field label="Max parallel" htmlFor="r-mpar" hint="Concurrent slots">
              <TextInput id="r-mpar" mono inputMode="numeric" value={draft.maxParallel} disabled={readOnly} onChange={(e) => set("maxParallel", e.target.value)} />
            </Field>
          </FormSection>

          <FormSection legend="Endpoint" columns={2}>
            <Field label="Scheme" htmlFor="r-scheme">
              <Select id="r-scheme" value={draft.scheme} disabled={readOnly} onChange={(e) => set("scheme", e.target.value as "http" | "https")}>
                <option value="http">http</option>
                <option value="https">https</option>
              </Select>
            </Field>
            <Field label="API port" htmlFor="r-port">
              <TextInput id="r-port" mono inputMode="numeric" value={draft.apiPort} disabled={readOnly} onChange={(e) => set("apiPort", e.target.value)} />
            </Field>
            <Field label="Path" htmlFor="r-path" hint="OpenAI-compatible base">
              <TextInput id="r-path" mono value={draft.endpointPath} disabled={readOnly} onChange={(e) => set("endpointPath", e.target.value)} />
            </Field>
            <Field label="API protocol" htmlFor="r-proto">
              <Select id="r-proto" value={draft.apiProtocol} disabled={readOnly} onChange={(e) => set("apiProtocol", e.target.value as "openai" | "custom")}>
                <option value="openai">openai</option>
                <option value="custom">custom</option>
              </Select>
            </Field>
          </FormSection>

          <FormSection legend="Topology & node binding" columns={2}>
            <Field label="Topology mode" htmlFor="r-topo">
              <Select id="r-topo" value={draft.topoMode} disabled={readOnly} onChange={(e) => set("topoMode", e.target.value as TopologyMode)}>
                {TOPOLOGY_MODES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Parallelism" htmlFor="r-par" hint="tp/pp/dp × N">
              <TextInput id="r-par" mono inputMode="numeric" value={draft.parallelism} disabled={readOnly} onChange={(e) => set("parallelism", e.target.value)} />
            </Field>
            <Field label="Min nodes" htmlFor="r-min">
              <TextInput id="r-min" mono inputMode="numeric" value={draft.minNodes} disabled={readOnly} onChange={(e) => set("minNodes", e.target.value)} />
            </Field>
            <Field label="Max nodes" htmlFor="r-max">
              <TextInput id="r-max" mono inputMode="numeric" value={draft.maxNodes} disabled={readOnly} onChange={(e) => set("maxNodes", e.target.value)} />
            </Field>
          </FormSection>

          <FormSection legend="Explicit degrees (blank = unknown — never inferred from nodes)" columns={4}>
            <Field label="TP" htmlFor="r-tp">
              <TextInput id="r-tp" mono inputMode="numeric" value={draft.tp} disabled={readOnly} onChange={(e) => set("tp", e.target.value)} />
            </Field>
            <Field label="PP" htmlFor="r-pp">
              <TextInput id="r-pp" mono inputMode="numeric" value={draft.pp} disabled={readOnly} onChange={(e) => set("pp", e.target.value)} />
            </Field>
            <Field label="DP" htmlFor="r-dp">
              <TextInput id="r-dp" mono inputMode="numeric" value={draft.dp} disabled={readOnly} onChange={(e) => set("dp", e.target.value)} />
            </Field>
            <Field label="EP" htmlFor="r-ep">
              <TextInput id="r-ep" mono inputMode="numeric" value={draft.ep} disabled={readOnly} onChange={(e) => set("ep", e.target.value)} />
            </Field>
          </FormSection>

          <div style={{ marginBottom: 16 }}>
            <div className="cp-section-legend">
              Assigned nodes ({draft.nodeIds.length}/{range.min === range.max ? range.min : `${range.min}–${range.max}`})
            </div>
            {draft.nodeIds.length < range.min || draft.nodeIds.length > range.max ? (
              <div className="cp-field-error" role="alert">
                {range.min === range.max
                  ? `Topology requires exactly ${range.min} node(s).`
                  : `Topology requires ${range.min}–${range.max} node(s).`}
              </div>
            ) : null}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
              {nodeOptions.length === 0 ? (
                <span className="cp-field-hint">No nodes registered — add one in Settings first.</span>
              ) : (
                nodeOptions.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    className={`cp-pick ${draft.nodeIds.includes(n.id) ? "is-selected" : ""}`}
                    disabled={readOnly}
                    onClick={() => toggleNode(n.id)}
                    aria-pressed={draft.nodeIds.includes(n.id)}
                  >
                    {n.name}
                    {!n.online ? <span className="cp-field-hint"> · offline</span> : null}
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      ) : null}

      {step === 2 ? (
        <AdvancedDisclosure label="Advanced configuration" >
          <FormSection legend="Launch" columns={2}>
            <Field label="Mechanism" htmlFor="r-mech" hint="Recorded metadata — never executed this phase">
              <Select id="r-mech" value={draft.mechanism} disabled={readOnly} onChange={(e) => set("mechanism", e.target.value as RecipeDraft["mechanism"])}>
                {MECHANISMS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Executable" htmlFor="r-exec">
              <TextInput id="r-exec" mono value={draft.executable} disabled={readOnly} onChange={(e) => set("executable", e.target.value)} />
            </Field>
            <Field label="Working directory" htmlFor="r-workdir">
              <TextInput id="r-workdir" mono value={draft.workdir} disabled={readOnly} onChange={(e) => set("workdir", e.target.value)} />
            </Field>
            <Field label="CPU affinity" htmlFor="r-affinity" hint='taskset list, e.g. "5-9,15-19"'>
              <TextInput id="r-affinity" mono value={draft.cpuAffinity} disabled={readOnly} onChange={(e) => set("cpuAffinity", e.target.value)} />
            </Field>
            <Field label="Launch args" htmlFor="r-args" hint="One per line" style={{ gridColumn: "1 / -1" }}>
              <TextArea id="r-args" mono rows={3} value={draft.args} disabled={readOnly} onChange={(e) => set("args", e.target.value)} />
            </Field>
            <Field label="Health path" htmlFor="r-health">
              <TextInput id="r-health" mono value={draft.healthPath} disabled={readOnly} onChange={(e) => set("healthPath", e.target.value)} />
            </Field>
            <Field label="Log directory" htmlFor="r-log" hint="Enables the Live Console (read-only tail)">
              <TextInput id="r-log" mono value={draft.logDir} disabled={readOnly} onChange={(e) => set("logDir", e.target.value)} />
            </Field>
          </FormSection>

          <FormSection legend="Serving flags" columns={2}>
            {draft.flags.map((f, i) => (
              <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <TextInput
                  mono
                  placeholder="--flag"
                  value={f.name}
                  disabled={readOnly}
                  onChange={(e) => setDraft((d) => ({ ...d, flags: d.flags.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) }))}
                />
                <TextInput
                  mono
                  placeholder="value"
                  value={f.value}
                  disabled={readOnly}
                  onChange={(e) => setDraft((d) => ({ ...d, flags: d.flags.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) }))}
                />
                <button type="button" className="cp-btn ghost" disabled={readOnly} onClick={() => setDraft((d) => ({ ...d, flags: d.flags.filter((_, j) => j !== i) }))}>
                  <CloseIcon size={12} />
                </button>
              </div>
            ))}
            <button type="button" className="cp-btn ghost" disabled={readOnly} onClick={() => setDraft((d) => ({ ...d, flags: [...d.flags, { name: "", value: "" }] }))}>
              + Add flag
            </button>
          </FormSection>

          <FormSection legend="Environment (secret entries stay as secretRef)" columns={1}>
            {draft.env.map((e, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 2fr auto auto", gap: 8, alignItems: "center" }}>
                <TextInput mono placeholder="NAME" value={e.name} disabled={readOnly} onChange={(ev) => setDraft((d) => ({ ...d, env: d.env.map((x, j) => (j === i ? { ...x, name: ev.target.value } : x)) }))} />
                <TextInput
                  mono
                  placeholder={e.secret ? "value (stored server-side)" : "value"}
                  type={e.secret ? "password" : "text"}
                  value={e.value}
                  disabled={readOnly}
                  onChange={(ev) => setDraft((d) => ({ ...d, env: d.env.map((x, j) => (j === i ? { ...x, value: ev.target.value } : x)) }))}
                />
                <label style={{ fontSize: 11, display: "flex", gap: 4, alignItems: "center", color: "var(--color-muted)" }}>
                  <input type="checkbox" checked={e.secret} disabled={readOnly} onChange={(ev) => setDraft((d) => ({ ...d, env: d.env.map((x, j) => (j === i ? { ...x, secret: ev.target.checked } : x)) }))} />
                  secret
                </label>
                <button type="button" className="cp-btn ghost" disabled={readOnly} onClick={() => setDraft((d) => ({ ...d, env: d.env.filter((_, j) => j !== i) }))}>
                  <CloseIcon size={12} />
                </button>
              </div>
            ))}
            <button type="button" className="cp-btn ghost" disabled={readOnly} onClick={() => setDraft((d) => ({ ...d, env: [...d.env, { name: "", value: "", secret: false }] }))}>
              + Add variable
            </button>
          </FormSection>
        </AdvancedDisclosure>
      ) : null}

      {step === 3 ? (
        <div className="cp-panel">
          <div className="cp-panel-title">Review changes</div>
          <dl className="cp-kv">
            <dt>Recipe</dt>
            <dd>{draft.name}</dd>
            <dt>id</dt>
            <dd className="mono">{draft.id}</dd>
            <dt>Runtime</dt>
            <dd>{runtimesList.find((r) => r.id === draft.runtime)?.label ?? draft.runtime}</dd>
            <dt>Quantization</dt>
            <dd className="mono">{draft.quantization || "—"}</dd>
            <dt>Topology</dt>
            <dd className="mono">
              {draft.topoMode}
              {draft.topoMode !== "single" ? `×${draft.parallelism}` : ""} ({range.min}–{range.max} nodes)
            </dd>
            <dt>Nodes</dt>
            <dd className="mono">{draft.nodeIds.join(", ") || "—"}</dd>
            <dt>Endpoint</dt>
            <dd className="mono">
              {draft.scheme}://{draft.hostTemplate}:{draft.apiPort}
              {draft.endpointPath}
            </dd>
            <dt>Context</dt>
            <dd>{draft.contextLength || "—"}</dd>
            <dt>Env vars</dt>
            <dd className="mono">
              {draft.env.filter((e) => e.name.trim()).map((e) => e.name + (e.secret ? "→secretRef" : `=${e.value}`)).join(", ") || "—"}
            </dd>
            <dt>Log dir</dt>
            <dd className="mono">{draft.logDir || "—"}</dd>
          </dl>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
            <button type="button" className="cp-btn" onClick={runValidate} disabled={validating}>
              {validating ? "Validating…" : "Validate (dry-run)"}
            </button>
          </div>
        </div>
      ) : null}

      <FormFooter
        onCancel={() => {
          if (dirty && !readOnly) setCancelOpen(true);
          else onCancel();
        }}
        cancelLabel={readOnly ? "Close" : "Cancel"}
      >
        {step > 0 ? (
          <button type="button" className="cp-btn" onClick={() => setStep((s) => s - 1)}>
            Back
          </button>
        ) : null}
        {step < STEPS.length - 1 ? (
          <button type="button" className="cp-btn primary" onClick={next}>
            Continue
          </button>
        ) : (
          <button
            type="button"
            className="cp-btn primary"
            onClick={() => {
              void save().then((ok) => {
                if (ok) onCancel();
              });
            }}
            disabled={saving || readOnly}
          >
            {saving ? "Saving…" : existing ? "Save recipe" : "Create recipe"}
          </button>
        )}
      </FormFooter>

      {/* Dirty-state guard: leaving the editor with unsaved edits. */}
      <Modal
        open={cancelOpen}
        title="Discard recipe edits?"
        consequence="The editor has unsaved fields. Saving writes the recipe; discarding drops the edits."
        confirmLabel="Save"
        discardLabel="Discard"
        cancelLabel="Cancel"
        busy={saving}
        onConfirm={async () => {
          const ok = await save();
          if (ok) {
            setCancelOpen(false);
            onCancel();
          }
        }}
        onDiscard={() => {
          setCancelOpen(false);
          onCancel();
        }}
        onClose={() => setCancelOpen(false)}
      />
    </div>
  );
}
