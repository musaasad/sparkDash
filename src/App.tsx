import { useState, useCallback, useEffect, useMemo } from "react";
import { useSnapshot } from "./hooks/useSnapshot";
import { useAppRoute } from "./hooks/useRoute";
import { useControlPlaneRoute } from "./hooks/router";
import { useControlPlaneData } from "./hooks/useControlPlaneData";
import { useDeployments } from "./hooks/domainStore";
import { fetchSparks, fetchSettings } from "./api/client";
import { AddSparkDialog } from "./components/AddSparkDialog";
import { EditSparkDialog } from "./components/EditSparkDialog";
import { ShowcasePage } from "./components/ShowcasePage/ShowcasePage";
import { HermesUpdateDialog } from "./components/SparkPage/HermesUpdateDialog";
import { ThemeSwitch } from "./components/ThemeSwitch";
import { ConnectionBanner } from "./components/ui/ConnectionBanner";
import { ErrorBanner } from "./components/ui/ErrorBanner";
import { AppNav } from "./components/control-plane/AppNav";
import { Breadcrumb } from "./components/ui/Breadcrumb";
import { PageHeader } from "./components/ui/PageHeader";
import type { Crumb } from "./components/ui/Breadcrumb";
import type { Section } from "./hooks/router";
import { OverviewSection } from "./components/control-plane/OverviewSection";
import { FleetSection } from "./components/control-plane/FleetSection";
import { NodeDetail } from "./components/control-plane/NodeDetail";
import { ModelsSection } from "./components/control-plane/ModelsSection";
import { ModelDetail } from "./components/control-plane/ModelDetail";
import { ActivitySection } from "./components/control-plane/ActivitySection";
import { BenchmarksSection } from "./components/control-plane/BenchmarksSection";
import { SettingsSection } from "./components/control-plane/SettingsSection";
import type { Settings, SparkSnapshot } from "./api/types";

function placeholderSnapshot(
  id: string,
  name: string,
  disabledDevices: string[] = [],
  disabledInterfaces: string[] = [],
  llmPorts: number[] = [8888],
  roleFields?: {
    role?: SparkSnapshot["role"];
    workerNode?: boolean;
    workerLabel?: string | null;
    workerHeadId?: string | null;
    llmMonitoring?: boolean;
    comfyMonitoring?: boolean;
    comfyPort?: number;
    tailscaleMonitoring?: boolean;
    kind?: "spark" | "host";
  }
): SparkSnapshot {
  const role =
    roleFields?.role === "head" ||
    roleFields?.role === "worker" ||
    roleFields?.role === "standalone"
      ? roleFields.role
      : roleFields?.workerNode
        ? "worker"
        : "standalone";
  const workerNode = role === "worker";
  return {
    id,
    name,
    kind: roleFields?.kind ?? "spark",
    online: false,
    uptime: null,
    disabledDevices,
    disabledInterfaces,
    llmPort: llmPorts[0] ?? 8888,
    llmPorts,
    workerNode,
    role,
    workerLabel: workerNode ? roleFields?.workerLabel ?? null : null,
    workerHeadId: workerNode ? roleFields?.workerHeadId ?? null : null,
    llmMonitoring:
      role === "worker"
        ? false
        : role === "head"
          ? true
          : roleFields?.llmMonitoring !== false,
    comfyMonitoring: Boolean(roleFields?.comfyMonitoring),
    comfyPort: roleFields?.comfyPort ?? 8188,
    tailscaleMonitoring: Boolean(roleFields?.tailscaleMonitoring),
    hermes: {
      monitoring: false,
      installed: null,
      version: null,
      updateAvailable: null,
      behindCommits: null,
      checkedAt: null,
      status: "idle",
      startedAt: null,
      finishedAt: null,
      error: null,
    },
    hardware: {
      device: "NVIDIA DGX Spark",
      cpuModel: "…",
      cpuCores: 0,
      totalMemoryGB: 0,
      gpuChip: "…",
      cudaDriver: null,
      storageModel: null,
    },
    metrics: {
      gpu: null,
      cpu: null,
      ram: null,
      storage: [],
      network: null,
      unifiedMemory: null,
      llm: [],
      comfy: null,
      tailscale: null,
    },
  };
}

/** Shell-level page grammar per list section (detail routes own their header). */
const PAGE_META: Record<
  Exclude<Section, never>,
  { title: string; subtitle: string; trail: string }
> = {
  overview: {
    title: "Overview",
    subtitle: "Operational summary of the lab — fleet health, deployments and activity at a glance.",
    trail: "Overview",
  },
  models: {
    title: "Models",
    subtitle: "The model registry — a model can host many deployment recipes.",
    trail: "Models",
  },
  fleet: {
    title: "Fleet",
    subtitle: "Compute nodes with live GPU, runtime and thermal status.",
    trail: "Fleet",
  },
  activity: {
    title: "Activity",
    subtitle: "Everything that happened in the lab — node changes, deployments, benchmarks and alerts.",
    trail: "Activity",
  },
  benchmarks: {
    title: "Benchmarks",
    subtitle: "A/B comparison runs across models, recipes and nodes.",
    trail: "Benchmarks",
  },
  settings: {
    title: "Settings",
    subtitle: "Lab configuration — grouped by subsystem. Each section saves on its own.",
    trail: "Settings",
  },
};

function DashboardApp() {
  const {
    sparks,
    connected,
    lastValidSnapshotAt,
    snapshotError,
    refreshInterval,
  } = useSnapshot();
  const { route, navigate } = useControlPlaneRoute();
  const cp = useControlPlaneData();
  const deployments = useDeployments();
  const [telemetryNow, setTelemetryNow] = useState(Date.now());
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Used when WS is down so section data still renders. */
  const [fallbackSparks, setFallbackSparks] = useState<SparkSnapshot[]>([]);
  /** Local dry-run activity clear cursor shared by Activity + Settings. */
  const [activityClearedUpTo, setActivityClearedUpTo] = useState<number | null>(null);
  const staleAfterMs = Math.max(10_000, 3 * (refreshInterval ?? 2_000));
  const telemetryStale =
    lastValidSnapshotAt != null && telemetryNow - lastValidSnapshotAt > staleAfterMs;

  useEffect(() => {
    if (lastValidSnapshotAt == null) return;
    setTelemetryNow(Date.now());
    const timer = window.setInterval(() => setTelemetryNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [lastValidSnapshotAt]);

  const liveSparks = sparks.length > 0 ? sparks : fallbackSparks;

  useEffect(() => {
    if (sparks.length > 0) setFallbackSparks([]);
  }, [sparks]);

  // Fetch global settings on mount (density, units, feature flags).
  useEffect(() => {
    fetchSettings()
      .then(setSettings)
      .catch((err) =>
        setActionError(
          `Could not load settings: ${err instanceof Error ? err.message : String(err)}. Reload to retry.`
        )
      );
  }, []);

  // Apply layout density (comfortable/compact) from persisted settings.
  useEffect(() => {
    if (settings?.density) {
      document.documentElement.setAttribute("data-density", settings.density);
    }
  }, [settings?.density]);

  const refreshFromApi = useCallback(async () => {
    try {
      const { sparks: configs } = await fetchSparks();
      setFallbackSparks(
        configs.map((c) => {
          const existing = sparks.find((s) => s.id === c.id);
          if (existing) {
            return {
              ...existing,
              name: c.name,
              role: c.role ?? existing.role,
              workerNode: c.workerNode ?? existing.workerNode,
              workerLabel: c.workerLabel ?? existing.workerLabel,
              workerHeadId: c.workerHeadId ?? existing.workerHeadId,
              llmMonitoring: c.llmMonitoring ?? existing.llmMonitoring,
              comfyMonitoring: c.comfyMonitoring ?? existing.comfyMonitoring,
              comfyPort: c.comfyPort ?? existing.comfyPort,
              tailscaleMonitoring: c.tailscaleMonitoring ?? existing.tailscaleMonitoring,
              disabledDevices: c.disabledDevices || existing.disabledDevices,
              disabledInterfaces: c.disabledInterfaces || existing.disabledInterfaces,
              llmPorts: c.llmPorts ?? existing.llmPorts,
              llmPort: c.llmPorts?.[0] ?? c.llmPort ?? existing.llmPort,
              kind: c.kind ?? existing.kind,
            };
          }
          return placeholderSnapshot(
            c.id,
            c.name,
            c.disabledDevices || [],
            c.disabledInterfaces || [],
            c.llmPorts ?? (c.llmPort ? [c.llmPort] : [8888]),
            {
              role: c.role,
              workerNode: c.workerNode,
              workerLabel: c.workerLabel,
              workerHeadId: c.workerHeadId,
              llmMonitoring: c.llmMonitoring,
              comfyMonitoring: c.comfyMonitoring,
              comfyPort: c.comfyPort,
              tailscaleMonitoring: c.tailscaleMonitoring,
              kind: c.kind,
            }
          );
        })
      );
    } catch (err) {
      console.error("Failed to refresh sparks:", err);
      setActionError(
        `Could not refresh Sparks: ${err instanceof Error ? err.message : String(err)}. Previous data remains visible.`
      );
    }
  }, [sparks]);

  const activeNode = useMemo(() => {
    if (route.section !== "node") return null;
    return liveSparks.find((s) => s.id === route.nodeId) ?? null;
  }, [route, liveSparks]);

  const listSection: Section | null =
    route.section === "model" || route.section === "node" ? null : (route.section as Section);
  const pageMeta = listSection ? PAGE_META[listSection] : null;
  const crumbs: Crumb[] = pageMeta
    ? [{ label: "Lab", route: { section: "overview" } }, { label: pageMeta.trail }]
    : [];

  return (
    <div className="min-h-screen text-text">
      <div className="cp-shell">
        <AppNav
          route={route}
          navigate={navigate}
          connected={connected}
          stale={telemetryStale}
          right={<ThemeSwitch />}
          counts={{
            fleet: liveSparks.length,
            models: cp.models.length,
            activity: cp.activity.length,
          }}
        />
        <div className="cp-main">
          <div className="cp-body">
            <ConnectionBanner
              connected={connected}
              lastValidSnapshotAt={lastValidSnapshotAt}
              snapshotError={snapshotError}
              now={telemetryNow}
              stale={telemetryStale}
            />
            <ErrorBanner
              message={actionError}
              onDismiss={() => setActionError(null)}
              onRetry={() => void refreshFromApi()}
            />
            <main className={telemetryStale || !connected ? "telemetry-stale" : undefined}>
              {pageMeta ? (
                <div>
                  <Breadcrumb items={crumbs} navigate={navigate} />
                  <PageHeader title={pageMeta.title} subtitle={pageMeta.subtitle} />
                </div>
              ) : null}
              {route.section === "overview" ? (
                <OverviewSection
                  sparks={liveSparks}
                  deployments={deployments}
                  recipes={cp.recipes}
                  navigate={navigate}
                  loaded={cp.loaded || sparks.length > 0}
                  models={cp.models}
                  activity={cp.activity}
                  temperatureUnit={settings?.temperatureUnit ?? "celsius"}
                />
              ) : null}
              {route.section === "fleet" ? (
                <FleetSection sparks={liveSparks} deployments={deployments} recipes={cp.recipes} models={cp.models} navigate={navigate} />
              ) : null}
              {route.section === "node" ? (
                activeNode ? (
                  <NodeDetail
                    spark={activeNode}
                    allSparks={liveSparks}
                    recipes={cp.recipes}
                    deployments={deployments}
                    temperatureUnit={settings?.temperatureUnit ?? "celsius"}
                    benchShareImage={settings?.benchShareImage ?? false}
                    navigate={navigate}
                    onEdit={() => setEditId(activeNode.id)}
                    onAddNode={() => setShowAdd(true)}
                    onSaved={() => void cp.reload()}
                  />
                ) : (
                  <div className="cp-panel">
                    <div className="cp-empty">
                      <div className="cp-empty-title">Node not found</div>
                      <div className="cp-empty-sub">
                        “{route.nodeId}” is not a registered node. It may have been removed.
                      </div>
                      <button type="button" className="cp-btn" style={{ marginTop: 8 }} onClick={() => navigate({ section: "fleet" })}>
                        ← Back to Fleet
                      </button>
                    </div>
                  </div>
                )
              ) : null}
              {route.section === "models" ? (
                <ModelsSection
                  models={cp.models}
                  recipes={cp.recipes}
                  deployments={deployments}
                  sparks={liveSparks}
                  activity={cp.activity}
                  navigate={navigate}
                  onSaved={() => void cp.reload()}
                />
              ) : null}
              {route.section === "model" ? (
                <ModelDetail
                  modelId={route.modelId}
                  initialTab={route.tab}
                  initialReqId={route.reqId}
                  sparks={liveSparks}
                  navigate={navigate}
                  onDataChanged={() => void cp.reload()}
                />
              ) : null}
              {route.section === "activity" ? (
                <ActivitySection
                  events={cp.activity}
                  reqId={route.reqId}
                  clearedUpTo={activityClearedUpTo}
                  onClearActivity={setActivityClearedUpTo}
                  onOpenInConsole={(event) => {
                    const recipeId = event.meta?.recipeId != null ? String(event.meta.recipeId) : null;
                    const reqId = event.meta?.reqId != null ? Number(event.meta.reqId) : undefined;
                    const rec = cp.recipes.find((r) => r.id === recipeId) ?? cp.recipes.find((r) => r.id === event.subject);
                    if (rec) navigate({ section: "model", modelId: rec.modelId, tab: "live-console", reqId });
                  }}
                />
              ) : null}
              {route.section === "benchmarks" ? (
                <BenchmarksSection sparks={liveSparks} recipes={cp.recipes} navigate={navigate} />
              ) : null}
              {route.section === "settings" ? (
                <SettingsSection
                  sparks={liveSparks}
                  navigate={navigate}
                  onSparksChanged={() => void refreshFromApi()}
                  activityLatestSeq={cp.activity.reduce((m, e) => Math.max(m, e.seq), 0)}
                  onClearActivity={setActivityClearedUpTo}
                />
              ) : null}
            </main>
          </div>
        </div>
      </div>
      <HermesUpdateDialog />
      <AddSparkDialog
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onAdded={() => {
          void refreshFromApi();
        }}
        defaultLlmPort={settings?.defaultLlmPort ?? 8888}
      />
      <EditSparkDialog
        open={editId != null}
        sparkId={editId}
        onClose={() => setEditId(null)}
        onSaved={() => {
          void refreshFromApi();
        }}
        onDeleted={() => {
          setEditId(null);
          void refreshFromApi();
          navigate({ section: "fleet" });
        }}
      />
    </div>
  );
}

function App() {
  const route = useAppRoute();
  if (route.mode === "showcase" && route.showcaseSparkId) {
    return <ShowcasePage sparkId={route.showcaseSparkId} />;
  }
  return <DashboardApp />;
}

export default App;