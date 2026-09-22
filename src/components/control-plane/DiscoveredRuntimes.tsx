import { useEffect, useMemo, useState } from "react";
import type {
  DiscoveredRuntime,
  DeploymentObserved,
  ModelEntry,
  RecipePublic,
  SparkSnapshot,
} from "../../api/types";
import { adoptDiscovered, fetchDiscovery, fetchModels } from "../../api/client";
import { SectionBand } from "../ui/SectionBand";
import { StatusPill } from "../ui/Status";
import { Chip } from "../ui/Status";
import { Modal } from "../ui/Modal";
import { Field, TextInput } from "../ui/form";
import { SearchIcon } from "../ui/icons";
import { runtimeLabel } from "./fleetModel";

/** Observed probe vocabulary → fixed display vocabulary for the health pill. */
function healthDisplay(h: DeploymentObserved) {
  if (h === "unhealthy") return "degraded" as const;
  if (h === "not-detected") return "stopped" as const;
  // unadopted but answering = external
  return "running-external" as const;
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

type Step = "form" | "review";

interface DiscoveredRuntimesProps {
  sparks: SparkSnapshot[];
  /** Restrict to one node (node detail). */
  nodeId?: string;
  recipes?: readonly RecipePublic[];
  onSaved: () => void;
}

/**
 * "Discovered runtimes" — externally-launched serving endpoints found by the
 * read-only scan that no deployment covers yet. Adoption is config-only: the
 * process is exactly as the operator launched it.
 *
 * Renders NOTHING when there is nothing new (no empty band).
 */
export function DiscoveredRuntimes({ sparks, nodeId, recipes = [], onSaved }: DiscoveredRuntimesProps) {
  const [items, setItems] = useState<DiscoveredRuntime[]>([]);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [target, setTarget] = useState<DiscoveredRuntime | null>(null);
  const [mode, setMode] = useState<"associate" | "create">("associate");
  const [modelId, setModelId] = useState("");
  const [recipeId, setRecipeId] = useState("");
  const [modelName, setModelName] = useState("");
  const [step, setStep] = useState<Step>("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetchDiscovery(true)
        .then((r) => {
          if (alive) setItems(r.discovered);
        })
        .catch(() => {});
      fetchModels()
        .then((r) => {
          if (alive) setModels(r.models.filter((m) => !m.archived));
        })
        .catch(() => {});
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const nodeNames = useMemo(() => new Map(sparks.map((s) => [s.id, s.name])), [sparks]);
  const fresh = useMemo(
    () => items.filter((d) => !d.alreadyAdopted && (!nodeId || d.nodeId === nodeId)),
    [items, nodeId]
  );

  const matchedRecipes = useMemo(
    () => recipes.filter((r) => r.modelId === modelId),
    [recipes, modelId]
  );

  function open(d: DiscoveredRuntime) {
    setTarget(d);
    setMode("associate");
    setModelId("");
    setRecipeId("");
    setModelName(d.servedModelIds[0] ?? d.runtime);
    setStep("form");
    setError(null);
  }

  const detectedName = target?.servedModelIds[0] ?? target?.runtime ?? "unknown";
  const createRecipeId = target ? slug(`${modelName || detectedName}-${target.runtime}`) : "";
  const createModelId = slug(modelName || detectedName);

  async function save() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await adoptDiscovered(
        target.id,
        mode === "associate"
          ? { mode, modelId, recipeId }
          : {
              mode,
              modelName,
              recipeDraft: {
                id: createRecipeId,
                modelId: createModelId,
                name: `${modelName} (${target.runtime})`,
                runtime: target.runtime,
                topology: "single",
              },
            }
      );
      setTarget(null);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("form");
    } finally {
      setBusy(false);
    }
  }

  if (fresh.length === 0) return null;

  return (
    <div className="cp-section-block">
      <SectionBand icon={<SearchIcon />} title="Discovered runtimes" count={fresh.length} />

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {fresh.map((d) => (
          <div key={d.id} className="cp-deploy-row">
            <StatusPill status={healthDisplay(d.health)} className="cp-deploy-state" />
            <div className="cp-deploy-model">
              <span className="cp-deploy-name">{d.servedModelIds[0] ?? "unnamed endpoint"}</span>
              <span className="cp-deploy-id mono">{d.endpoint}</span>
            </div>
            <div className="cp-deploy-meta">
              <Chip tone="accent">{runtimeLabel(d.runtime)}</Chip>
              {d.processEvidence ? <Chip>process seen</Chip> : null}
            </div>
            <div className="cp-deploy-nodes">
              <span className="cp-node-chip">{nodeNames.get(d.nodeId) ?? d.nodeId}</span>
            </div>
            <div className="cp-deploy-right">
              <span className="cp-deploy-port mono">:{d.port}</span>
            </div>
            <div className="cp-row-actions">
              <button
                type="button"
                className="cp-btn primary"
                onClick={() => open(d)}
                title="Associate with an existing model/recipe or create new — config only"
              >
                Review &amp; Adopt
              </button>
            </div>
          </div>
        ))}
      </div>

      <Modal
        open={target != null}
        title={step === "review" ? `Adopt ${detectedName}?` : `Adopt discovered runtime`}
        consequence="Writes SparkDash config only — the running process is never started, stopped or reconfigured."
        info={
          step === "review"
            ? mode === "associate"
              ? `Associating an existing model + recipe with a deployment on ${target?.nodeId} :${target?.port}.`
              : `Creating a new model and recipe, then a deployment bound to ${target?.nodeId} :${target?.port}.`
            : "This run was launched outside SparkDash; adoption records ownership so it never reads as stopped."
        }
        confirmLabel={step === "review" ? (mode === "associate" ? "Associate" : "Create & bind") : "Review"}
        busy={busy}
        onClose={() => setTarget(null)}
        onConfirm={() => {
          if (step === "form") {
            if (mode === "associate" && (!modelId || !recipeId)) {
              setError("Pick a model and a recipe to associate.");
              return;
            }
            setError(null);
            setStep("review");
            return;
          }
          void save();
        }}
      >
        {step === "form" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="cp-kv">
              <dt>runtime</dt>
              <dd>{runtimeLabel(target?.runtime)}</dd>
              <dt>node / port</dt>
              <dd className="mono">
                {target?.nodeId} :{target?.port}
              </dd>
              <dt>served id</dt>
              <dd className="mono">{detectedName}</dd>
            </div>

            <div role="radiogroup" aria-label="Adoption path" style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                className={`cp-btn ${mode === "associate" ? "primary" : "ghost"}`}
                aria-pressed={mode === "associate"}
                onClick={() => setMode("associate")}
              >
                Associate existing
              </button>
              <button
                type="button"
                className={`cp-btn ${mode === "create" ? "primary" : "ghost"}`}
                aria-pressed={mode === "create"}
                onClick={() => setMode("create")}
              >
                Create new
              </button>
            </div>

            {mode === "associate" ? (
              <>
                <Field label="Model" htmlFor="disc-model">
                  <select
                    id="disc-model"
                    className="cp-input"
                    value={modelId}
                    onChange={(e) => {
                      setModelId(e.target.value);
                      setRecipeId("");
                    }}
                  >
                    <option value="">Select model…</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Recipe" htmlFor="disc-recipe" hint="Must reference the chosen model">
                  <select
                    id="disc-recipe"
                    className="cp-input"
                    value={recipeId}
                    onChange={(e) => setRecipeId(e.target.value)}
                  >
                    <option value="">Select recipe…</option>
                    {matchedRecipes.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            ) : (
              <>
                <Field label="Model name" htmlFor="disc-name">
                  <TextInput
                    id="disc-name"
                    value={modelName}
                    onChange={(e) => setModelName(e.target.value)}
                    placeholder="ex: qwen-3.8-exl3"
                  />
                </Field>
                <div className="cp-kv">
                  <dt>new model id</dt>
                  <dd className="mono">{createModelId}</dd>
                  <dt>new recipe id</dt>
                  <dd className="mono">{createRecipeId}</dd>
                  <dt>recipe runtime / port</dt>
                  <dd className="mono">
                    {runtimeLabel(target?.runtime)} · {target?.port}
                  </dd>
                  <dt>topology</dt>
                  <dd>single (node {target?.nodeId})</dd>
                </div>
              </>
            )}

            {error ? (
              <div className="cp-field-error" role="alert">
                {error}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="cp-kv">
            <dt>{mode === "create" ? "create model" : "associate model"}</dt>
            <dd>{mode === "create" ? `${modelName} (${createModelId})` : models.find((m) => m.id === modelId)?.name ?? modelId}</dd>
            <dt>{mode === "create" ? "create recipe" : "associate recipe"}</dt>
            <dd>{mode === "create" ? `${createRecipeId} · ${runtimeLabel(target?.runtime)}` : matchedRecipes.find((r) => r.id === recipeId)?.name ?? recipeId}</dd>
            <dt>create deployment</dt>
            <dd className="mono">{target?.nodeId} :{target?.port}</dd>
            <dt>desired state</dt>
            <dd>unknown (external · dry-run)</dd>
            <dt>remote host</dt>
            <dd>untouched</dd>
          </div>
        )}
      </Modal>
    </div>
  );
}
