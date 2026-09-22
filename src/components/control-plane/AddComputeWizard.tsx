/**
 * AddComputeWizard — the guided, CONFIG-FIRST Add Compute path.
 *
 * 8 steps: discover → identity → capabilities → network → fabric → validate →
 * review → save. Discovery is a single bounded read-only probe; validation is
 * config-only; SAVE writes config only (the parent owns the addSpark call).
 *
 * Low-typo: discovered values are prefilled, the slug is derived, existing
 * nodes are selectable for fabric peers, and UNKNOWN remains first-class.
 * Manual editing exists on every step but is never the default.
 */
import { useEffect, useMemo, useState } from "react";
import type {
  ComputeDiscoveryResult,
  ComputeValidateIssue,
  ComputeValidateResult,
  FabricLinkConfig,
  SparkConfig,
} from "../../api/types";
import { discoverCompute, validateCompute } from "../../api/client";
import { Field, TextInput, Select, FormSection } from "../ui/form";
import { Chip, StatusDot } from "../ui/Status";
import { Stepper } from "../ui/Stepper";
import { ProvenanceBadge } from "./ProvenanceBadge";
import {
  COMPUTE_STEPS,
  applyDiscovery,
  deriveId,
  draftHost,
  draftToConfig,
  emptyDraft,
  fabricPeerOptions,
  markManual,
  mergeValidation,
  parsePorts,
  slugify,
  validateLocal,
  type ComputeDraft,
} from "./computeDiscoveryModel";

interface ExistingNode {
  id: string;
  name?: string;
  lanIp?: string;
}

export interface AddComputeWizardProps {
  /** Registered nodes — for uniqueness + fabric peer selection. */
  existing: readonly ExistingNode[];
  /** Optional secret refs for SSH/endpoint credentials. */
  credRefs?: readonly string[];
  defaultLlmPort?: number;
  onCancel: () => void;
  onSave: (config: SparkConfig) => void | Promise<void>;
  /** Switch to the existing advanced manual form. */
  onAdvanced?: () => void;
  saving?: boolean;
  error?: string | null;
}

function IssueList({ items, tone }: { items: ComputeValidateIssue[]; tone: "invalid" | "unverified" }) {
  if (items.length === 0) return null;
  return (
    <ul className="cp-issue-list" data-tone={tone} style={{ margin: "6px 0 0", paddingLeft: 16 }}>
      {items.map((i) => (
        <li key={`${tone}-${i.code}`} style={{ color: tone === "invalid" ? "var(--color-danger)" : "var(--color-warning)" }}>
          {tone === "invalid" ? "INVALID" : "NOT-VERIFIED"} · <span className="mono">{i.field}</span> — {i.message}
        </li>
      ))}
    </ul>
  );
}

export function AddComputeWizard({
  existing,
  credRefs = [],
  defaultLlmPort = 8888,
  onCancel,
  onSave,
  onAdvanced,
  saving = false,
  error = null,
}: AddComputeWizardProps) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<ComputeDraft>(() => ({ ...emptyDraft(), llmPorts: [defaultLlmPort] }));
  const [discovery, setDiscovery] = useState<ComputeDiscoveryResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [serverValidation, setServerValidation] = useState<ComputeValidateResult | null>(null);
  const [recheckTick, setRecheckTick] = useState(0);
  const [portText, setPortText] = useState(String(defaultLlmPort));

  const takenIds = useMemo(() => existing.map((n) => n.id), [existing]);
  const peers = useMemo(() => fabricPeerOptions(existing, draft.id), [existing, draft.id]);

  const patch = (p: Partial<ComputeDraft>) => setDraft((prev) => ({ ...prev, ...p }));
  const patchManual = (key: keyof ComputeDraft, value: unknown) =>
    setDraft((prev) => ({ ...markManual(prev, key), [key]: value } as ComputeDraft));

  const validation = useMemo(
    () => mergeValidation(validateLocal(draft, existing), serverValidation),
    [draft, existing, serverValidation]
  );
  const blocked = validation.blocking.length > 0;

  // Run the config-only server validation when the validate step opens.
  useEffect(() => {
    if (step !== 5) return;
    let alive = true;
    void (async () => {
      try {
        const result = await validateCompute({ draft: draftToConfig(draft) as unknown as Record<string, unknown>, discovered: discovery });
        if (alive) setServerValidation(result);
      } catch {
        /* server validation is advisory; the local mirror still stands */
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, recheckTick]);

  function pickKnownNode(id: string) {
    const node = existing.find((n) => n.id === id);
    if (!node) return;
    setDraft((prev) => ({
      ...markManual(prev, "lanIp"),
      lanIp: node.lanIp || prev.lanIp,
      name: prev.name || node.name || node.id,
      id: prev.id || node.id,
      provenance: { ...prev.provenance, lanIp: "configured", name: prev.name ? prev.provenance.name : "configured" },
    }));
  }

  async function runDiscovery() {
    const host = draftHost(draft);
    if (!host) {
      setLocalError("Enter a host or pick a known node first.");
      return;
    }
    setBusy(true);
    setLocalError(null);
    try {
      const result = await discoverCompute({
        host,
        port: draft.llmPorts[0] ?? null,
        sshUser: draft.sshUser || undefined,
        sshAuth: draft.sshAuth,
        credRef: draft.credRef,
        nodeId: draft.id || null,
      });
      setDiscovery(result);
      setDraft((prev) => applyDiscovery(prev, result));
      if (!result.reachable) {
        setLocalError("Host did not answer — fields stay UNKNOWN (you can still continue manually).");
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function changeName(name: string) {
    setDraft((prev) => {
      const next = markManual(prev, "name");
      // keep the slug in lockstep until the operator edits the id itself
      const shouldTrack = !prev.provenance.id || prev.provenance.id === "inferred" || prev.provenance.id === "manual";
      return {
        ...next,
        name,
        id: shouldTrack ? deriveId(name, prefixHost(prev), takenIds) : next.id,
        provenance: { ...next.provenance, id: shouldTrack ? "inferred" : next.provenance.id },
      };
    });
  }

  function prefixHost(d: ComputeDraft) {
    return d.lanIp || d.id;
  }

  function addPeer(to: string) {
    setDraft((prev) => {
      if (prev.fabricLinks.some((l) => l.to === to)) return prev;
      const links: FabricLinkConfig[] = [...prev.fabricLinks, { to, speedMbps: null, medium: "cx7" }];
      return { ...prev, fabricLinks: links, provenance: { ...prev.provenance, fabricLinks: "manual" } };
    });
  }

  function updatePeer(to: string, patchLink: Partial<FabricLinkConfig>) {
    setDraft((prev) => ({
      ...prev,
      fabricLinks: prev.fabricLinks.map((l) => (l.to === to ? { ...l, ...patchLink } : l)),
    }));
  }

  function removePeer(to: string) {
    setDraft((prev) => ({ ...prev, fabricLinks: prev.fabricLinks.filter((l) => l.to !== to) }));
  }

  function canAdvance(): boolean {
    if (step === 0) return Boolean(draftHost(draft)) || draft.isLocal;
    if (step === 1) return Boolean(draft.name.trim() && draft.id.trim()) && !validation.blocking.some((i) => i.field === "id" || i.field === "name");
    if (step === 5) return !blocked;
    return true;
  }

  function next() {
    if (!canAdvance()) {
      setLocalError("Resolve the blocking items first.");
      return;
    }
    setLocalError(null);
    setStep((s) => Math.min(s + 1, COMPUTE_STEPS.length - 1));
  }

  const prov = (key: keyof ComputeDraft) => draft.provenance[String(key)];

  const current = COMPUTE_STEPS[step];
  const isLast = step === COMPUTE_STEPS.length - 1;

  function submit() {
    if (blocked) {
      setLocalError("Resolve the blocking items first.");
      return;
    }
    void onSave(draftToConfig(draft));
  }

  return (
    <div className="cp-add-compute">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <Chip tone="accent">config-first</Chip>
        <span className="cp-field-hint">read-only probe · CONFIG-only save · remote never mutated</span>
        {onAdvanced ? (
          <button type="button" className="cp-link" onClick={onAdvanced}>
            Advanced manual form
          </button>
        ) : null}
      </div>

      <Stepper
        steps={COMPUTE_STEPS.map((s) => ({ id: s.key, label: s.title }))}
        current={step}
        onSelect={(i) => setStep(i)}
        ariaLabel="Add compute steps"
      />

      <div style={{ marginTop: 14 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>{current.title}</span>
          <span className="cp-field-hint">{current.hint}</span>
        </div>

        {/* ── Step 1 · Discover / connect ── */}
        {step === 0 ? (
          <>
            <FormSection legend="Target (one host — no sweep)" columns={4}>
              <Field label="Known node" htmlFor="ac-known" hint="Optional: prefill from config">
                <Select id="ac-known" value={existing.find((n) => n.lanIp === draft.lanIp)?.id ?? ""} onChange={(e) => pickKnownNode(e.target.value)}>
                  <option value="">— type a host —</option>
                  {existing.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name || n.id} ({n.lanIp || "no ip"})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Host / IP" htmlFor="ac-host" error={!draftHost(draft) && !draft.isLocal ? "required" : null}>
                <TextInput id="ac-host" mono value={draft.lanIp} placeholder="192.168.1.170" onChange={(e) => patchManual("lanIp", e.target.value)} />
              </Field>
              <Field label="SSH user" htmlFor="ac-user" hint="Used only for read-only facts">
                <TextInput id="ac-user" value={draft.sshUser} placeholder="musa" onChange={(e) => patchManual("sshUser", e.target.value)} />
              </Field>
              <Field label="Credential ref" htmlFor="ac-cred" hint="Optional; value never echoed">
                <Select id="ac-cred" value={draft.credRef ?? ""} onChange={(e) => patch({ credRef: e.target.value || null })}>
                  <option value="">none</option>
                  {credRefs.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>
            </FormSection>

            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
              <button type="button" className="cp-btn primary" onClick={() => void runDiscovery()} disabled={busy}>
                {busy ? "Probing…" : "Discover (read-only)"}
              </button>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }} className="muted">
                <input type="checkbox" checked={draft.isLocal} onChange={(e) => patch({ isLocal: e.target.checked })} />
                This host (no SSH)
              </label>
            </div>

            {discovery ? (
              <div className="cp-panel" style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <StatusDot status={discovery.reachable ? "online" : "offline"} />
                  <span style={{ fontSize: 12 }}>{discovery.reachable ? "Reachable" : "Not reachable"}</span>
                  <Chip>{discovery.endpoints.length} endpoint(s) probed</Chip>
                  {discovery.knownNodeId ? <Chip tone="accent">matched {discovery.knownNodeId}</Chip> : null}
                </div>
                <ul className="muted" style={{ fontSize: 11, margin: 0, paddingLeft: 16 }}>
                  {discovery.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
                {discovery.endpoints.length ? (
                  <div className="mono" style={{ fontSize: 11, marginTop: 6 }}>
                    {discovery.endpoints.map((e) => (
                      <div key={e.port}>
                        :{e.port} {e.reachable ? "up" : "no answer"} {e.servedModelIds.length ? `→ ${e.servedModelIds[0]}` : ""}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}

        {/* ── Step 2 · Identity ── */}
        {step === 1 ? (
          <FormSection legend="Identity" columns={2}>
            <Field label="Display name" htmlFor="ac-name">
              <TextInput id="ac-name" value={draft.name} placeholder="DGX 4" onChange={(e) => changeName(e.target.value)} />
            </Field>
            <Field label="Node id (slug)" htmlFor="ac-id" hint="Auto-derived · uniqueness enforced">
              <TextInput id="ac-id" mono value={draft.id} onChange={(e) => patchManual("id", slugify(e.target.value))} />
              <ProvenanceBadge value={prov("id")} />
            </Field>
            <Field label="Unit type" htmlFor="ac-kind">
              <Select id="ac-kind" value={draft.kind} onChange={(e) => patchManual("kind", e.target.value)}>
                <option value="spark">NVIDIA DGX Spark</option>
                <option value="host">Dedicated GPU host</option>
              </Select>
              <ProvenanceBadge value={prov("kind")} />
            </Field>
            <Field label="Fabric id" htmlFor="ac-fabric" hint="Optional named physical fabric">
              <TextInput id="ac-fabric" mono value={draft.fabric ?? ""} onChange={(e) => patchManual("fabric", e.target.value || null)} />
              <ProvenanceBadge value={prov("fabric")} />
            </Field>
          </FormSection>
        ) : null}

        {/* ── Step 3 · Capabilities ── */}
        {step === 2 ? (
          <FormSection legend="Capabilities (discovered or manual — UNKNOWN allowed)" columns={3}>
            <Field label="GPU / device" htmlFor="ac-gpu" hint="Discovered only if nvidia-smi answered">
              <TextInput id="ac-gpu" mono value={draft.gpuChip ?? ""} placeholder="unknown" onChange={(e) => patchManual("gpuChip", e.target.value || null)} />
              <ProvenanceBadge value={prov("gpuChip")} />
            </Field>
            <Field label="GPU memory (GB)" htmlFor="ac-gmem">
              <TextInput id="ac-gmem" inputMode="numeric" value={draft.gpuMemoryGB ?? ""} placeholder="unknown" onChange={(e) => patchManual("gpuMemoryGB", e.target.value ? Number(e.target.value) : null)} />
              <ProvenanceBadge value={prov("gpuMemoryGB")} />
            </Field>
            <Field label="System memory (GB)" htmlFor="ac-mem">
              <TextInput id="ac-mem" inputMode="numeric" value={draft.memoryGB ?? ""} placeholder="unknown" onChange={(e) => patchManual("memoryGB", e.target.value ? Number(e.target.value) : null)} />
              <ProvenanceBadge value={prov("memoryGB")} />
            </Field>
            <Field label="CPU cores" htmlFor="ac-cores">
              <TextInput id="ac-cores" inputMode="numeric" value={draft.cpuCores ?? ""} placeholder="unknown" onChange={(e) => patchManual("cpuCores", e.target.value ? Number(e.target.value) : null)} />
              <ProvenanceBadge value={prov("cpuCores")} />
            </Field>
            <Field label="Hostname" htmlFor="ac-hostname">
              <TextInput id="ac-hostname" mono value={draft.hostname ?? ""} placeholder="unknown" onChange={(e) => patchManual("hostname", e.target.value || null)} />
              <ProvenanceBadge value={prov("hostname")} />
            </Field>
            <Field label="Architecture" htmlFor="ac-arch">
              <TextInput id="ac-arch" mono value={draft.arch ?? ""} placeholder="unknown" onChange={(e) => patchManual("arch", e.target.value || null)} />
              <ProvenanceBadge value={prov("arch")} />
            </Field>
          </FormSection>
        ) : null}

        {/* ── Step 4 · Network ── */}
        {step === 3 ? (
          <FormSection legend="Network (address + ports)" columns={3}>
            <Field label="LAN IP / hostname" htmlFor="ac-lanip">
              <TextInput id="ac-lanip" mono value={draft.lanIp} onChange={(e) => patchManual("lanIp", e.target.value)} />
              <ProvenanceBadge value={prov("lanIp")} />
            </Field>
            <Field label="CX7 / fabric IP" htmlFor="ac-cx7" hint="Optional">
              <TextInput id="ac-cx7" mono value={draft.cx7Ip ?? ""} placeholder="unknown" onChange={(e) => patchManual("cx7Ip", e.target.value || null)} />
              <ProvenanceBadge value={prov("cx7Ip")} />
            </Field>
            <Field label="LLM ports" htmlFor="ac-ports" hint="Comma separated">
              <TextInput
                id="ac-ports"
                mono
                value={portText}
                onChange={(e) => {
                  setPortText(e.target.value);
                  patchManual("llmPorts", parsePorts(e.target.value, defaultLlmPort));
                }}
              />
              <ProvenanceBadge value={prov("llmPorts")} />
            </Field>
          </FormSection>
        ) : null}

        {/* ── Step 5 · Fabric ── */}
        {step === 4 ? (
          <>
            <FormSection legend="Configured physical fabric links (selectable peers)" columns={2}>
              <Field label="Add peer" htmlFor="ac-peer">
                <Select id="ac-peer" value="" onChange={(e) => e.target.value && addPeer(e.target.value)}>
                  <option value="">— select a node —</option>
                  {peers.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name || n.id}
                    </option>
                  ))}
                </Select>
              </Field>
            </FormSection>
            {draft.fabricLinks.length === 0 ? (
              <p className="muted" style={{ fontSize: 12 }}>No configured links — fabric stays UNKNOWN (never a fabricated triangle).</p>
            ) : (
              <div className="cp-panel">
                {draft.fabricLinks.map((l) => (
                  <div key={l.to} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                    <span className="mono" style={{ minWidth: 120 }}>{l.to}</span>
                    <Select aria-label={`${l.to} medium`} value={l.medium ?? "cx7"} onChange={(e) => updatePeer(l.to, { medium: e.target.value as "cx7" | "fabric" })} style={{ maxWidth: 120 }}>
                      <option value="cx7">cx7</option>
                      <option value="fabric">fabric</option>
                    </Select>
                    <TextInput aria-label={`${l.to} speed Mbps`} inputMode="numeric" placeholder="unknown" value={l.speedMbps ?? ""} onChange={(e) => updatePeer(l.to, { speedMbps: e.target.value ? Number(e.target.value) : null })} style={{ maxWidth: 130 }} />
                    <button type="button" className="cp-btn ghost" onClick={() => removePeer(l.to)}>remove</button>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : null}

        {/* ── Step 6 · Validate ── */}
        {step === 5 ? (
          <div className="cp-panel">
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <Chip tone={blocked ? "mono" : "accent"}>{blocked ? "INVALID" : "VALID"}</Chip>
              <span className="muted" style={{ fontSize: 12 }}>
                {validation.advisory.length} NOT-VERIFIED · config-only (remote never touched)
              </span>
              <button type="button" className="cp-btn" onClick={() => { setServerValidation(null); setRecheckTick((t) => t + 1); }}>re-check</button>
            </div>
            <IssueList items={validation.blocking} tone="invalid" />
            <IssueList items={validation.advisory} tone="unverified" />
            {validation.blocking.length === 0 && validation.advisory.length === 0 ? (
              <p className="muted" style={{ fontSize: 12 }}>No issues.</p>
            ) : null}
          </div>
        ) : null}

        {/* ── Step 7 · Review ── */}
        {step === 6 || step === 7 ? (
          <div className="cp-panel">
            <dl className="cp-discover-detected">
              <dt>name</dt><dd>{draft.name || <span className="muted">unknown</span>}</dd>
              <dt>id</dt><dd className="mono">{draft.id || "—"}</dd>
              <dt>kind</dt><dd>{draft.kind} <ProvenanceBadge value={prov("kind")} /></dd>
              <dt>host</dt><dd className="mono">{draft.lanIp || "—"} <ProvenanceBadge value={prov("lanIp")} /></dd>
              <dt>gpu</dt><dd className="mono">{draft.gpuChip ?? "unknown"} <ProvenanceBadge value={prov("gpuChip")} /></dd>
              <dt>cores / memory</dt><dd className="mono">{draft.cpuCores ?? "?"} / {draft.memoryGB ?? "?"} GB</dd>
              <dt>ports</dt><dd className="mono">{draft.llmPorts.join(", ")}</dd>
              <dt>fabric links</dt><dd className="mono">{draft.fabricLinks.length ? draft.fabricLinks.map((l) => `${l.to}(${l.medium ?? "cx7"})`).join(", ") : <span className="muted">none / unknown</span>}</dd>
            </dl>
            {step === 7 ? (
              <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                SAVE writes config only — no remote action, no lifecycle, no restart.
              </p>
            ) : null}
          </div>
        ) : null}

        {localError ? <div className="cp-field-error" role="alert" style={{ marginTop: 8 }}>{localError}</div> : null}
        {error ? <div className="cp-field-error" role="alert" style={{ marginTop: 8 }}>{error}</div> : null}
      </div>

      <div className="modal-sheet__footer" style={{ display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
        <button type="button" className="cp-btn ghost" onClick={step === 0 ? onCancel : () => setStep((s) => s - 1)}>
          {step === 0 ? "Cancel" : "Back"}
        </button>
        {isLast ? (
          <button type="button" className="cp-btn primary" onClick={submit} disabled={saving || blocked}>
            {saving ? "Saving…" : "Save (config only)"}
          </button>
        ) : (
          <button type="button" className="cp-btn primary" onClick={next} disabled={busy}>
            Next
          </button>
        )}
      </div>
    </div>
  );
}
