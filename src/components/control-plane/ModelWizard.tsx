import { useMemo, useState } from "react";
import type { DeploymentRole, DiscoveredSeed, LocalWeightsSeed, ModelEntry, RecipePublic, RecipeRuntime, SeedProvenance, SparkSnapshot } from "../../api/types";
import type { DeploymentView } from "./fleetModel";
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
  topologyBlockFromDraft,
  topologyUnknown,
  draftFromRecipe,
  slugify,
  type RecipeDraft,
} from "./RecipeEditor";
import { useRuntimeOptions } from "./runtimeLabels";
import { DiscoveryForm, SUGGESTION_TO_TEMPLATE } from "./DiscoveryForm";
import { LocalWeightsForm } from "./LocalWeightsForm";
import { ExternalEndpointForm } from "./ExternalEndpointForm";
import { ProvenanceBadge } from "./ProvenanceBadge";
import { TopologySummary } from "./TopologySummary";
import { DEPLOYMENT_ROLE_OPTIONS, roleToSave } from "./deploymentRoles";
import { TOPOLOGY_STRATEGIES, evaluateTopology, strategyTier, type TopologyDescriptor, type TopologyStrategy } from "./topologyCapability";
import { buildValidateReport, reportSymbol } from "./validateReport";
import { fleetInventory } from "../../shared/inventory.js";

/**
 * Explicit flow: MODEL → RECIPE → RUNTIME → COMPUTE → TOPOLOGY → ROLE/OPTIONS →
 * VALIDATE → REVIEW → SAVE. TOPOLOGY and ROLE are first-class steps so the
 * architecture is explicit; "Role & options" folds the old Options step in
 * cleanly (no pointless churn).
 */
const STEPS = [
  { id: "model", label: "Model", hint: "Who/what it is. Family and weight path stay blank (UNKNOWN) unless a probe proved them — SparkDash never guesses." },
  { id: "recipe", label: "Recipe", hint: "How it CAN run: runtime, context, env, launch shape. Nothing here starts a process." },
  { id: "runtime", label: "Runtime", hint: "Confirm the serving protocol and endpoint. External runtimes keep their desired state unknown." },
  { id: "compute", label: "Compute", hint: "Which fleet nodes this MAY bind to. Placement is config only — no node is touched." },
  { id: "topology", label: "Topology", hint: "Explicit TP/PP/DP/EP degrees. A blank degree is UNKNOWN — never inferred from node count." },
  { id: "role", label: "Role & options", hint: "A pure config role + serving options. Changeable later via PATCH, never by recreation." },
  { id: "validate", label: "Validate", hint: "Dry-run compile against config. No remote call is executed; UNKNOWN stays '?'." },
  { id: "review", label: "Review", hint: "The operator's safety confirmation — a plain WILL / WON'T summary before anything is written." },
  { id: "save", label: "Save", hint: "Writes CONFIG entities only: model, recipe, binding. Weights and remote processes stay untouched." },
];

const STEP_INDEX = Object.fromEntries(STEPS.map((s, i) => [s.id, i])) as Record<string, number>;

/** Spec §7 template picker seed — every field stays editable after a pick. */
const MODEL_TEMPLATES: TemplatePickerItem[] = [
  {
    id: "vllm-openai",
    name: "vLLM · OpenAI-compatible",
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

/** Template presets — applied on pick AND on a discovery suggested template. */
const TEMPLATE_PRESETS: Record<string, Partial<RecipeDraft>> = {
  "vllm-openai": { runtime: "vllm", mechanism: "command", apiProtocol: "openai", contextLength: "32768" },
  "tabbyapi-exl3": { runtime: "tabbyapi-exl3", quantization: "EXL3 4.0bpw", contextLength: "16384" },
  sglang: { runtime: "sglang", mechanism: "command", contextLength: "32768" },
  external: { runtime: "vllm", mechanism: "external", apiProtocol: "openai" },
  "vllm-tp": { runtime: "vllm", topoMode: "tp", parallelism: "2", minNodes: "2", maxNodes: "2" },
  "vllm-dp": { runtime: "vllm", topoMode: "dp", parallelism: "2", minNodes: "2", maxNodes: "4" },
};

type ModelPathId = "discover" | "weights" | "template" | "external" | "advanced";

interface ModelPath {
  id: ModelPathId;
  label: string;
  summary: string;
  /** Plain-language: what SparkDash will NOT do on this path. */
  willNot: string;
  /** Visual tier — discovery leads, manual is de-emphasised. */
  tier: "discovery" | "support";
}

/**
 * FIVE discovery-first entry paths. Discovery paths are the visually emphasised
 * primaries; template is support; Advanced (the manual form) is de-emphasised but
 * reachable. Every path names what SparkDash will NOT do.
 */
const MODEL_PATHS: ModelPath[] = [
  {
    id: "discover",
    label: "Discover running model",
    summary: "Probe an endpoint that is already loaded and register it as observed / external.",
    willNot: "SparkDash reads the endpoint's model list. It does not start, stop or reconfigure anything.",
    tier: "discovery",
  },
  {
    id: "weights",
    label: "Discover local weights",
    summary: "Read configured weight directories for gguf / safetensors / bin files and register one.",
    willNot: "SparkDash only reads directories. It never moves, copies, renames or downloads weight files.",
    tier: "discovery",
  },
  {
    id: "template",
    label: "Start from proven template",
    summary: "Data-driven serving shapes (vLLM / TabbyAPI / SGLang …) as an editable starting point.",
    willNot: "A template is a starting shape, never a limit — every field stays editable.",
    tier: "support",
  },
  {
    id: "external",
    label: "Connect external endpoint",
    summary: "Type an OpenAI-compatible base URL, probe it read-only and bind it as managedBy=external.",
    willNot: "SparkDash observes only — no lifecycle, no remote mutation, no secret value echoed.",
    tier: "discovery",
  },
  {
    id: "advanced",
    label: "Advanced",
    summary: "The full manual form — build everything by hand when discovery cannot help.",
    willNot: "Still config only: no process is started or stopped, no remote is mutated.",
    tier: "support",
  },
];

/** The operator's safety confirmation block shown on REVIEW, before Save. */
const WILL_LIST = [
  "Create/update CONFIG entities: model, recipe, deployment binding",
  "Observe the chosen endpoint (read-only) and record discovery provenance",
  "Bind to the selected compute nodes and write the selected role",
];
const WONT_LIST = [
  "Start / stop / restart / signal / reconfigure any runtime or container",
  "Move, copy or download weight files",
  "Mutate the remote host in any way",
  "Touch or echo secret values (credential refs stay names only)",
];

/** Initial draft from a discovery seed — discovered values pre-filled, editable. */
function seedDraft(seed?: DiscoveredSeed): RecipeDraft {
  const d = emptyRecipeDraft("");
  if (!seed) return d;
  const preset = TEMPLATE_PRESETS[SUGGESTION_TO_TEMPLATE[seed.suggestedTemplate.templateId] ?? ""];
  const merged = { ...d, ...preset };
  merged.name = `${seed.modelId ?? seed.runtime} (${seed.runtime})`;
  merged.id = slugify(merged.name);
  merged.runtime = seed.runtime;
  merged.mechanism = "external";
  merged.apiProtocol = seed.apiProtocol === "native" ? "custom" : "openai";
  merged.scheme = seed.scheme;
  merged.apiPort = String(seed.port);
  merged.contextLength = seed.contextLength != null ? String(seed.contextLength) : merged.contextLength;
  merged.quantization = seed.quantization ?? merged.quantization;
  // A full base URL carries a path; keep it on the endpoint (operator-typed).
  if (seed.endpointPath) merged.endpointPath = seed.endpointPath;
  return merged;
}

/**
 * Fields a discovery probe cannot reliably know. They stay BLANK + UNKNOWN
 * (editable) — SparkDash never guesses a family or fabricates a weight path.
 */
const SEED_UNKNOWN_FIELDS = ["family", "weightPath"] as const;

/** Seed provenance with the never-guessed fields forced to UNKNOWN. */
function seedProv(seed?: DiscoveredSeed): Record<string, SeedProvenance> {
  if (!seed) return {};
  const p: Record<string, SeedProvenance> = { ...seed.provenance };
  for (const k of SEED_UNKNOWN_FIELDS) if (!p[k]) p[k] = "unknown";
  // A typed base URL is the operator's, not a discovery find.
  if (seed.endpointPath) p.endpointPath = "user";
  return p;
}

/**
 * Initial model identity from a seed. Name/id come from the discovered model id,
 * but family and weight path stay blank/UNKNOWN — an external endpoint does not
 * reliably expose them, so a plausible-looking guess is worse than a blank.
 */
function seedModel(seed?: DiscoveredSeed): WizardModel {
  const name = seed?.modelId ?? "";
  return { id: name ? slugify(name) : "", name, family: "", weightPath: "", variants: [] };
}

interface ModelWizardProps {
  models: ModelEntry[];
  recipes: RecipePublic[];
  sparks: SparkSnapshot[];
  /** Runtime rows from the WS-3 provider registry (label + declared topology DATA). */
  runtimes?: { id: RecipeRuntime; label: string; topology?: Record<string, string> }[];
  navigate: (route: Route) => void;
  onSaved: () => void;
  onCancel: () => void;
  /** Pre-select an existing model (wizard launched from a model surface). */
  initialModelId?: string;
  /** Discovery seed — pre-fills Model/Recipe/Runtime/Compute/Options + provenance. */
  seed?: DiscoveredSeed;
  /** Open directly on one path instead of the path picker. */
  initialPath?: "pick" | ModelPathId;
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
  seed,
  initialPath = "pick",
}: ModelWizardProps) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [cancelOpen, setCancelOpen] = useState(false);
  type PathState = "pick" | "form" | ModelPathId;
  const [path, setPath] = useState<PathState>(() =>
    seed || initialModelId ? "form" : initialPath && initialPath !== "pick" ? initialPath : "pick"
  );

  const [modelMode, setModelMode] = useState<"existing" | "new">(initialModelId ? "existing" : "new");
  /** Canonical compute inventory (src/shared/inventory.js) — never positional. */
  const fleet = fleetInventory(sparks);

  const [modelId, setModelId] = useState(initialModelId ?? "");
  const [model, setModel] = useState<WizardModel>(() => seedModel(seed));

  const [recipeMode, setRecipeMode] = useState<"existing" | "duplicate" | "new">("new");
  const [srcRecipeId, setSrcRecipeId] = useState("");
  const [dupId, setDupId] = useState("");
  const [draft, setDraft] = useState<RecipeDraft>(() => {
    const d = seedDraft(seed);
    if (seed) {
      d.nodeIds = fleet.filter((s) => s.lanIp === seed.host).map((s) => s.id).slice(0, topologyNodeRange(d).max);
    }
    return d;
  });

  /** Provenance per discovered field (drives inline badges). */
  const [prov, setProv] = useState<Record<string, SeedProvenance>>(() => seedProv(seed));
  /** Fields the operator explicitly confirmed from UNKNOWN → user supplied. */
  const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set());
  const [capabilities, setCapabilities] = useState(seed?.capabilities ?? null);
  const [seedOrigin, setSeedOrigin] = useState<string | null>(seed?.endpoint ?? null);

  /** DEPLOYMENT role — pure config selection, default none/null (never primary). */
  const [role, setRole] = useState<DeploymentRole | "">("");

  /** Entity ids materialised at validate time (config only). */
  const [savedModelId, setSavedModelId] = useState<string | null>(initialModelId ?? null);
  const [savedRecipeId, setSavedRecipeId] = useState<string | null>(null);

  const isinstance = models.filter((m) => !m.archived);
  const registryOptions = useRuntimeOptions();
  const runtimesList = runtimes?.length ? runtimes : registryOptions;
  const range = topologyNodeRange(draft);

  // Runtime-declared topology capability DATA (absent strategy ⇒ UNKNOWN).
  const runtimeRow = runtimesList.find((r) => r.id === draft.runtime);
  const descriptor = (runtimeRow?.topology ?? {}) as TopologyDescriptor;
  const nodeCount = draft.nodeIds.length;
  /** Live capability + structural verdict — never presents UNKNOWN as VALID. */
  const topoEval = evaluateTopology({ draft, descriptor, nodeCount });
  const runtimeVerifiable = Object.keys(descriptor).length > 0;

  /** Degree of a strategy for the tier chip. */
  const degreeOf = (s: TopologyStrategy): number | null =>
    s === "single" ? 1 : Number(draft[s]) || null;

  /** Operator-readable validate report — ✓ valid / ✗ invalid / ? unverifiable. */
  const reportLines = buildValidateReport({
    modelName: modelMode === "existing" ? (models.find((m) => m.id === modelId)?.name ?? modelId) : model.name,
    modelId: modelMode === "existing" ? modelId : model.id,
    weightPath: modelMode === "existing" ? "" : model.weightPath,
    runtime: draft.runtime,
    runtimeVerifiable,
    nodeCount,
    rangeMin: range.min,
    rangeMax: range.max,
    topologyStatus: topoEval.status,
    topologyReason: topoEval.reason,
    secretEntries: draft.env.filter((e) => e.secret).length,
    secretMissingNames: draft.env.filter((e) => e.secret && !e.name.trim()).length,
    role: roleToSave(role),
  });

  // Dirty guard (spec §6): any user edit from the initial state.
  const initialSnapshot = useMemo(
    () => JSON.stringify({ modelMode, model, recipeMode, srcRecipeId, dupId, draft, role }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const dirty = JSON.stringify({ modelMode, model, recipeMode, srcRecipeId, dupId, draft, role }) !== initialSnapshot;

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

  /** Provenance shown for a field: cleared UNKNOWNs read as user supplied. */
  const provOf = (key: string): SeedProvenance | undefined =>
    cleared.has(key) ? "user" : prov[key];
  const confirm = (key: string) => setCleared((s) => new Set(s).add(key));

  /** UNKNOWN discovered fields the operator has not confirmed yet. */
  const unknownFields = Object.entries(prov)
    .filter(([k, v]) => v === "unknown" && !cleared.has(k))
    .map(([k]) => k);

  /** Synthetic deployment view so the WS-4 TopologySummary renders in-wizard. */
  const topoView = {
    deployment: { nodeIds: draft.nodeIds },
    nodes: fleet.filter((s) => draft.nodeIds.includes(s.id)),
    recipe: { id: draft.id, topologyBlock: topologyBlockFromDraft(draft) },
  } as unknown as DeploymentView;

  /** Hand-off from a discovery form: pre-fill, then jump to step 1. */
  function applySeed(s: DiscoveredSeed, opts: { external?: boolean } = {}) {
    setPath("form");
    setStep(0);
    setModelMode("new");
    setModel(seedModel(s));
    setDraft(() => {
      const d = seedDraft(s);
      if (opts.external) {
        // External endpoint → ownership stays external/observed, path kept.
        d.mechanism = "external";
        d.endpointPath = s.endpointPath || "";
      }
      d.nodeIds = fleet.filter((sp) => sp.lanIp === s.host).map((sp) => sp.id).slice(0, topologyNodeRange(d).max);
      return d;
    });
    setProv(seedProv(s));
    setCapabilities(s.capabilities);
    setSeedOrigin(s.endpoint);
  }

  /**
   * Hand-off from the local-weights form. The weight path IS discovered (real
   * readdir), so it carries provenance; name is the real filename; family stays
   * BLANK + UNKNOWN because a filename is not proof.
   */
  function applyWeightsSeed(s: LocalWeightsSeed) {
    const nm =
      s.name
        .replace(/\.(safetensors|gguf|bin|pt|pth|onnx|exl3|awq|gptq|npz)(\.index\.json)?$/i, "")
        .replace(/[-_]+/g, " ")
        .trim() || s.name;
    setPath("form");
    setStep(0);
    setModelMode("new");
    setModel({ id: slugify(nm), name: nm, family: "", weightPath: s.path, variants: [] });
    setDraft(() => {
      const d = emptyRecipeDraft(slugify(nm));
      d.name = `${nm} (local weights)`;
      d.mechanism = "command";
      return d;
    });
    setProv({
      name: "detected",
      modelId: "detected",
      weightPath: s.provenance === "user" ? "user" : "detected",
      family: "unknown",
      runtime: "unknown",
    });
    setCapabilities(null);
    setSeedOrigin(s.path);
  }

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
    if (id === "scratch") {
      setPath("form");
      return;
    }
    const preset = TEMPLATE_PRESETS[id];
    if (preset) setDraft((d) => ({ ...d, ...preset }));
    setPath("form");
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
    if (step === STEP_INDEX.compute) {
      if (draft.nodeIds.length < range.min || draft.nodeIds.length > range.max)
        e.push(
          range.min === range.max
            ? `Topology requires exactly ${range.min} node(s).`
            : `Topology requires ${range.min}–${range.max} node(s).`
        );
    }
    if (step === STEP_INDEX.topology) {
      for (const s of ["tp", "pp", "dp", "ep"] as const) {
        const raw = draft[s].trim();
        if (raw === "") continue;
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1) e.push(`${s.toUpperCase()} degree must be an integer ≥ 1.`);
      }
      // A declared-unsupported / structurally-impossible topology BLOCKS.
      if (topoEval.status === "invalid") e.push(`Topology invalid: ${topoEval.reason}.`);
    }
    if (step === STEP_INDEX.role) {
      const port = Number(draft.apiPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) e.push("API port must be 1–65535.");
    }
    if (step === STEP_INDEX.validate && errors.length > 0) e.push(...errors);
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

  /** Advisory warnings derived LIVE from current state (never stale). */
  const navWarnings: string[] = [];
  if (topologyUnknown(draft)) {
    navWarnings.push("Topology unknown — confirm TP/PP/DP/EP degrees. Node count alone never sets parallelism.");
  }
  if (topoEval.status === "needs-confirmation") {
    navWarnings.push(`Topology NEEDS CONFIRMATION: ${topoEval.reason}.`);
  }
  if (!role) {
    navWarnings.push("No role set — the deployment defaults to none (changeable later via PATCH).");
  }
  if (unknownFields.length) {
    navWarnings.push(`${unknownFields.length} UNKNOWN discovered value(s) — confirm each before saving.`);
  }

  function next() {
    const e = validateStep();
    setErrors(e);
    if (e.length > 0) return;
    const target = step + 1;
    if (target === STEP_INDEX.validate) {
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
        setStep(STEP_INDEX.validate);
        return false;
      }
      await createDeployment({
        modelId: mid,
        recipeId: rid,
        nodeIds: draft.nodeIds,
        desiredState,
        // Role is pure config data written on the binding — no model recreation
        // and no lifecycle. Changeable later via PATCH /api/deployments/:id.
        role: roleToSave(role),
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

  /** Five discovery-first paths: discovery leads, manual is de-emphasised. */
  function pickPath(id: ModelPathId) {
    setPath(id === "advanced" ? "form" : id);
  }

  if (path === "discover") {
    return <DiscoveryForm recipes={recipes} onSeed={applySeed} onBack={() => setPath("pick")} />;
  }
  if (path === "weights") {
    return <LocalWeightsForm onSeed={applyWeightsSeed} onBack={() => setPath("pick")} />;
  }
  if (path === "external") {
    return <ExternalEndpointForm recipes={recipes} onSeed={(s) => applySeed(s, { external: true })} onBack={() => setPath("pick")} />;
  }
  if (path === "template") {
    return (
      <div className="cp-panel">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Start from proven template</span>
          <Chip tone="default">support path</Chip>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: "0 0 4px", maxWidth: 560 }}>
          Pick a proven serving shape. It pre-fills recipe fields only so you get a working starting point fast.
        </p>
        <p className="cp-field-hint" style={{ margin: "0 0 12px", maxWidth: 560 }}>
          SparkDash will NOT lock you in — a template is a shape, every field stays editable afterwards.
        </p>
        <TemplatePicker
          title="Templates (data-driven — a new runtime is a provider, never a code edit)"
          templates={MODEL_TEMPLATES}
          onPick={applyTemplate}
          onScratch={() => setPath("form")}
          onDiscover={() => setPath("discover")}
        />
        <FormFooter onCancel={onCancel} cancelLabel="Cancel wizard">
          <button type="button" className="cp-btn" onClick={() => setPath("pick")}>
            Back to paths
          </button>
        </FormFooter>
      </div>
    );
  }
  if (path === "pick") {
    return (
      <div className="cp-panel">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Guided add model</span>
          <Chip tone="accent">config only · dry-run</Chip>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: "0 0 4px", maxWidth: 560 }}>
          Discovery leads: find what is already there and let SparkDash observe it. Save writes CONFIG entities only —
          no process is started or stopped, no weight is moved.
        </p>
        <p className="cp-field-hint" style={{ margin: "0 0 12px", maxWidth: 560 }}>
          Pick one path. Each opens a compact first screen and expands only as you proceed.
        </p>

        {/* Five explicit paths — discovery first and visually emphasised. */}
        <div role="radiogroup" aria-label="Add model path" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
          {MODEL_PATHS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={false}
              className={`cp-path-card${p.tier === "discovery" ? " is-discovery" : ""}`}
              onClick={() => pickPath(p.id)}
            >
              <span className="cp-path-title">
                {p.label}
                {p.tier === "discovery" ? <Chip tone="accent">discovery</Chip> : null}
              </span>
              <span className="cp-field-hint" style={{ display: "block", marginTop: 2 }}>{p.summary}</span>
              <span className="cp-field-hint" style={{ display: "block", marginTop: 4, color: "var(--color-muted-strong)" }}>
                Won't: {p.willNot}
              </span>
            </button>
          ))}
        </div>

        {/* Template cards stay available on the picker: a proven shape is one
            click away and every field remains editable. */}
        <TemplatePicker
          title="Templates (data-driven — a new runtime is a provider, never a code edit)"
          templates={MODEL_TEMPLATES}
          onPick={applyTemplate}
          onScratch={() => setPath("form")}
          onDiscover={() => setPath("discover")}
        />

        <FormFooter onCancel={onCancel} cancelLabel="Cancel wizard">
          <span className="muted" style={{ fontSize: 12 }}>Discovery paths first; Advanced is the full manual form.</span>
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

      {/* Compact: modal-safe rail, no label collision, current title + on-demand list. */}
      <Stepper variant="compact" steps={STEPS} current={step} onSelect={setStep} ariaLabel="Add model steps" />
      <p className="cp-field-hint" style={{ margin: "2px 0 12px" }} data-step-hint>
        {STEPS[step]?.hint}
      </p>

      {errors.length > 0 ? (
        <div className="cp-panel" style={{ borderColor: "var(--color-danger)", marginBottom: 14 }} role="alert">
          {errors.map((e, i) => (
            <div key={i} className="cp-field-error">
              {e}
            </div>
          ))}
        </div>
      ) : null}
      {navWarnings.length + warnings.length > 0 ? (
        <div className="cp-panel" style={{ borderColor: "var(--color-warning)", marginBottom: 14 }}>
          {[...navWarnings, ...warnings].map((w, i) => (
            <div key={i} style={{ fontSize: 11, color: "var(--color-warning)" }}>
              {w}
            </div>
          ))}
        </div>
      ) : null}

      {seedOrigin ? (
        <div className="cp-panel" style={{ borderColor: "var(--color-accent)", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Chip tone="accent">discovered (read-only)</Chip>
            <span className="mono" style={{ fontSize: 12 }}>{seedOrigin}</span>
            <span className="muted" style={{ fontSize: 11 }}>
              Every value stays editable · badges show provenance · {unknownFields.length} UNKNOWN to confirm
            </span>
          </div>
          <p className="cp-field-hint" style={{ marginTop: 4 }}>
            Discovery is observation, not ownership — this endpoint stays external / observed.
          </p>
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
                  <div className="cp-discover-field">
                    <TextInput
                      id="w-model-name"
                      style={{ flex: 1 }}
                      value={model.name}
                      placeholder="ex: Qwen 3.8 Flash"
                      onChange={(e) => {
                        const name = e.target.value;
                        setModel((m) => ({ ...m, name, id: m.id || slugify(name) }));
                      }}
                    />
                    <ProvenanceBadge value={provOf("modelId")} onConfirm={() => confirm("modelId")} />
                  </div>
                </Field>
                <Field label="id" htmlFor="w-model-id" hint="Lowercase slug">
                  <TextInput id="w-model-id" mono value={model.id} onChange={(e) => setModel((m) => ({ ...m, id: e.target.value }))} />
                </Field>
                <Field label="Family" htmlFor="w-model-fam" hint="Optional; left UNKNOWN unless discovery is sure">
                  <div className="cp-discover-field">
                    <TextInput id="w-model-fam" style={{ flex: 1 }} value={model.family} placeholder="Qwen" onChange={(e) => setModel((m) => ({ ...m, family: e.target.value }))} />
                    <ProvenanceBadge value={provOf("family")} onConfirm={() => confirm("family")} />
                  </div>
                </Field>
                <Field label="Weight path" htmlFor="w-model-path" hint="Absolute POSIX path; blank when unknown — weights are never moved">
                  <div className="cp-discover-field">
                    <TextInput id="w-model-path" mono style={{ flex: 1 }} value={model.weightPath} onChange={(e) => setModel((m) => ({ ...m, weightPath: e.target.value }))} />
                    <ProvenanceBadge value={provOf("weightPath")} onConfirm={() => confirm("weightPath")} />
                  </div>
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
                  <ProvenanceBadge value={provOf("runtime")} onConfirm={() => confirm("runtime")} />
                </Field>
                <Field label="Quantization" htmlFor="w-r-quant" hint="e.g. EXL3 4.0bpw">
                  <div className="cp-discover-field">
                    <TextInput id="w-r-quant" mono style={{ flex: 1 }} value={draft.quantization} onChange={(e) => set("quantization", e.target.value)} />
                    <ProvenanceBadge value={provOf("quantization")} onConfirm={() => confirm("quantization")} />
                  </div>
                </Field>
                <Field label="Context length" htmlFor="w-r-ctx" hint="Tokens">
                  <div className="cp-discover-field">
                    <TextInput id="w-r-ctx" mono style={{ flex: 1 }} inputMode="numeric" value={draft.contextLength} onChange={(e) => set("contextLength", e.target.value)} />
                    <ProvenanceBadge value={provOf("contextLength")} onConfirm={() => confirm("contextLength")} />
                  </div>
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
            <dd>
              {runtimesList.find((r) => r.id === (activeRecipe?.engine?.runtime ?? draft.runtime))?.label ?? (activeRecipe?.engine?.runtime ?? draft.runtime)}
              <ProvenanceBadge value={provOf("runtime")} onConfirm={() => confirm("runtime")} />
            </dd>
            <dt>endpoint</dt>
            <dd className="mono">
              {activeRecipe?.endpoint?.scheme ?? draft.scheme}://{activeRecipe?.endpoint?.hostTemplate ?? draft.hostTemplate}:
              {activeRecipe?.endpoint?.port ?? draft.apiPort}
              {activeRecipe?.endpoint?.path ?? draft.endpointPath}
            </dd>
            <dt>api protocol</dt>
            <dd>
              <span className="mono">{activeRecipe?.engine?.apiProtocol ?? draft.apiProtocol}</span>
              <ProvenanceBadge value={provOf("apiProtocol")} onConfirm={() => confirm("apiProtocol")} />
            </dd>
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

      {/* 4. Compute — PHYSICAL placement only (topology is its own step) */}
      {step === STEP_INDEX.compute ? (
        <>
          <div className="cp-section-legend">Physical placement — fleet-backed nodes</div>
          <p className="cp-field-hint" style={{ marginBottom: 8 }}>
            Pick the node(s) this runs on, then a head/coordinator and worker count. Placement is physical — fleet size
            never implies a parallel degree.
          </p>
          {sparks.length === 0 ? (
            <span className="cp-field-hint">No nodes registered — add one in Settings.</span>
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {fleet.map((n) => (
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
              ))}
            </div>
          )}
          <FormSection legend="Head / coordinator & workers" columns={2} style={{ marginTop: 12 }}>
            <Field label="Head / coordinator" htmlFor="w-head" hint="Optional — must be a selected node">
              <Select id="w-head" value={draft.coordinator} onChange={(e) => set("coordinator", e.target.value)}>
                <option value="">none</option>
                {fleet.filter((s) => draft.nodeIds.includes(s.id)).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Workers" htmlFor="w-workers" hint="Optional physical worker hint (≠ parallelism degree)">
              <TextInput id="w-workers" mono inputMode="numeric" value={draft.workers} onChange={(e) => set("workers", e.target.value)} />
            </Field>
          </FormSection>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <span className="muted" style={{ fontSize: 12 }}>Representation</span>
            <TopologySummary view={topoView} />
            <span className="muted" style={{ fontSize: 11 }}>
              {draft.nodeIds.length} node(s) placed · bounds {range.min === range.max ? range.min : `${range.min}–${range.max}`}
            </span>
          </div>
          {draft.nodeIds.length < range.min || draft.nodeIds.length > range.max ? (
            <div className="cp-field-error" role="alert">
              Node count is out of the recipe topology bounds ({range.min === range.max ? range.min : `${range.min}–${range.max}`}).
            </div>
          ) : null}
        </>
      ) : null}

      {/* 5. Topology — explicit strategy + data-driven degrees, live-validated */}
      {step === STEP_INDEX.topology ? (
        <>
          <div className="cp-section-legend">Deployment topology — explicit strategy & degrees</div>
          <p className="cp-field-hint" style={{ marginBottom: 8 }}>
            Degrees are free integers ≥ 1 (not a fixed enum). Strategy tiers come from the selected runtime's DECLARED
            capability data; when a runtime is silent the control stays visible and reads NEEDS CONFIRMATION — never
            silently valid.
          </p>

          <div role="radiogroup" aria-label="Topology strategy" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            {TOPOLOGY_STRATEGIES.map((s) => {
              const tier = strategyTier(descriptor, s.id, degreeOf(s.id), nodeCount);
              return (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={draft.topoMode === s.id}
                  className={`cp-pick ${draft.topoMode === s.id ? "is-selected" : ""}`}
                  title={s.hint}
                  onClick={() => set("topoMode", s.id)}
                >
                  {s.label}
                  {tier === "unsupported" ? <Chip tone="default">unsupported</Chip> : null}
                  {tier === "needs-confirmation" ? <Chip tone="default">needs confirmation</Chip> : null}
                </button>
              );
            })}
          </div>

          <FormSection legend="Explicit degrees (blank = unknown)" columns={4}>
            {(["tp", "pp", "dp", "ep"] as const).map((k) => (
              <Field key={k} label={k.toUpperCase()} htmlFor={`w-${k}`}>
                <TextInput
                  id={`w-${k}`}
                  mono
                  inputMode="numeric"
                  value={draft[k]}
                  onChange={(e) => {
                    set(k, e.target.value);
                    // Setting a degree makes that strategy the explicit mode.
                    if (e.target.value.trim() !== "") set("topoMode", k);
                  }}
                />
              </Field>
            ))}
          </FormSection>

          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span className="muted" style={{ fontSize: 12 }}>Representation</span>
            <TopologySummary view={topoView} />
            <span className="cp-field-hint">
              {nodeCount} node(s) placed · blank degree NEVER infers parallelism from the node count
            </span>
          </div>

          {/* DISTINCT live result: VALID / INVALID(reason) / NEEDS-CONFIRMATION(unknown). */}
          <div
            className="cp-panel"
            role="status"
            data-topology-status={topoEval.status}
            style={{
              borderColor:
                topoEval.status === "valid"
                  ? "var(--color-success)"
                  : topoEval.status === "invalid"
                    ? "var(--color-danger)"
                    : "var(--color-warning)",
              marginBottom: 14,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Chip tone={topoEval.status === "valid" ? "accent" : "default"}>
                {topoEval.status === "valid" ? "VALID" : topoEval.status === "invalid" ? "INVALID" : "NEEDS CONFIRMATION"}
              </Chip>
              <span style={{ fontSize: 12 }}>{topoEval.reason}</span>
            </div>
            <p className="cp-field-hint" style={{ margin: 0 }}>
              Provider data: {runtimeRow?.label ?? draft.runtime}
              {runtimeVerifiable ? "" : " declares no capability — UNKNOWN is not VALID"}
            </p>
          </div>

          {topologyUnknown(draft) ? (
            <div className="cp-field-error" role="alert">
              topology unknown — {nodeCount} nodes placed but no TP/PP/DP/EP degree set.
            </div>
          ) : null}
        </>
      ) : null}

      {/* 6. Role & options — pure config; NO model-name logic */}
      {step === STEP_INDEX.role ? (
        <>
          <div className="cp-section-legend">Deployment role — config selection only</div>
          <p className="cp-field-hint" style={{ marginBottom: 8 }}>
            The role is written on the binding at save and is changeable later via{" "}
            <span className="mono">PATCH /api/deployments/:id {"{role}"}</span> WITHOUT recreating the model. Default is
            none — primary is never auto-assigned.
          </p>
          <div role="radiogroup" aria-label="Deployment role" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
            <button
              type="button"
              role="radio"
              aria-checked={role === ""}
              className={`cp-pick ${role === "" ? "is-selected" : ""}`}
              onClick={() => setRole("")}
            >
              none (default)
            </button>
            {DEPLOYMENT_ROLE_OPTIONS.filter((r) => r.id !== "none").map((r) => (
              <button
                key={r.id}
                type="button"
                role="radio"
                aria-checked={role === r.id}
                className={`cp-pick ${role === r.id ? "is-selected" : ""}`}
                title={r.hint}
                onClick={() => setRole(r.id)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <p className="cp-field-hint" style={{ marginBottom: 14 }}>
            Selected: <span className="mono">{role || "none"}</span> — saved as{" "}
            <span className="mono">{roleToSave(role) ?? "null"}</span>.
          </p>

          <FormSection legend="Endpoint & serving options" columns={2}>
            <Field label="API port" htmlFor="w-port">
              <div className="cp-discover-field">
                <TextInput id="w-port" mono style={{ flex: 1 }} inputMode="numeric" value={activeRecipe ? String(activeRecipe.endpoint?.port ?? activeRecipe.apiPort) : draft.apiPort} disabled={Boolean(activeRecipe)} onChange={(e) => set("apiPort", e.target.value)} />
                <ProvenanceBadge value={provOf("port")} onConfirm={() => confirm("port")} />
              </div>
            </Field>
            <Field label="Path" htmlFor="w-path">
              <TextInput id="w-path" mono value={activeRecipe?.endpoint?.path ?? draft.endpointPath} disabled={Boolean(activeRecipe)} onChange={(e) => set("endpointPath", e.target.value)} />
            </Field>
            <Field label="Context length" htmlFor="w-ctx2">
              <div className="cp-discover-field">
                <TextInput id="w-ctx2" mono style={{ flex: 1 }} inputMode="numeric" value={activeRecipe?.serving?.contextLength != null ? String(activeRecipe.serving.contextLength) : draft.contextLength} disabled={Boolean(activeRecipe)} onChange={(e) => set("contextLength", e.target.value)} />
                <ProvenanceBadge value={provOf("contextLength")} onConfirm={() => confirm("contextLength")} />
              </div>
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

      {/* 7. Validate — operator-readable report, never a false ✓ */}
      {step === STEP_INDEX.validate ? (
        <div className="cp-panel">
          <div className="cp-panel-title">
            <span>Dry-run validation — POST /api/recipes/:id/validate</span>
            <button type="button" className="cp-btn ghost" onClick={() => void runValidate()} disabled={busy}>
              {busy ? "Validating…" : "Re-run validation"}
            </button>
          </div>

          <dl className="cp-kv" data-validate-report>
            {reportLines.map((l) => (
              <div key={l.key} style={{ display: "contents" }}>
                <dt>{l.key}</dt>
                <dd
                  className="mono"
                  data-status={l.status}
                  style={{
                    color:
                      l.status === "valid"
                        ? "var(--color-success)"
                        : l.status === "invalid"
                          ? "var(--color-danger)"
                          : "var(--color-warning)",
                  }}
                >
                  {reportSymbol(l.status)} {l.detail}
                </dd>
              </div>
            ))}
          </dl>

          {errors.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--color-success)", marginTop: 8 }}>
              No backend errors{". "}
              {navWarnings.length + warnings.length
                ? `${navWarnings.length + warnings.length} warning(s) — review before saving.`
                : " Ready to review."}
            </div>
          ) : null}
          <p className="cp-field-hint" style={{ marginTop: 8 }}>
            Compiled locally, never executed against a node. ? means UNKNOWN / NOT-VERIFIED — never reported as ✓.
          </p>
        </div>
      ) : null}

      {/* 8. Review */}
      {step === STEP_INDEX.review ? (
        <div className="cp-panel">
          {/* Operator's safety confirmation — honest and prominent, before Save. */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }} data-will-wont>
            <div className="cp-panel" style={{ borderColor: "var(--color-success)", margin: 0 }} aria-label="SparkDash WILL">
              <div className="cp-panel-title" style={{ color: "var(--color-success)" }}>
                SparkDash WILL
              </div>
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
                {WILL_LIST.map((w) => (
                  <li key={w} style={{ marginBottom: 4 }}>
                    {w}
                  </li>
                ))}
              </ul>
            </div>
            <div className="cp-panel" style={{ borderColor: "var(--color-warning)", margin: 0 }} aria-label="SparkDash WON'T">
              <div className="cp-panel-title" style={{ color: "var(--color-warning)" }}>
                SparkDash WON'T
              </div>
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
                {WONT_LIST.map((w) => (
                  <li key={w} style={{ marginBottom: 4 }}>
                    {w}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="cp-field-hint" style={{ margin: "0 0 12px" }}>
            This is the safety confirmation: everything below is config, nothing below touches a running process, a
            weight file or a secret value.
          </p>

          <div className="cp-panel-title">Exactly what will be created / associated</div>
          <dl className="cp-kv">
            <dt>Model</dt>
            <dd>
              {savedModelId && modelMode === "new" ? "create" : modelMode === "existing" ? "associate" : "create"} —{" "}
              <span className="mono">{savedModelId ?? model.id ?? modelId}</span>
              <ProvenanceBadge value={provOf("modelId")} onConfirm={() => confirm("modelId")} />
            </dd>
            <dt>Recipe</dt>
            <dd>
              {recipeMode === "new" ? "create" : recipeMode === "duplicate" ? "duplicate (source untouched)" : "associate"} —{" "}
              <span className="mono">{savedRecipeId ?? (recipeMode === "new" ? draft.id : srcRecipeId)}</span>
            </dd>
            <dt>Runtime</dt>
            <dd>
              <span className="mono">{runtimesList.find((r) => r.id === draft.runtime)?.label ?? draft.runtime}</span>
              <ProvenanceBadge value={provOf("runtime")} onConfirm={() => confirm("runtime")} />
            </dd>
            <dt>Endpoint</dt>
            <dd className="mono">
              {draft.scheme}://{draft.hostTemplate}:{draft.apiPort}
              {draft.endpointPath}
            </dd>
            <dt>Compute</dt>
            <dd className="mono">
              {draft.nodeIds.length} node(s){draft.coordinator ? ` · head ${draft.coordinator}` : ""}
              {draft.workers ? ` · ${draft.workers} workers` : ""}
            </dd>
            <dt>Topology</dt>
            <dd>
              <TopologySummary view={topoView} />
              <span className="cp-field-hint" data-topology-status={topoEval.status}>
                {" "}
                — {topoEval.status.toUpperCase()}: {topoEval.reason}
              </span>
            </dd>
            <dt>Role</dt>
            <dd>
              <span className="mono">{roleToSave(role) ?? "null (none)"}</span>
              <span className="cp-field-hint"> — config only · changeable later via PATCH, never by recreation</span>
            </dd>
            <dt>Weights</dt>
            <dd className="mono">
              {modelMode === "existing" ? "existing model weights untouched" : model.weightPath || <span className="cp-field-hint">UNKNOWN — never guessed</span>}
            </dd>
            <dt>Secrets</dt>
            <dd>
              {draft.env.filter((e) => e.secret).length === 0
                ? "none"
                : `${draft.env.filter((e) => e.secret).length} secret ref(s) — values never echoed`}
            </dd>
            <dt>Context</dt>
            <dd>
              <span className="mono">{draft.contextLength || "—"}</span>
              <ProvenanceBadge value={provOf("contextLength")} onConfirm={() => confirm("contextLength")} />
            </dd>
            <dt>Quantization</dt>
            <dd className="mono">{draft.quantization || "—"}</dd>
            <dt>API protocol</dt>
            <dd>
              <span className="mono">{draft.apiProtocol}</span>
              <ProvenanceBadge value={provOf("apiProtocol")} onConfirm={() => confirm("apiProtocol")} />
            </dd>
            <dt>Capabilities</dt>
            <dd className="mono">
              {capabilities
                ? (["text", "streaming", "vision", "tools", "reasoning"] as const)
                    .map((k) => `${k}:${capabilities[k]}`)
                    .join(" · ")
                : "not probed (metadata only)"}
            </dd>
            <dt>Ownership</dt>
            <dd>
              {wantsExternal ? "External / observed (discovery ≠ ownership)" : "SparkDash-managed"}
            </dd>
            <dt>Deployment</dt>
            <dd>
              create binding · desired state <span className="mono">{desiredState}</span>
            </dd>
            <dt>SAFETY</dt>
            <dd>CONFIG ONLY — no lifecycle action will occur</dd>
            <dt>Remote processes</dt>
            <dd>untouched (config-only)</dd>
          </dl>
        </div>
      ) : null}

      {/* 9. Save */}
      {step === STEP_INDEX.save ? (
        <div className="cp-panel">
          <div className="cp-panel-title">Save</div>
          <p style={{ fontSize: 12, margin: 0 }}>
            Writes config only — model, recipe, binding and the role selection. No lifecycle action, no remote call. Weight
            files are never moved or deleted, and no process is started or stopped. You will land on the new model detail.
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
