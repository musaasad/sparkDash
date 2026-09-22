import { useMemo, useState } from "react";
import type { ModelEntry, RecipePublic, RecipeRuntime, SparkSnapshot } from "../../api/types";
import type { Route } from "../../hooks/router";
import { upsertModel, upsertRecipe, duplicateRecipe, validateRecipe, validateDraftRecipe, createDeployment, archiveModel } from "../../api/client";
import { Field, TextInput, TextArea, Select, FormSection, AdvancedDisclosure, FormFooter } from "../ui/form";
import { Modal } from "../ui/Modal";
import { CloseIcon } from "../ui/icons";
import { TemplatePicker, type TemplatePickerItem } from "../ui/TemplatePicker";
import { Stepper } from "../ui/Stepper";
import { Chip, LifecycleBadge, StatusDot } from "../ui/Status";
import { BoltIcon, MemoryIcon, NetworkIcon, ExternalManagedIcon } from "../ui/icons";
import {
  RecipeEditor,
  emptyRecipeDraft,
  recipeBodyFromDraft,
  validateRecipeDraft,
  topologyNodeRange,
  draftFromRecipe,
  slugify,
  type RecipeDraft,
} from "./RecipeEditor";
import { useRuntimeOptions } from "./runtimeLabels";

const STEPS = [
  { id: "model", label: "Model" },
  { id: "recipe", label: "Recipe" },
  { id: "runtime", label: "Runtime" },
  { id: "compute", label: "Compute" },
  { id: "options", label: "Options" },
  { id: "validate", label: "Validate" },
  { id: "review", label: "Review" },
  { id: "save", label: "Save" },
];

/** Spec §7 template picker seed — every field stays editable after a pick. */
const MODEL_TEMPLATES: TemplatePickerItem[] = [
  {
    id: "vllm-openai",
    name: "vLLM · OpenAI serve",
    description: "Command launch, OpenAI-compatible endpoint, 32k context.",
    icon: <BoltIcon size={20} />,
  },
  {
    id: "tabbyapi-exl3",
    name: "TabbyAPI · EXL3",
    description: "Quantized EXL3 serving with a proven recipe shape.",
    icon: <MemoryIcon size={20} />,
  },
  {
    id: "sglang",
    name: "SGLang server",
    description: "High-throughput serving with structured runtime flags.",
    icon: <NetworkIcon size={20} />,
  },
  {
    id: "external",
    name: "External / observed",
    description: "Launched outside SparkDash; binding only, controls stay disabled.",
    icon: <ExternalManagedIcon size={20} />,
  },
  {
    id: "vllm-tp",
    name: "vLLM · tensor-parallel",
    description: "Multi-node TP topology with node bounds pre-set.",
    icon: <BoltIcon size={20} />,
  },
  {
    id: "vllm-dp",
    name: "vLLM · data-parallel",
    description: "Replica DP topology across the fleet.",
    icon: <NetworkIcon size={20} />,
  },
];

interface WizardModel {
  id: string;
  name: string;
  family: string;
  weightPath: string;
  variants: { id: string; path: string }[];
}

interface ModelWizardProps {
  models: ModelEntry[];
  recipes: RecipePublic[];
  sparks: SparkSnapshot[];
  runtimes?: { id: RecipeRuntime; label: string }[];
  navigate: (route: Route) => void;
  onSaved: () => void;
  onCancel: () => void;
  /** Pre-select an existing model (wizard launched from a model surface). */
  initialModelId?: string;
}

/**
 * Guided Add-Model wizard (DESIGN_LANGCHAIN §7). Progressive disclosure: common
 * settings first, everything else behind a disclosure, smart defaults pre-filled,
 * inline validation. Config-only — Save writes entities via the existing WS-1/WS-3
 * endpoints and NEVER starts/stops/signals a real process.
 */
export function ModelWizard({
  models,
  recipes,
  sparks,
  runtimes,
  navigate,
  onSaved,
  onCancel,
  initialModelId,
}: ModelWizardProps) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [onPicker, setOnPicker] = useState(!initialModelId);

  const [modelMode, setModelMode] = useState<"existing" | "new">(initialModelId ? "existing" : "new");
  const [modelId, setModelId] = useState(initialModelId ?? "");
  const [model, setModel] = useState<WizardModel>({ id: "", name: "", family: "", weightPath: "", variants: [] });

  const [recipeMode, setRecipeMode] = useState<"existing" | "duplicate" | "new">("new");
  const [srcRecipeId, setSrcRecipeId] = useState("");
  const [dupId, setDupId] = useState("");
  const [draft, setDraft] = useState<RecipeDraft>(() => emptyRecipeDraft(initialModelId ?? ""));

  /** Entity ids materialised at validate time (config only). */
  const [savedModelId, setSavedModelId] = useState<string | null>(initialModelId ?? null);
  const [savedRecipeId, setSavedRecipeId] = useState<string | null>(null);

  const isinstance = models.filter((m) => !m.archived);
  const registryOptions = useRuntimeOptions();
  const runtimesList = runtimes?.length ? runtimes : registryOptions;
  const range = topologyNodeRange(draft);

  // Dirty guard (spec §6): any user edit from the initial state.
  const initialSnapshot = useMemo(
    () => JSON.stringify({ modelMode, model, recipeMode, srcRecipeId, dupId, draft }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const dirty = JSON.stringify({ modelMode, model, recipeMode, srcRecipeId, dupId, draft }) !== initialSnapshot;

  const modelForRecipes = modelMode === "existing" ? modelId : model.id || slugify(model.name);
  const recipesForModel = useMemo(
    () => recipes.filter((r) => r.modelId === modelForRecipes && !r.archived),
    [recipes, modelForRecipes]
  );

  const externalRecipe = useMemo(() => {
    if (recipeMode === "existing" && srcRecipeId) return recipes.find((r) => r.id === srcRecipeId);
    if (recipeMode === "duplicate" && srcRecipeId) return recipes.find((r) => r.id === srcRecipeId);
    return null;
  }, [recipeMode, srcRecipeId, recipes]);

  const wantsExternal = externalRecipe?.launch?.mechanism === "external" || draft.mechanism === "external";
  const desiredState = wantsExternal ? "unknown" : "stopped";

  const set = <K extends keyof RecipeDraft>(k: K, v: RecipeDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  function toggleNode(id: string) {
    setDraft((d) => {
      const has = d.nodeIds.includes(id);
      if (has) return { ...d, nodeIds: d.nodeIds.filter((n) => n !== id) };
      if (d.nodeIds.length >= range.max) return { ...d, nodeIds: [...d.nodeIds.slice(1), id] };
      return { ...d, nodeIds: [...d.nodeIds, id] };
    });
  }

  /** Seed the draft from a picked template (still fully editable). */
  function applyTemplate(id: string) {
    const preset = ({
      "vllm-openai": { runtime: "vllm", mechanism: "command", apiProtocol: "openai", contextLength: "32768" },
      "tabbyapi-exl3": { runtime: "tabbyapi-exl3", quantization: "EXL3 4.0bpw", contextLength: "16384" },
      sglang: { runtime: "sglang", mechanism: "command", contextLength: "32768" },
      external: { runtime: "vllm", mechanism: "external", apiProtocol: "openai" },
      "vllm-tp": { runtime: "vllm", topoMode: "tp", parallelism: "2", minNodes: "2", maxNodes: "2" },
      "vllm-dp": { runtime: "vllm", topoMode: "dp", parallelism: "2", minNodes: "2", maxNodes: "4" },
    } as Record<string, Partial<RecipeDraft>>)[id];
    if (preset) setDraft((d) => ({ ...d, ...preset }));
    setOnPicker(false);
  }

  function validateStep(): string[] {
    const e: string[] = [];
    if (step === 0) {
      if (modelMode === "new") {
        if (!model.name.trim()) e.push("Model name is required.");
        if (!model.id.trim()) e.push("Model id is required.");
        else if (!/^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/.test(model.id)) e.push("Model id must be a lowercase slug.");
        if (model.weightPath && !/^\/[A-Za-z0-9._/:@+-]+$/.test(model.weightPath)) e.push("Weight path must be an absolute POSIX path.");
      } else if (!modelId) e.push("Pick a model, or create a new one.");
    }
    if (step === 1) {
      if (recipeMode === "existing" && !srcRecipeId) e.push("Pick an existing recipe.");
      if (recipeMode === "duplicate" && !srcRecipeId) e.push("Pick a recipe to duplicate.");
      if (recipeMode === "new") e.push(...validateRecipeDraft(draft, "identity"));
      if (recipeMode !== "existing" && !draft.name.trim()) e.push("Recipe name is required.");
    }
    if (step === 2) e.push(...validateRecipeDraft(draft, "runtime"));
    if (step === 3) {
      if (draft.nodeIds.length < range.min || draft.nodeIds.length > range.max)
        e.push(
          range.min === range.max
            ? `Topology requires exactly ${range.min} node(s).`
            : `Topology requires ${range.min}–${range.max} node(s).`
        );
    }
    if (step === 5 && errors.length > 0) e.push(...errors);
    return e;
  }

  /** The recipe write body implied by the current draft (nothing persisted). */
  function draftRecipeBody(): Record<string, unknown> {
    const mid = modelMode === "existing" ? modelId : model.id || slugify(model.name);
    return recipeBodyFromDraft(draft, mid);
  }

  /**
   * Validate the intended UNSAVED body. No entity is created here, so cancelling
   * after Validate leaves no orphan draft model/recipe. Save persists atomically.
   */
  async function runValidate(): Promise<boolean> {
    setBusy(true);
    setErrors([]);
    setWarnings([]);
    try {
      if (recipeMode === "existing") {
        if (!srcRecipeId) {
          setErrors(["Pick an existing recipe."]);
          return false;
        }
        const res = await validateRecipe(srcRecipeId, draft.nodeIds);
        setWarnings(res.warnings);
        setErrors(res.errors);
        return res.ok;
      }
      let body: Record<string, unknown>;
      if (recipeMode === "duplicate") {
        const src = recipes.find((r) => r.id === srcRecipeId);
        if (!src) {
          setErrors(["Pick a recipe to duplicate."]);
          return false;
        }
        body = recipeBodyFromDraft(draftFromRecipe(src), modelForRecipes);
        if (dupId.trim()) body.id = dupId.trim();
      } else {
        body = draftRecipeBody();
      }
      const res = await validateDraftRecipe(body, draft.nodeIds);
      setWarnings(res.warnings);
      setErrors(res.errors);
      return res.ok;
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function next() {
    const e = validateStep();
    setErrors(e);
    if (e.length > 0) return;
    const target = step + 1;
    if (target === 5) {
      void runValidate().then(() => setStep(target));
      return;
    }
    setStep(target);
  }

  async function save(): Promise<boolean> {
    setBusy(true);
    setErrors([]);
    try {
      let mid = savedModelId;
      let createdModel = false;
      if (!mid) {
        if (modelMode === "existing") {
          mid = modelId;
        } else {
          const created = await upsertModel({
            id: model.id.trim(),
            name: model.name.trim(),
            family: model.family || null,
            weightPaths: {
              ...(model.weightPath ? { default: model.weightPath } : {}),
              ...Object.fromEntries(model.variants.filter((v) => v.id && v.path).map((v) => [v.id, v.path])),
            },
          });
          mid = created.model.id;
          createdModel = true;
          setSavedModelId(mid);
        }
      }

      let rid = savedRecipeId;
      try {
        if (!rid) {
          if (recipeMode === "existing") {
            rid = srcRecipeId;
          } else if (recipeMode === "duplicate") {
            const newId = (dupId.trim() || `${srcRecipeId}-copy`).trim();
            const res = await duplicateRecipe(srcRecipeId, newId);
            rid = res.recipe.id;
          } else {
            const res = await upsertRecipe(recipeBodyFromDraft(draft, mid));
            rid = res.recipe.id;
          }
          setSavedRecipeId(rid);
        }
      } catch (err) {
        // Never leave an orphan model behind when the recipe write fails.
        if (createdModel && mid) await archiveModel(mid, true);
        throw err;
      }

      const check = await validateRecipe(rid, draft.nodeIds);
      if (!check.ok) {
        setErrors(check.errors);
        setWarnings(check.warnings);
        setStep(5);
        return false;
      }
      await createDeployment({
        modelId: mid,
        recipeId: rid,
        nodeIds: draft.nodeIds,
        desiredState,
        metadata: { managedBy: wantsExternal ? "external" : "sparkdash" },
      });
      onSaved();
      navigate({ section: "model", modelId: mid });
      return true;
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const activeRecipe = externalRecipe;

  // Spec §7: creation opens a template picker before the blank form.
  if (onPicker) {
    return (
      <div className="cp-panel">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Guided add model</span>
          <Chip tone="accent">config only · dry-run</Chip>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: "0 0 12px", maxWidth: 560 }}>
          Start from a proven shape, or from scratch. Save writes CONFIG entities only — no process is started or stopped.
        </p>
        <TemplatePicker
          title="Start from a template"
          templates={MODEL_TEMPLATES}
          onPick={applyTemplate}
          onScratch={() => setOnPicker(false)}
        />
        <FormFooter onCancel={onCancel} cancelLabel="Cancel wizard">
          <span className="muted" style={{ fontSize: 12 }}>Pick a template or start blank.</span>
        </FormFooter>
      </div>
    );
  }

  return (
    <div className="cp-panel">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Guided add model</span>
        <Chip tone="accent">config only · dry-run</Chip>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "0 0 12px", maxWidth: 560 }}>
        Creates and associates CONFIG entities only. No process is started, stopped, signalled or reconfigured.
      </p>

      <Stepper steps={STEPS} current={step} onSelect={setStep} ariaLabel="Add model steps" />

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

      {/* 1. Model */}
      {step === 0 ? (
        <>
          <div role="radiogroup" aria-label="Model source" style={{ display: "flex", gap: 6, marginBottom: 14 }}>
            <button type="button" role="radio" aria-checked={modelMode === "existing"} className={`cp-pick ${modelMode === "existing" ? "is-selected" : ""}`} onClick={() => setModelMode("existing")}>
              Existing model
            </button>
            <button type="button" role="radio" aria-checked={modelMode === "new"} className={`cp-pick ${modelMode === "new" ? "is-selected" : ""}`} onClick={() => setModelMode("new")}>
              Create new
            </button>
          </div>

          {modelMode === "existing" ? (
            <FormSection legend="Pick a registered model" columns={1}>
              <Field label="Model" htmlFor="w-model-pick" hint={isinstance.length ? undefined : "No models registered yet — create new."}>
                <Select id="w-model-pick" value={modelId} onChange={(e) => setModelId(e.target.value)}>
                  <option value="">Select model…</option>
                  {isinstance.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </FormSection>
          ) : (
            <>
              <FormSection legend="Model identity" columns={2}>
                <Field label="Model name" htmlFor="w-model-name">
                  <TextInput
                    id="w-model-name"
                    value={model.name}
                    placeholder="ex: Qwen 3.8 Flash"
                    onChange={(e) => {
                      const name = e.target.value;
                      setModel((m) => ({ ...m, name, id: m.id || slugify(name) }));
                    }}
                  />
                </Field>
                <Field label="id" htmlFor="w-model-id" hint="Lowercase slug">
                  <TextInput id="w-model-id" mono value={model.id} onChange={(e) => setModel((m) => ({ ...m, id: e.target.value }))} />
                </Field>
                <Field label="Family" htmlFor="w-model-fam" hint="Optional">
                  <TextInput id="w-model-fam" value={model.family} placeholder="Qwen" onChange={(e) => setModel((m) => ({ ...m, family: e.target.value }))} />
                </Field>
                <Field label="Weight path" htmlFor="w-model-path" hint="Absolute POSIX path; weights are never moved">
                  <TextInput id="w-model-path" mono value={model.weightPath} onChange={(e) => setModel((m) => ({ ...m, weightPath: e.target.value }))} />
                </Field>
              </FormSection>
              <AdvancedDisclosure label="Advanced — weight variants">
                <FormSection legend="Additional weight variants" columns={2}>
                  {model.variants.map((v, i) => (
                    <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <TextInput mono placeholder="variant id" value={v.id} onChange={(e) => setModel((m) => ({ ...m, variants: m.variants.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)) }))} />
                      <TextInput mono placeholder="/abs/path" value={v.path} onChange={(e) => setModel((m) => ({ ...m, variants: m.variants.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)) }))} />
                      <button type="button" className="cp-btn ghost" onClick={() => setModel((m) => ({ ...m, variants: m.variants.filter((_, j) => j !== i) }))}>
                        <CloseIcon size={12} />
                      </button>
                    </div>
                  ))}
                  <button type="button" className="cp-btn ghost" onClick={() => setModel((m) => ({ ...m, variants: [...m.variants, { id: "", path: "" }] }))}>
                    + Add variant
                  </button>
                </FormSection>
              </AdvancedDisclosure>
            </>
          )}
        </>
      ) : null}

      {/* 2. Recipe */}
      {step === 1 ? (
        <>
          <div role="radiogroup" aria-label="Recipe source" style={{ display: "flex", gap: 6, marginBottom: 14 }}>
            <button type="button" role="radio" aria-checked={recipeMode === "new"} className={`cp-pick ${recipeMode === "new" ? "is-selected" : ""}`} onClick={() => setRecipeMode("new")}>
              Create new
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={recipeMode === "duplicate"}
              className={`cp-pick ${recipeMode === "duplicate" ? "is-selected" : ""}`}
              onClick={() => setRecipeMode("duplicate")}
            >
              Duplicate proven
            </button>
            <button type="button" role="radio" aria-checked={recipeMode === "existing"} className={`cp-pick ${recipeMode === "existing" ? "is-selected" : ""}`} onClick={() => setRecipeMode("existing")}>
              Use existing
            </button>
          </div>

          {recipeMode !== "new" ? (
            <FormSection legend={recipeMode === "duplicate" ? "Duplicate from a proven recipe" : "Pick an existing recipe"} columns={1}>
              <Field label="Recipe" htmlFor="w-recipe-pick" hint={recipesForModel.length ? "Duplicating never touches the original." : "No recipes for this model yet."}>
                <Select id="w-recipe-pick" value={srcRecipeId} onChange={(e) => setSrcRecipeId(e.target.value)}>
                  <option value="">Select recipe…</option>
                  {recipesForModel.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </Field>
              {activeRecipe?.lifecycleState ? (
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <LifecycleBadge state={activeRecipe.lifecycleState} />
                  <span className="muted" style={{ fontSize: 11 }}>
                    {activeRecipe.runtime} · {activeRecipe.contextLength ?? "—"} ctx
                  </span>
                </div>
              ) : null}
              {recipeMode === "duplicate" ? (
                <Field label="New recipe id" htmlFor="w-dup-id" hint="Deep copy — the source stays untouched">
                  <TextInput id="w-dup-id" mono value={dupId} placeholder={srcRecipeId ? `${srcRecipeId}-copy` : "recipe-id-copy"} onChange={(e) => setDupId(e.target.value)} />
                </Field>
              ) : null}
            </FormSection>
          ) : (
            <>
              <FormSection legend="Recipe identity" columns={2}>
                <Field label="Recipe name" htmlFor="w-r-name">
                  <TextInput
                    id="w-r-name"
                    value={draft.name}
                    placeholder="TabbyAPI EXL3 (dgx-3)"
                    onChange={(e) => {
                      const name = e.target.value;
                      setDraft((d) => ({ ...d, name, id: d.id || slugify(name) }));
                    }}
                  />
                </Field>
                <Field label="Recipe id" htmlFor="w-r-id" hint="Lowercase slug; unique">
                  <TextInput id="w-r-id" mono value={draft.id} onChange={(e) => set("id", e.target.value)} />
                </Field>
              </FormSection>
              <FormSection legend="Runtime & serving" columns={2}>
                <Field label="Runtime provider" htmlFor="w-r-runtime" hint="Source: WS-3 provider registry">
                  <div role="radiogroup" aria-label="Runtime provider" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {runtimesList.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        role="radio"
                        aria-checked={draft.runtime === r.id}
                        className={`cp-pick ${draft.runtime === r.id ? "is-selected" : ""}`}
                        onClick={() => set("runtime", r.id)}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                </Field>
                <Field label="Quantization" htmlFor="w-r-quant" hint="e.g. EXL3 4.0bpw">
                  <TextInput id="w-r-quant" mono value={draft.quantization} onChange={(e) => set("quantization", e.target.value)} />
                </Field>
                <Field label="Context length" htmlFor="w-r-ctx" hint="Tokens">
                  <TextInput id="w-r-ctx" mono inputMode="numeric" value={draft.contextLength} onChange={(e) => set("contextLength", e.target.value)} />
                </Field>
                <Field label="Working directory" htmlFor="w-r-model" hint="Absolute POSIX path on the node">
                  <TextInput id="w-r-model" mono value={draft.workdir} onChange={(e) => set("workdir", e.target.value)} />
                </Field>
              </FormSection>
              <AdvancedDisclosure label="Advanced — env, secret refs, launch args, flags">
                <FormSection legend="Environment (secret entries stay as secretRef)" columns={1}>
                  {draft.env.map((e, i) => (
                    <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 2fr auto auto", gap: 8, alignItems: "center" }}>
                      <TextInput mono placeholder="NAME" value={e.name} onChange={(ev) => setDraft((d) => ({ ...d, env: d.env.map((x, j) => (j === i ? { ...x, name: ev.target.value } : x)) }))} />
                      <TextInput mono placeholder="value" type={e.secret ? "password" : "text"} value={e.value} onChange={(ev) => setDraft((d) => ({ ...d, env: d.env.map((x, j) => (j === i ? { ...x, value: ev.target.value } : x)) }))} />
                      <label style={{ fontSize: 11, display: "flex", gap: 4, alignItems: "center", color: "var(--color-muted)" }}>
                        <input type="checkbox" checked={e.secret} onChange={(ev) => setDraft((d) => ({ ...d, env: d.env.map((x, j) => (j === i ? { ...x, secret: ev.target.checked } : x)) }))} />
                        secret
                      </label>
                      <button type="button" className="cp-btn ghost" onClick={() => setDraft((d) => ({ ...d, env: d.env.filter((_, j) => j !== i) }))}>
                        <CloseIcon size={12} />
                      </button>
                    </div>
                  ))}
                  <button type="button" className="cp-btn ghost" onClick={() => setDraft((d) => ({ ...d, env: [...d.env, { name: "", value: "", secret: false }] }))}>
                    + Add variable
                  </button>
                </FormSection>
                <FormSection legend="Launch & flags" columns={2}>
                  <Field label="Mechanism" htmlFor="w-r-mech">
                    <Select id="w-r-mech" value={draft.mechanism} onChange={(e) => set("mechanism", e.target.value as RecipeDraft["mechanism"])}>
                      <option value="command">command</option>
                      <option value="systemd">systemd</option>
                      <option value="docker">docker</option>
                      <option value="external">external</option>
                    </Select>
                  </Field>
                  <Field label="Launch args" htmlFor="w-r-args" hint="One per line">
                    <TextArea id="w-r-args" mono rows={2} value={draft.args} onChange={(e) => set("args", e.target.value)} />
                  </Field>
                </FormSection>
              </AdvancedDisclosure>
            </>
          )}
        </>
      ) : null}

      {/* 3. Runtime */}
      {step === 2 ? (
        <FormSection legend="Runtime confirm" columns={2}>
          <div className="cp-kv" style={{ gridColumn: "1 / -1" }}>
            <dt>runtime</dt>
            <dd>{runtimesList.find((r) => r.id === (activeRecipe?.engine?.runtime ?? draft.runtime))?.label ?? (activeRecipe?.engine?.runtime ?? draft.runtime)}</dd>
            <dt>endpoint</dt>
            <dd className="mono">
              {activeRecipe?.endpoint?.scheme ?? draft.scheme}://{activeRecipe?.endpoint?.hostTemplate ?? draft.hostTemplate}:
              {activeRecipe?.endpoint?.port ?? draft.apiPort}
              {activeRecipe?.endpoint?.path ?? draft.endpointPath}
            </dd>
            <dt>api protocol</dt>
            <dd className="mono">{activeRecipe?.engine?.apiProtocol ?? draft.apiProtocol}</dd>
          </div>
          {!activeRecipe ? (
            <>
              <Field label="Scheme" htmlFor="w-scheme">
                <Select id="w-scheme" value={draft.scheme} onChange={(e) => set("scheme", e.target.value as "http" | "https")}>
                  <option value="http">http</option>
                  <option value="https">https</option>
                </Select>
              </Field>
              <Field label="API protocol" htmlFor="w-proto">
                <Select id="w-proto" value={draft.apiProtocol} onChange={(e) => set("apiProtocol", e.target.value as "openai" | "custom")}>
                  <option value="openai">openai</option>
                  <option value="custom">custom</option>
                </Select>
              </Field>
            </>
          ) : null}
          <p className="cp-field-hint" style={{ gridColumn: "1 / -1" }}>
            Detected externally-managed? desiredState stays <span className="mono">unknown</span> and controls stay disabled.
          </p>
        </FormSection>
      ) : null}

      {/* 4. Compute / topology */}
      {step === 3 ? (
        <>
          <FormSection legend="Topology" columns={3}>
            <Field label="Mode" htmlFor="w-topo">
              <Select id="w-topo" value={draft.topoMode} onChange={(e) => set("topoMode", e.target.value as RecipeDraft["topoMode"])}>
                <option value="single">single</option>
                <option value="tp">tp</option>
                <option value="pp">pp</option>
                <option value="dp">dp</option>
              </Select>
            </Field>
            <Field label="Parallelism" htmlFor="w-par">
              <TextInput id="w-par" mono inputMode="numeric" value={draft.parallelism} onChange={(e) => set("parallelism", e.target.value)} />
            </Field>
            <Field label="Node bounds" htmlFor="w-bounds" hint="min–max honored by the deployment">
              <div style={{ display: "flex", gap: 6 }}>
                <TextInput id="w-bounds" mono inputMode="numeric" aria-label="min nodes" value={draft.minNodes} onChange={(e) => set("minNodes", e.target.value)} />
                <TextInput mono inputMode="numeric" aria-label="max nodes" value={draft.maxNodes} onChange={(e) => set("maxNodes", e.target.value)} />
              </div>
            </Field>
          </FormSection>
          <div className="cp-section-legend">
            Pick node(s) — {draft.nodeIds.length} selected, bounds {range.min}–{range.max}
          </div>
          {draft.nodeIds.length < range.min || draft.nodeIds.length > range.max ? (
            <div className="cp-field-error" role="alert">
              Node count is out of the recipe topology bounds ({range.min === range.max ? range.min : `${range.min}–${range.max}`}).
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
            {sparks.length === 0 ? (
              <span className="cp-field-hint">No nodes registered — add one in Settings.</span>
            ) : (
              sparks.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  className={`cp-pick ${draft.nodeIds.includes(n.id) ? "is-selected" : ""}`}
                  onClick={() => toggleNode(n.id)}
                  aria-pressed={draft.nodeIds.includes(n.id)}
                >
                  <StatusDot status={n.online ? "online" : "offline"} />
                  {n.name}
                </button>
              ))
            )}
          </div>
        </>
      ) : null}

      {/* 5. Options */}
      {step === 4 ? (
        <>
          <FormSection legend="Endpoint & serving options" columns={2}>
            <Field label="API port" htmlFor="w-port">
              <TextInput id="w-port" mono inputMode="numeric" value={activeRecipe ? String(activeRecipe.endpoint?.port ?? activeRecipe.apiPort) : draft.apiPort} disabled={Boolean(activeRecipe)} onChange={(e) => set("apiPort", e.target.value)} />
            </Field>
            <Field label="Path" htmlFor="w-path">
              <TextInput id="w-path" mono value={activeRecipe?.endpoint?.path ?? draft.endpointPath} disabled={Boolean(activeRecipe)} onChange={(e) => set("endpointPath", e.target.value)} />
            </Field>
            <Field label="Context length" htmlFor="w-ctx2">
              <TextInput id="w-ctx2" mono inputMode="numeric" value={activeRecipe?.serving?.contextLength != null ? String(activeRecipe.serving.contextLength) : draft.contextLength} disabled={Boolean(activeRecipe)} onChange={(e) => set("contextLength", e.target.value)} />
            </Field>
            <Field label="Log directory" htmlFor="w-log2" hint="Enables the Live Console (read-only tail)">
              <TextInput id="w-log2" mono value={activeRecipe?.logSource?.path ?? draft.logDir} disabled={Boolean(activeRecipe)} onChange={(e) => set("logDir", e.target.value)} />
            </Field>
          </FormSection>
          <AdvancedDisclosure label="Advanced — health probe, affinity, flags">
            <FormSection legend="Probe & execution" columns={2}>
              <Field label="Health path" htmlFor="w-health">
                <TextInput id="w-health" mono value={activeRecipe?.healthProbe?.path ?? draft.healthPath} disabled={Boolean(activeRecipe)} onChange={(e) => set("healthPath", e.target.value)} />
              </Field>
              <Field label="CPU affinity" htmlFor="w-aff">
                <TextInput id="w-aff" mono value={activeRecipe?.launch?.affinity ?? draft.cpuAffinity} disabled={Boolean(activeRecipe)} onChange={(e) => set("cpuAffinity", e.target.value)} />
              </Field>
            </FormSection>
          </AdvancedDisclosure>
        </>
      ) : null}

      {/* 6. Validate */}
      {step === 5 ? (
        <div className="cp-panel">
          <div className="cp-panel-title">
            <span>Dry-run validation — POST /api/recipes/:id/validate</span>
            <button type="button" className="cp-btn ghost" onClick={() => void runValidate()} disabled={busy}>
              {busy ? "Validating…" : "Re-run validation"}
            </button>
          </div>
          {errors.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--color-success)" }}>No errors{". "}{warnings.length ? `${warnings.length} warning(s) — review before saving.` : " Ready to review."}</div>
          ) : null}
          <p className="cp-field-hint" style={{ marginTop: 8 }}>
            Compiled locally, never executed against a node.
          </p>
        </div>
      ) : null}

      {/* 7. Review */}
      {step === 6 ? (
        <div className="cp-panel">
          <div className="cp-panel-title">Exactly what will be created / associated</div>
          <dl className="cp-kv">
            <dt>model</dt>
            <dd>
              {savedModelId && modelMode === "new" ? "create" : modelMode === "existing" ? "associate" : "create"} —{" "}
              <span className="mono">{savedModelId ?? model.id ?? modelId}</span>
            </dd>
            <dt>recipe</dt>
            <dd>
              {recipeMode === "new" ? "create" : recipeMode === "duplicate" ? "duplicate (source untouched)" : "associate"} —{" "}
              <span className="mono">{savedRecipeId ?? (recipeMode === "new" ? draft.id : srcRecipeId)}</span>
            </dd>
            <dt>deployment</dt>
            <dd>create binding</dd>
            <dt>nodes</dt>
            <dd className="mono">{draft.nodeIds.join(", ") || "—"}</dd>
            <dt>desired state</dt>
            <dd className="mono">{desiredState}</dd>
            <dt>remote processes</dt>
            <dd>untouched (config-only)</dd>
          </dl>
        </div>
      ) : null}

      {/* 8. Save */}
      {step === 7 ? (
        <div className="cp-panel">
          <div className="cp-panel-title">Save</div>
          <p style={{ fontSize: 12, margin: 0 }}>
            Writes config only. Weight files are never moved or deleted, and no process is started or stopped. You will land on the
            new model detail.
          </p>
        </div>
      ) : null}

      <FormFooter
        onCancel={() => {
          if (dirty) setCancelOpen(true);
          else onCancel();
        }}
        cancelLabel="Cancel wizard"
      >
        {step > 0 ? (
          <button type="button" className="cp-btn" onClick={() => setStep((s) => s - 1)}>
            Back
          </button>
        ) : null}
        {step < STEPS.length - 1 ? (
          <button type="button" className="cp-btn primary" onClick={next} disabled={busy}>
            {busy ? "Working…" : "Continue"}
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
            disabled={busy}
          >
            {busy ? "Saving…" : "Create model + recipe + deployment"}
          </button>
        )}
      </FormFooter>

      {/* Dirty-state guard: leaving the wizard with unsaved edits. */}
      <Modal
        open={cancelOpen}
        title="Discard this wizard?"
        consequence="The wizard has unsaved config edits. Saving writes the model, recipe and binding; discarding drops them."
        confirmLabel="Save"
        discardLabel="Discard"
        cancelLabel="Cancel"
        busy={busy}
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

// Re-export for callers that want the structured editor's helpers.
export { RecipeEditor, emptyRecipeDraft, recipeBodyFromDraft, draftFromRecipe };
