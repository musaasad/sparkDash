import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { SparkSnapshot, Settings } from "../../api/types";
import type { Route } from "../../hooks/router";
import { fetchDeployments, fetchSettings, updateSettings } from "../../api/client";
import { getDeployments, subscribeDomain } from "../../hooks/domainStore";
import { DataTable, type Column } from "../ui/DataTable";
import { Chip, EmptyState, StatusPill } from "../ui/Status";
import { SettingRow, RadioCard, useDirtyState, useTypeToConfirm, validateIntRange, validatePort } from "../ui/form";
import { AddSparkDialog } from "../AddSparkDialog";
import { EditSparkDialog } from "../EditSparkDialog";
import { SettingsDialog } from "../SettingsDialog";
import { isWorkerSpark } from "../../api/sparkRole";

interface SettingsProps {
  sparks: SparkSnapshot[];
  navigate: (route: Route) => void;
  onSparksChanged: () => void;
  /** Newest loaded activity seq — the local clear cursor target. */
  activityLatestSeq?: number;
  /** Real local dry-run clear: hides loaded activity up to the newest seq. */
  onClearActivity?: (newestSeq: number) => void;
}

type SectionKey = "general" | "models" | "gpu" | "storage" | "network" | "advanced" | "danger";

const THEME_KEY = "sparkdash-theme";
type Theme = "white" | "light" | "dark" | "oled";

const SECTIONS: Array<{ key: SectionKey; label: string; danger?: boolean }> = [
  { key: "general", label: "General" },
  { key: "models", label: "Models" },
  { key: "gpu", label: "GPU / Runtime" },
  { key: "storage", label: "Storage" },
  { key: "network", label: "Network" },
  { key: "advanced", label: "Advanced" },
  { key: "danger", label: "Danger Zone", danger: true },
];

/** Settings keys owned by each saveable section. */
const SECTION_KEYS: Record<SectionKey, Array<keyof Settings>> = {
  general: ["temperatureUnit", "density", "autoHideOffline", "hideWorkers", "showOverviewSearch"],
  models: ["benchShareImage"],
  gpu: ["showFleetEnergy", "showFleetExceptions"],
  storage: ["benchDebugTraces"],
  network: ["pollIntervalMs", "defaultLlmPort"],
  advanced: [],
  danger: [],
};

function readTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const stored = localStorage.getItem(THEME_KEY) as Theme | null;
  return stored ?? "dark";
}

/**
 * Settings = lab configuration. Left rail by subsystem, one section per page,
 * Danger Zone last. Validation is inline adjacent to the field; Save is
 * section-scoped and stays disabled until the section is dirty and valid.
 */
export function SettingsSection({ sparks, navigate, onSparksChanged, activityLatestSeq = 0, onClearActivity }: SettingsProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [serverOpen, setServerOpen] = useState(false);
  const [dryRun, setDryRun] = useState<boolean | null>(null);
  const [section, setSection] = useState<SectionKey>("general");
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [benchCleared, setBenchCleared] = useState(false);
  const [activityCleared, setActivityCleared] = useState(false);

  const form = useDirtyState<Settings | null>(null);
  const activityConfirm = useTypeToConfirm("activity");
  const benchConfirm = useTypeToConfirm("benchmarks");

  useEffect(() => {
    fetchDeployments()
      .then((r) => setDryRun(r.dryRun))
      .catch(() => setDryRun(null));
    fetchSettings()
      .then((s) => form.reset(s))
      .catch((err: Error) => setSaveError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(t);
  }, [toast]);

  const deployments = useSyncExternalStore(subscribeDomain, getDeployments, getDeployments);

  const settings = form.value;

  const errors = useMemo(() => {
    if (!settings) return {} as Partial<Record<keyof Settings, string>>;
    return {
      defaultLlmPort: validatePort(settings.defaultLlmPort),
      pollIntervalMs: validateIntRange(settings.pollIntervalMs, 500, 60_000, "ms"),
    } as Partial<Record<keyof Settings, string>>;
  }, [settings]);

  const sectionKeys = SECTION_KEYS[section];
  const sectionInvalid = sectionKeys.some((k) => errors[k]);
  const canSave = form.dirty && sectionKeys.length > 0 && !sectionInvalid && !saving;

  const saveSection = async () => {
    if (!settings || !canSave) return;
    const patch: Partial<Settings> = {};
    for (const k of sectionKeys) (patch as Record<string, unknown>)[k] = settings[k];
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await updateSettings(patch);
      form.reset(saved);
      setToast(`${SECTIONS.find((s) => s.key === section)?.label} saved`);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const columns: Column<SparkSnapshot>[] = [
    {
      key: "name",
      header: "Node",
      render: (s) => (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className={`cp-dot ${s.online ? "running" : "stopped"}`} />
          <span style={{ fontWeight: 500 }}>{s.name}</span>
          <Chip>{s.kind === "host" ? "host" : "spark"}</Chip>
          {isWorkerSpark(s) ? <Chip>worker</Chip> : null}
        </div>
      ),
    },
    { key: "ip", header: "Address", mono: true, muted: true, render: (s) => s.lanIp || "—" },
    { key: "ports", header: "LLM ports", mono: true, render: (s) => (s.llmPorts?.length ? s.llmPorts.join(", ") : "—") },
    {
      key: "actions",
      header: "",
      width: "120px",
      render: (s) => (
        <button
          type="button"
          className="cp-btn ghost"
          onClick={(e) => {
            e.stopPropagation();
            setEditId(s.id);
          }}
        >
          Edit
        </button>
      ),
    },
  ];

  const active = SECTIONS.find((s) => s.key === section);
  const activeLabel = active?.label ?? "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div className="cp-section-title">Settings</div>
        <div className="cp-section-sub">Lab configuration — grouped by subsystem. Each section saves on its own.</div>
      </div>

      {saveError ? <div className="cp-banner is-amber" role="alert">{saveError}</div> : null}

      <div className="cp-settings-layout">
        <nav className="cp-settings-rail" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`cp-rail-item${section === s.key ? " is-active" : ""}${s.danger ? " danger" : ""}`}
              aria-current={section === s.key}
              onClick={() => setSection(s.key)}
            >
              {s.danger ? <span className="cp-danger-icon" aria-hidden="true">⚠</span> : null}
              {s.label}
            </button>
          ))}
        </nav>

        <section className="cp-panel cp-settings-panel" aria-label={`${activeLabel} settings`}>
          <div className="cp-panel-title">
            <span className={active?.danger ? "cp-danger-title" : undefined}>{activeLabel}</span>
            {sectionKeys.length > 0 ? (
              <button type="button" className="cp-btn primary" disabled={!canSave} onClick={() => void saveSection()}>
                {saving ? "Saving…" : "Save"}
              </button>
            ) : null}
          </div>

          {section === "general" && settings ? (
            <>
              <SettingRow label="Theme" hint="Applies instantly on this device; dark themes are dark-first.">
                <div className="cp-radio-group" role="radiogroup" aria-label="Theme">
                  {(["white", "light", "dark", "oled"] as Theme[]).map((t) => (
                    <RadioCard
                      key={t}
                      name="theme"
                      label={t}
                      helper={
                        t === "oled"
                          ? "Pure black for OLED panels."
                          : t === "dark" || t === "light"
                            ? "Balanced contrast for daily use."
                            : "Brightest; good in daylight."
                      }
                      selected={theme === t}
                      recommended={t === "dark"}
                      onSelect={() => setTheme(t)}
                    />
                  ))}
                </div>
              </SettingRow>

              <SettingRow label="Temperature unit" hint="Used on GPU/temperature readouts fleet-wide.">
                <div className="cp-radio-group" role="radiogroup" aria-label="Temperature unit">
                  <RadioCard
                    name="temperatureUnit"
                    label="Celsius (°C)"
                    helper="Matches DGX nvidia-smi output; no conversion."
                    selected={settings.temperatureUnit === "celsius"}
                    recommended
                    onSelect={() => form.update({ temperatureUnit: "celsius" })}
                  />
                  <RadioCard
                    name="temperatureUnit"
                    label="Fahrenheit (°F)"
                    helper="Familiar for US operators; converted client-side."
                    selected={settings.temperatureUnit === "fahrenheit"}
                    onSelect={() => form.update({ temperatureUnit: "fahrenheit" })}
                  />
                </div>
              </SettingRow>

              <SettingRow label="Compact UI" hint="Tighter spacing and smaller radius — fits more units per screen.">
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.density === "compact"}
                  className={`cp-toggle${settings.density === "compact" ? " is-on" : ""}`}
                  onClick={() => form.update({ density: settings.density === "compact" ? "comfortable" : "compact" })}
                >
                  <span className="cp-toggle-dot" />
                </button>
              </SettingRow>

              <SettingRow label="Auto-hide offline Sparks" hint="Offline units drop off Overview; direct URLs still work.">
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.autoHideOffline}
                  className={`cp-toggle${settings.autoHideOffline ? " is-on" : ""}`}
                  onClick={() => form.update({ autoHideOffline: !settings.autoHideOffline })}
                >
                  <span className="cp-toggle-dot" />
                </button>
              </SettingRow>

              <SettingRow label="Hide worker nodes" hint="Removes Worker-role Sparks from Overview and the tab bar.">
                <button
                  type="button"
                  role="switch"
                  aria-checked={Boolean(settings.hideWorkers)}
                  className={`cp-toggle${settings.hideWorkers ? " is-on" : ""}`}
                  onClick={() => form.update({ hideWorkers: !settings.hideWorkers })}
                >
                  <span className="cp-toggle-dot" />
                </button>
              </SettingRow>

              <SettingRow label="Overview search + status filters" hint="Off by default; one switch for both fields.">
                <button
                  type="button"
                  role="switch"
                  aria-checked={Boolean(settings.showOverviewSearch)}
                  className={`cp-toggle${settings.showOverviewSearch ? " is-on" : ""}`}
                  onClick={() => form.update({ showOverviewSearch: !settings.showOverviewSearch })}
                >
                  <span className="cp-toggle-dot" />
                </button>
              </SettingRow>

              <div className="cp-subhead">Compute nodes</div>
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
                <button type="button" className="cp-btn primary" onClick={() => setAddOpen(true)}>
                  + Add node
                </button>
              </div>
              <DataTable
                ariaLabel="Configured nodes"
                columns={columns}
                rows={sparks}
                rowKey={(s) => s.id}
                onRowClick={(s) => navigate({ section: "node", nodeId: s.id })}
                empty={<EmptyState title="No nodes" subtitle="Add a Spark or host to start observing your lab." />}
              />
            </>
          ) : null}

          {section === "models" && settings ? (
            <>
              <SettingRow label="Benchmark share image" hint="Adds a Copy-as-image share card to the Copy results button.">
                <button
                  type="button"
                  role="switch"
                  aria-checked={Boolean(settings.benchShareImage)}
                  className={`cp-toggle${settings.benchShareImage ? " is-on" : ""}`}
                  onClick={() => form.update({ benchShareImage: !settings.benchShareImage })}
                >
                  <span className="cp-toggle-dot" />
                </button>
              </SettingRow>
              <p className="cp-field-hint">Model and recipe registries are edited from the Models section.</p>
            </>
          ) : null}

          {section === "gpu" && settings ? (
            <>
              <SettingRow label="Fleet Energy card" hint="Overview card with rolling fleet power estimates. Off by default.">
                <button
                  type="button"
                  role="switch"
                  aria-checked={Boolean(settings.showFleetEnergy)}
                  className={`cp-toggle${settings.showFleetEnergy ? " is-on" : ""}`}
                  onClick={() => form.update({ showFleetEnergy: !settings.showFleetEnergy })}
                >
                  <span className="cp-toggle-dot" />
                </button>
              </SettingRow>
              <SettingRow label="Active fleet exceptions" hint="Overview strip for offline hosts, GPU throttle, disk and LLM alerts.">
                <button
                  type="button"
                  role="switch"
                  aria-checked={Boolean(settings.showFleetExceptions)}
                  className={`cp-toggle${settings.showFleetExceptions ? " is-on" : ""}`}
                  onClick={() => form.update({ showFleetExceptions: !settings.showFleetExceptions })}
                >
                  <span className="cp-toggle-dot" />
                </button>
              </SettingRow>
              <p className="cp-field-hint">
                Lifecycle controls stay DRY-RUN — no remote process is signalled from this panel.
              </p>
            </>
          ) : null}

          {section === "storage" && settings ? (
            <>
              <SettingRow label="Benchmark debug traces" hint="Stores prompts, HTTP IDs and GPU samples — larger history files.">
                <button
                  type="button"
                  role="switch"
                  aria-checked={Boolean(settings.benchDebugTraces)}
                  className={`cp-toggle${settings.benchDebugTraces ? " is-on" : ""}`}
                  onClick={() => form.update({ benchDebugTraces: !settings.benchDebugTraces })}
                >
                  <span className="cp-toggle-dot" />
                </button>
              </SettingRow>
              <p className="cp-field-hint">
                Activity log keeps the newest 2000 entries in <span className="mono">config/activity.jsonl</span>; model
                weights live outside SparkDash and are never deleted here.
              </p>
            </>
          ) : null}

          {section === "network" && settings ? (
            <>
              <SettingRow
                label="Poll interval"
                hint="How often the dashboard re-reads node metrics."
                error={errors.pollIntervalMs}
                htmlFor="set-poll"
              >
                <input
                  id="set-poll"
                  type="number"
                  className="cp-input mono"
                  min={500}
                  max={60000}
                  step={500}
                  aria-invalid={errors.pollIntervalMs ? "true" : undefined}
                  value={settings.pollIntervalMs}
                  onChange={(e) => form.update({ pollIntervalMs: Number(e.target.value) })}
                />
              </SettingRow>
              <SettingRow
                label="Default LLM port"
                hint="Pre-filled when adding a new Spark."
                error={errors.defaultLlmPort}
                htmlFor="set-port"
              >
                <input
                  id="set-port"
                  type="number"
                  className="cp-input mono"
                  min={1}
                  max={65535}
                  aria-invalid={errors.defaultLlmPort ? "true" : undefined}
                  value={settings.defaultLlmPort}
                  onChange={(e) => form.update({ defaultLlmPort: Number(e.target.value) })}
                />
              </SettingRow>
            </>
          ) : null}

          {section === "advanced" ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <Chip tone={dryRun === false ? "accent" : "default"}>{dryRun === false ? "LIVE (unexpected)" : "DRY-RUN"}</Chip>
                <span style={{ fontSize: 12, color: "var(--color-muted)" }}>
                  Start/Stop/Restart simulate state transitions and write audit entries. No process is launched or stopped.
                  Externally managed deployments always render controls disabled.
                </span>
              </div>
              {deployments.length > 0 ? (
                <table className="cp-table" style={{ marginTop: 10 }}>
                  <tbody>
                    {deployments.map((d) => (
                      <tr key={d.recipeId}>
                        <td className="mono">{d.recipeId}</td>
                        <td>{d.managedBy === "external" ? "externally managed" : "sparkdash-managed"}</td>
                        <td style={{ textAlign: "right" }}>
                          <StatusPill status={d.state as never} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
                <span style={{ fontSize: 12, color: "var(--color-muted)" }}>Server settings dialog (theme lives in General above)</span>
                <button type="button" className="cp-btn" onClick={() => setServerOpen(true)}>
                  Open server settings
                </button>
              </div>
            </>
          ) : null}

          {section === "danger" ? (
            <>
              <p className="cp-field-hint">
                These actions are irreversible and are clearly marked dry-run — no production host is touched.
              </p>

              <div className="cp-danger-block">
                <div className="cp-danger-head">
                  <span className="cp-danger-icon" aria-hidden="true">⚠</span>
                  <span className="cp-danger-title">Clear activity history</span>
                  <Chip tone="mono">dry-run</Chip>
                </div>
                <p className="cp-field-hint">
                  {activityCleared
                    ? "Activity feed hidden for this session. config/activity.jsonl stays on disk (nothing is deleted server-side)."
                    : "Hides every activity event loaded so far for this session. config/activity.jsonl on the server stays on disk."}
                </p>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                  <input
                    className="cp-input mono cp-danger-input"
                    aria-label="Type activity to confirm"
                    placeholder="activity"
                    value={activityConfirm.value}
                    onChange={(e) => activityConfirm.setValue(e.target.value)}
                  />
                  <button
                    type="button"
                    className="cp-btn danger"
                    disabled={!activityConfirm.ok}
                    onClick={() => {
                      onClearActivity?.(activityLatestSeq);
                      setActivityCleared(true);
                      setToast("Activity history cleared for this session — nothing deleted on disk");
                      activityConfirm.reset();
                    }}
                  >
                    Clear activity
                  </button>
                </div>
              </div>

              <div className="cp-danger-block">
                <div className="cp-danger-head">
                  <span className="cp-danger-icon" aria-hidden="true">⚠</span>
                  <span className="cp-danger-title">Clear benchmark history</span>
                  <Chip tone="mono">dry-run</Chip>
                </div>
                <p className="cp-field-hint">
                  {benchCleared
                    ? "History marked cleared for this session; weights remain on disk."
                    : "Hides stored decode/prefill run history. Model weights are kept."}
                </p>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                  <input
                    className="cp-input mono cp-danger-input"
                    aria-label="Type benchmarks to confirm"
                    placeholder="benchmarks"
                    value={benchConfirm.value}
                    onChange={(e) => benchConfirm.setValue(e.target.value)}
                  />
                  <button
                    type="button"
                    className="cp-btn danger"
                    disabled={!benchConfirm.ok}
                    onClick={() => {
                      setBenchCleared(true);
                      setToast("Benchmark history cleared (dry-run)");
                      benchConfirm.reset();
                    }}
                  >
                    Clear benchmarks
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </section>
      </div>

      {toast ? (
        <div className="cp-toast" role="status">
          {toast}
        </div>
      ) : null}

      <AddSparkDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={() => {
          setAddOpen(false);
          onSparksChanged();
        }}
      />
      <EditSparkDialog
        open={editId != null}
        sparkId={editId}
        onClose={() => setEditId(null)}
        onSaved={() => {
          setEditId(null);
          onSparksChanged();
        }}
        onDeleted={() => {
          setEditId(null);
          onSparksChanged();
        }}
      />
      <SettingsDialog open={serverOpen} onClose={() => setServerOpen(false)} onSaved={() => setServerOpen(false)} />
    </div>
  );
}
