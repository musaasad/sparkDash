import { useMemo, useState } from "react";
import type { DiscoveredSeed, DiscoveryProbeResult, ProbeCapabilitiesResult, RecipePublic } from "../../api/types";
import { probeDiscoveryEndpoint, probeDiscoveryCapabilities } from "../../api/client";
import { Field, TextInput, Select, FormSection, FormFooter } from "../ui/form";
import { Chip } from "../ui/Status";
import { ProvenanceBadge } from "./ProvenanceBadge";
import { runtimeLabel } from "./fleetModel";
import { useRuntimeLabels } from "./runtimeLabels";

interface ExternalEndpointFormProps {
  recipes: readonly RecipePublic[];
  onSeed: (seed: DiscoveredSeed) => void;
  onBack: () => void;
}

interface ParsedBase {
  scheme: "http" | "https";
  host: string;
  port: number;
  path: string;
}

/** Parse an OpenAI-compatible base URL into a bounded host/port/path target. */
function parseBase(raw: string): ParsedBase | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `http://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (!u.hostname) return null;
  const scheme = u.protocol === "https:" ? "https" : "http";
  const port = u.port ? Number(u.port) : scheme === "https" ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const path = u.pathname && u.pathname !== "/" ? u.pathname.replace(/\/$/, "") : "";
  return { scheme, host: u.hostname, port, path };
}

/**
 * "Connect external endpoint" — a first-class creation path for an OpenAI-
 * compatible server SparkDash does NOT manage. One typed base URL; a read-only
 * GET /v1/models fills the model identity, and the deployment is marked
 * managedBy=external. Nothing is started, stopped or reconfigured.
 *
 * The credential is a REF (name only) — the value is never echoed.
 */
export function ExternalEndpointForm({ recipes, onSeed, onBack }: ExternalEndpointFormProps) {
  const runtimeLabels = useRuntimeLabels();
  const [baseUrl, setBaseUrl] = useState("");
  const [credRef, setCredRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DiscoveryProbeResult | null>(null);
  const [caps, setCaps] = useState<ProbeCapabilitiesResult | null>(null);
  const [parsed, setParsed] = useState<ParsedBase | null>(null);

  const credOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of recipes) for (const e of r.env ?? []) if (e.secret || e.secretRef) set.add(`recipe:${r.id}:${e.name}`);
    return [...set].sort();
  }, [recipes]);

  async function probe() {
    const p = parseBase(baseUrl);
    if (!p) {
      setError("Enter an OpenAI-compatible base URL, e.g. http://10.0.0.12:8889/v1");
      return;
    }
    setParsed(p);
    setBusy(true);
    setError(null);
    setResult(null);
    setCaps(null);
    try {
      setResult(await probeDiscoveryEndpoint({ host: p.host, port: p.port, scheme: p.scheme, credRef: credRef || null }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function probeCaps() {
    if (!result || !parsed) return;
    setBusy(true);
    try {
      setCaps(await probeDiscoveryCapabilities({ ...parsed, credRef: credRef || null, modelId: result.modelId }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function cont() {
    if (!result || !parsed) {
      setError("Run the read-only probe first.");
      return;
    }
    onSeed({
      ...result,
      host: parsed.host,
      port: parsed.port,
      scheme: parsed.scheme,
      endpointPath: parsed.path || null,
      credRef: credRef || null,
      capabilities: caps,
    });
  }

  return (
    <div className="cp-panel">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Connect external endpoint</span>
        <Chip tone="accent">read-only · GET /v1/models</Chip>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "0 0 4px", maxWidth: 560 }}>
        Point at an OpenAI-compatible server SparkDash does not manage. The probe reads the model list and pre-fills
        identity; the deployment is marked <span className="mono">external</span>.
      </p>
      <p className="cp-field-hint" style={{ margin: "0 0 12px", maxWidth: 560 }}>
        SparkDash will NOT start, stop, restart, signal or reconfigure the remote — it only observes it.
      </p>

      <FormSection legend="Base URL (one endpoint — no LAN sweep)" columns={2}>
        <Field label="Base URL" htmlFor="ext-url" hint="e.g. http://10.0.0.12:8889/v1">
          <TextInput id="ext-url" mono value={baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => setBaseUrl(e.target.value)} />
        </Field>
        <Field label="Credential ref" htmlFor="ext-cred" hint="Optional; name only — the value is never echoed">
          <TextInput id="ext-cred" mono list="ext-cred-list" value={credRef} placeholder="recipe:xyz:API_KEY" onChange={(e) => setCredRef(e.target.value)} />
          <datalist id="ext-cred-list">
            {credOptions.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>
      </FormSection>

      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <button type="button" className="cp-btn primary" onClick={() => void probe()} disabled={busy}>
          {busy ? "Probing…" : "Probe endpoint"}
        </button>
        <button type="button" className="cp-btn" onClick={onBack}>
          Back to paths
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
              Not reachable. You can still continue — fields stay editable and UNKNOWN.
            </p>
          ) : null}
          <div className="cp-panel-title">Detected — provenance on every field</div>
          <dl className="cp-discover-detected">
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
            <dt>context length</dt>
            <dd>
              <span className="mono">{result.contextLength ?? "—"}</span>
              <ProvenanceBadge value={result.provenance.contextLength} />
            </dd>
            <dt>endpoint</dt>
            <dd className="mono">{result.endpoint}</dd>
          </dl>
          <p className="cp-field-hint" style={{ marginTop: 6 }}>
            family and weight path stay BLANK + UNKNOWN — an endpoint cannot reliably expose them.
          </p>
          <button type="button" className="cp-btn" onClick={() => void probeCaps()} disabled={busy}>
            {caps ? "Re-probe capabilities (opt-in, tiny)" : "Probe capabilities (opt-in, tiny)"}
          </button>
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
