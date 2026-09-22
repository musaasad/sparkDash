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

  return (
    <div className="min-h-screen p-0 text-text sm:p-6">
      <div className="cp-shell">
        <AppNav
          route={route}
          navigate={navigate}
          connected={connected}
          stale={telemetryStale}
          right={<ThemeSwitch />}
        />
        <div className="cp-body">
          <ConnectionBanner
            connected={connected}
            lastValidSnapshotAt={lastValidSnapshotAt}
            snapshotError={snapshotError}
            now={telemetryNow}
            stale={telemetryStale}
          />
          <ErrorBanner message={actionError} onDismiss={() => setActionError(null)} />
          <main className={telemetryStale || !connected ? "telemetry-stale" : undefined}>
            {route.section === "overview" ? (
              <OverviewSection
                sparks={liveSparks}
                deployments={deployments}
                recipes={cp.recipes}
                navigate={navigate}
                loaded={cp.loaded || sparks.length > 0}
              />
            ) : null}
            {route.section === "fleet" ? (
              <FleetSection sparks={liveSparks} deployments={deployments} recipes={cp.recipes} navigate={navigate} />
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
                navigate={navigate}
                onSaved={() => void cp.reload()}
              />
            ) : null}
            {route.section === "model" ? (
              <ModelDetail
                modelId={route.modelId}
                initialTab={route.tab}
                sparks={liveSparks}
                navigate={navigate}
                onDataChanged={() => void cp.reload()}
              />
            ) : null}
            {route.section === "activity" ? <ActivitySection events={cp.activity} /> : null}
            {route.section === "benchmarks" ? (
              <BenchmarksSection sparks={liveSparks} recipes={cp.recipes} navigate={navigate} />
            ) : null}
            {route.section === "settings" ? (
              <SettingsSection sparks={liveSparks} navigate={navigate} onSparksChanged={() => void refreshFromApi()} />
            ) : null}
          </main>
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