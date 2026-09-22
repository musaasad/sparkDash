import { useMemo, useState } from "react";
import type {
  DiscoveredSeed,
  DiscoveryProbeResult,
  ProbeCapabilitiesResult,
  DeploymentObserved,
  RecipePublic,
} from "../../api/types";
import { probeDiscoveryEndpoint, probeDiscoveryCapabilities } from "../../api/client";
import { Field, TextInput, Select, FormSection, FormFooter } from "../ui/form";
import { Chip } from "../ui/Status";
import { ProvenanceBadge } from "./ProvenanceBadge";
import { runtimeLabel } from "./fleetModel";
import { useRuntimeLabels } from "./runtimeLabels";

/** Server suggestion id → wizard picker template id. Always overridable. */
export const SUGGESTION_TO_TEMPLATE: Record<string, string> = {
  "tabbyapi-exl3": "tabbyapi-exl3",
  "vllm-openai": "vllm-openai",
  "external-observed": "external",
  scratch: "scratch",
  // Identity entries so an operator override (already a wizard id) maps back.
  external: "external",
};

const healthDisplay = (h: DeploymentObserved) =>
  h === "unhealthy" ? "degraded" : h === "not-detected" ? "stopped" : "running-external";

interface DiscoveryFormProps {
  recipes: readonly RecipePublic[];
  onSeed: (seed: DiscoveredSeed) => void;
  onBack: () => void;
}

/**
 * "Discover running model" — a first-class creation path for an ALREADY-RUNNING
 * lab endpoint. Read-only GET /v1/models (automatic, free, bounded to the one
 * typed host:port). Capability probe is a SEPARATE opt-in tiny action. Nothing
 * is adopted here: discovery is observation, never ownership.
 */
export function DiscoveryForm({ recipes, onSeed, onBack }: DiscoveryFormProps) {
  const runtimeLabels = useRuntimeLabels();
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [scheme, setScheme] = useState<"http" | "https">("http");
  const [credRef, setCredRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [capsBusy, setCapsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [result, setResult] = useState<DiscoveryProbeResult | null>(null);
  const [caps, setCaps] = useState<ProbeCapabilitiesResult | null>(null);
  const [template, setTemplate] = useState<string | null>(null);

  /** Stable credRef options from existing recipes' secret env entries. */
  const credOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of recipes) {
      for (const e of r.env ?? []) {
        if (e.secret || e.secretRef) set.add(`recipe:${r.id}:${e.name}`);
      }
    }
    return [...set].sort();
  }, [recipes]);

  async function discover() {
    const p = Number(port);
    if (!host.trim() || !Number.isInteger(p) || p < 1 || p > 65535) {
      setError("Host and port (1–65535) are required.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    setCaps(null);
    try {
      const r = await probeDiscoveryEndpoint({ host: host.trim(), port: p, scheme, credRef: credRef || null });
      setResult(r);
      setTemplate(SUGGESTION_TO_TEMPLATE[r.suggestedTemplate.templateId] ?? "scratch");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function probeCaps() {
    if (!result) return;
    setCapsBusy(true);
    setError(null);
    try {
      setCaps(
        await probeDiscoveryCapabilities({
          host: host.trim(),
          port: Number(port),
          scheme,
          credRef: credRef || null,
          modelId: result.modelId,
        })
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCapsBusy(false);
    }
  }

  function cont() {
    if (!result) {
      setError("Run a discovery first.");
      return;
    }
    onSeed({
      ...result,
      host: host.trim(),
      port: Number(port),
      scheme,
      credRef: credRef || null,
      capabilities: caps,
      // Operator override wins; the seed carries the chosen template id.
      suggestedTemplate: { templateId: template ?? result.suggestedTemplate.templateId, confidence: result.suggestedTemplate.confidence },
    });
  }

  return (
    <div className="cp-panel">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Discover running model</span>
        <Chip tone="accent">read-only · GET /v1/models</Chip>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "0 0 12px", maxWidth: 560 }}>
        Point at one already-running endpoint. One typed host:port — never a LAN sweep. Nothing is started, stopped or
        reconfigured.
      </p>

      <FormSection legend="Endpoint (bounded — one host:port)" columns={4}>
        <Field label="Host / IP" htmlFor="disc-host">
          <TextInput id="disc-host" mono value={host} placeholder="10.0.0.12" onChange={(e) => setHost(e.target.value)} />
        </Field>
        <Field label="Port" htmlFor="disc-port">
          <TextInput id="disc-port" mono inputMode="numeric" value={port} placeholder="8889" onChange={(e) => setPort(e.target.value)} />
        </Field>
        <Field label="Scheme" htmlFor="disc-scheme">
          <Select id="disc-scheme" value={scheme} onChange={(e) => setScheme(e.target.value as "http" | "https")}>
            <option value="http">http</option>
            <option value="https">https</option>
          </Select>
        </Field>
        <Field label="Credential ref" htmlFor="disc-cred" hint="Optional; value never echoed">
          <Select id="disc-cred" value={credRef} onChange={(e) => setCredRef(e.target.value)}>
            <option value="">none</option>
            {credOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
      </FormSection>

      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <button type="button" className="cp-btn primary" onClick={() => void discover()} disabled={busy}>
          {busy ? "Discovering…" : "Discover"}
        </button>
        <button type="button" className="cp-btn" onClick={onBack}>
          Back to templates
        </button>
      </div>

      {error ? (
        <div className="cp-panel" style={{ borderColor: "var(--color-danger)", marginBottom: 14 }} role="alert">
          <div className="cp-field-error">{error}</div>
        </div>
      ) : null}

      {result ? (
        <div className="cp-panel" style={{ marginBottom: 14 }}>
          {!result.reachable ? (
            <p className="muted" style={{ fontSize: 12, margin: "0 0 10px" }}>
              Not reachable ({healthDisplay(result.health)}). Detected fields stay UNKNOWN — you can still continue and
              confirm them manually.
            </p>
          ) : null}

          <div className="cp-panel-title">Detected — provenance on every field</div>
          <dl className="cp-discover-detected">
            <dt>health</dt>
            <dd>{healthDisplay(result.health)}</dd>
            <dt>runtime</dt>
            <dd>
              <span className="mono">{runtimeLabel(result.runtime, runtimeLabels)}</span>
              <ProvenanceBadge value={result.provenance.runtime} />
            </dd>
            <dt>model id</dt>
            <dd>
              <span className="mono">{result.modelId ?? "—"}</span>
              <ProvenanceBadge value={result.provenance.modelId} />
            </dd>
            <dt>api protocol</dt>
            <dd>
              <span className="mono">{result.apiProtocol}</span>
              <ProvenanceBadge value={result.provenance.apiProtocol} />
            </dd>
            <dt>context length</dt>
            <dd>
              <span className="mono">{result.contextLength ?? "—"}</span>
              <ProvenanceBadge value={result.provenance.contextLength} />
            </dd>
            <dt>quantization</dt>
            <dd>
              <span className="mono">{result.quantization ?? "—"}</span>
              <ProvenanceBadge value={result.provenance.quantization} />
            </dd>
            <dt>endpoint</dt>
            <dd className="mono">{result.endpoint}</dd>
            <dt>credential</dt>
            <dd>
              <span className="mono">{credRef || "none"}</span>
              <ProvenanceBadge value={result.provenance.credRef} />
            </dd>
          </dl>

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <span className="muted" style={{ fontSize: 12 }}>Suggested template</span>
            <Select
              aria-label="Suggested template"
              value={template ?? "scratch"}
              onChange={(e) => setTemplate(e.target.value)}
              style={{ maxWidth: 220 }}
            >
              {Object.keys(SUGGESTION_TO_TEMPLATE).map((id) => (
                <option key={id} value={SUGGESTION_TO_TEMPLATE[id]}>
                  {id}
                </option>
              ))}
            </Select>
            <Chip
              title={`Suggestion confidence: ${result.suggestedTemplate.confidence}`}
              tone={result.suggestedTemplate.confidence === "high" ? "accent" : "default"}
            >
              {result.suggestedTemplate.confidence} confidence · overridable
            </Chip>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
            <button type="button" className="cp-btn" onClick={() => void probeCaps()} disabled={capsBusy}>
              {capsBusy ? "Probing…" : "Probe capabilities (opt-in, tiny)"}
            </button>
            <span className="cp-field-hint">max_tokens 1 · separate explicit action · never a benchmark</span>
          </div>

          {caps ? (
            <dl className="cp-cap-list" style={{ marginTop: 10 }}>
              {(["text", "streaming", "vision", "tools", "reasoning"] as const).map((k) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd className={caps[k] === "unknown" ? "is-unknown" : ""}>{caps[k]}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      ) : null}

      <FormFooter onCancel={onBack} cancelLabel="Cancel">
        <button type="button" className="cp-btn primary" onClick={cont} disabled={!result}>
          Continue to setup
        </button>
      </FormFooter>
    </div>
  );
}
