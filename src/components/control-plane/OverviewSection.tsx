import { useEffect, useMemo, useState } from "react";
import type { SparkSnapshot, DeploymentStatus, RecipePublic, ModelEntry, ActivityEvent } from "../../api/types";
import type { Route as AppRoute } from "../../hooks/router";
import { StatusDot, Chip, EmptyState, Skeleton } from "../ui/Status";
import { SectionBand } from "../ui/SectionBand";
import { ActivityIcon, BotIcon, CheckIcon, NetworkIcon, PanelIcon } from "../ui/icons";
import { relativeTs, absoluteTs } from "./activityModel";
import {
  computeFleetHealth,
  attentionDigest,
  allNodes,
  deploymentViews,
  deriveRuntimeState,
  friendlyName,
  relativeAge,
  runtimeLabel,
} from "./fleetModel";
import { deriveFabric } from "./fabricModel";
import { useRuntimeLabels, useRuntimeMetrics } from "./runtimeLabels";
import { FabricPanel } from "./FabricPanel";
import { DeploymentInstrument } from "./DeploymentInstrument";
import { NodeTelemetryStrip } from "./NodeTelemetryStrip";
import {
  fabricHealthSummary,
  isPrimary,
  labBriefing,
  labVerdict,
  primaryView,
  rankViews,
  roleOf,
  stateLabel,
  stateTone,
  verdictHeadline,
  verdictLabel,
} from "./cockpitModel";
import { useTelemetryHistory, type TelemetryHistory } from "./useTelemetryHistory";

interface OverviewProps {
  sparks: SparkSnapshot[];
  deployments: readonly DeploymentStatus[];
  recipes: readonly RecipePublic[];
  navigate: (route: AppRoute) => void;
  loaded: boolean;
  /** Optional model registry — friendly names; falls back to raw ids. */
  models?: ModelEntry[];
  /** Optional recent runtime activity for layer 3. */
  activity?: ActivityEvent[];
  /** Temp scale from settings; never implied. */
  temperatureUnit?: "celsius" | "fahrenheit";
  /** Obvious entry into the guided Add Compute wizard (Lab Fabric surface). */
  onAddCompute?: () => void;
}

function fmtContext(ctx: number | null): string | null {
  if (!ctx) return null;
  if (ctx >= 1000) return `${Math.round(ctx / 1000)}k`;
  return String(ctx);
}

const WINDOWS = [
  { key: 15 * 60_000, label: "Last 15m" },
  { key: 60 * 60_000, label: "Last 1h" },
  { key: 24 * 60 * 60_000, label: "Last 24h" },
] as const;

function WindowPicker({ value, onChange, ariaLabel }: { value: number; onChange: (v: number) => void; ariaLabel: string }) {
  return (
    <div className="cp-activity-windows" role="group" aria-label={ariaLabel}>
      {WINDOWS.map((w) => (
        <button
          key={w.key}
          type="button"
          className={`cp-activity-window${value === w.key ? " is-active" : ""}`}
          aria-pressed={value === w.key}
          onClick={() => onChange(w.key)}
        >
          {w.label}
        </button>
      ))}
    </div>
  );
}

export function OverviewSection({ sparks, deployments, recipes, navigate, loaded, models = [], activity = [], temperatureUnit = "celsius", onAddCompute }: OverviewProps) {
  const runtimeLabels = useRuntimeLabels();
  const runtimeMetrics = useRuntimeMetrics();
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [lastUpdated, setLastUpdated] = useState(() => Date.now());
  const [nodeWindow, setNodeWindow] = useState<number>(WINDOWS[0].key);
  const [activityWindow, setActivityWindow] = useState<number>(WINDOWS[0].key);

  const health = useMemo(() => computeFleetHealth(sparks, deployments), [sparks, deployments]);
  const attention = useMemo(() => attentionDigest(sparks, deployments, models), [sparks, deployments, models]);
  const views = useMemo(() => deploymentViews(sparks, deployments, recipes, models), [sparks, deployments, recipes, models]);
  const nodes = useMemo(() => allNodes(sparks), [sparks]);

  // Rolling per-deployment telemetry history — the gauge's real operating range.
  const history: TelemetryHistory = useTelemetryHistory(views);

  const states = useMemo(() => views.map((v) => deriveRuntimeState(v.deployment, v.telemetry)), [views]);

  const verdict = useMemo(
    () => labVerdict(health.nodesOnline, health.nodesTotal, attention.length, views, states),
    [health.nodesOnline, health.nodesTotal, attention.length, views, states]
  );
  const headline = useMemo(() => verdictHeadline(verdict, attention.length), [verdict, attention.length]);

  const fabric = useMemo(() => deriveFabric([...sparks], views), [sparks, views]);
  // Fabric health is PHYSICAL LINK health, never node memory pressure.
  const fabricHealth = useMemo(() => fabricHealthSummary(fabric.links), [fabric]);

  const critical = useMemo(() => attention.filter((a) => a.severity === "error").length, [attention]);
  const warning = useMemo(() => attention.filter((a) => a.severity === "warn").length, [attention]);

  // CONFIG-driven PRIMARY emphasis, then other active deployments.
  const pv = useMemo(() => primaryView(views), [views]);
  const pvState = pv ? states[views.indexOf(pv)] ?? deriveRuntimeState(pv.deployment, pv.telemetry) : null;
  const others = useMemo(
    () => (pv ? rankViews(views.filter((v) => v.deployment.display !== "stopped" && v.key !== pv.key)).slice(0, 3) : []),
    [views, pv]
  );
  const visibleInstruments = useMemo(() => (pv ? [pv, ...others] : []), [pv, others]);

  const brief = useMemo(
    () =>
      labBriefing({
        nodesOnline: health.nodesOnline,
        nodesTotal: health.nodesTotal,
        deploymentsActive: health.modelsRunning,
        primaryName: pv ? friendlyName(pv.rawModelId, models) : null,
        fabric: fabricHealth,
        critical,
        warning,
      }),
    [health.nodesOnline, health.nodesTotal, health.modelsRunning, pv, models, fabricHealth, critical, warning]
  );

  // Last-updated stamp + periodic relative refresh (no extra endpoint polling).
  useEffect(() => {
    setLastUpdated(Date.now());
  }, [sparks, deployments]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  /** Latest activity ts attributed to a node — the per-section window proxy. */
  const lastSeenAt = (id: string) =>
    activity.reduce((m, e) => (e.subject === id ? Math.max(m, Date.parse(e.ts)) : m), 0);

  const windowedNodes = useMemo(() => {
    const cutoff = now - nodeWindow;
    return nodes.filter((n) => n.online || lastSeenAt(n.id) === 0 || lastSeenAt(n.id) >= cutoff);
  }, [nodes, now, nodeWindow, activity]);

  const recent = useMemo(() => {
    const cutoff = now - activityWindow;
    return activity.filter((e) => Date.parse(e.ts) >= cutoff).slice(0, 5);
  }, [activity, now, activityWindow]);

  if (!loaded && sparks.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Skeleton height={70} />
        <Skeleton height={120} />
        <Skeleton height={240} />
      </div>
    );
  }

  const offline = health.nodesTotal - health.nodesOnline;

  // Spec §7/§8: getting-started checklist layer while the lab is fresh.
  const fresh = sparks.length === 0 && deployments.length === 0 && models.length === 0 && recipes.length === 0;
  const GET_STARTED = [
    { label: "Register a model", done: models.length > 0, past: "Model registered", route: { section: "models" } as AppRoute },
    { label: "Author a recipe", done: recipes.length > 0, past: "Recipe authored", route: { section: "models" } as AppRoute },
    { label: "Create a deployment", done: deployments.length > 0, past: "Deployment created", route: { section: "models" } as AppRoute },
    { label: "Connect a node", done: sparks.length > 0, past: "Node connected", route: { section: "fleet" } as AppRoute },
  ];
  const doneCount = GET_STARTED.filter((s) => s.done).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {fresh ? (
        <div className="cp-getstarted">
          <div className="cp-getstarted-overline">LET&apos;S GET STARTED</div>
          <div className="cp-getstarted-head">
            <h2 className="cp-getstarted-title">Bring your first model online</h2>
            <span className="cp-getstarted-count">{doneCount}/{GET_STARTED.length}</span>
          </div>
          <div className="cp-getstarted-cards">
            {GET_STARTED.map((s) => (
              <button
                key={s.label}
                type="button"
                className={`cp-getstarted-card${s.done ? " is-done" : ""}`}
                onClick={() => navigate(s.route)}
              >
                <span className="cp-getstarted-check" aria-hidden="true">
                  {s.done ? <CheckIcon size={14} /> : null}
                </span>
                <span className="cp-getstarted-card-title">{s.done ? s.past : s.label}</span>
                <span className="cp-getstarted-arrow" aria-hidden="true">↗</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* LEVEL 1 — glanceable lab identity header: identity, one word, one line */}
      <div className={`cp-verdict cp-labhead is-${verdict}`} role="status">
        <div className="cp-labhead-id">
          <span className="cp-verdict-overline">ASAD&apos;S AI LAB</span>
          <span className={`cp-verdict-pill tone-${verdict}`}>{verdictLabel(verdict)}</span>
        </div>
        <div className="cp-verdict-mid cp-labhead-mid">
          <div className="cp-verdict-text cp-labhead-text">{headline}</div>
          <div className="cp-verdict-summary cp-labhead-brief mono">{brief}</div>
          <div className="cp-verdict-meta">
            updated {relativeAge(lastUpdated, now)} · auto-refresh {autoRefresh ? "on" : "paused"}
          </div>
        </div>
        <div className="cp-labhead-counts">
          {critical > 0 ? <span className="cp-labhead-count is-critical mono">{critical} CRITICAL</span> : null}
          {warning > 0 ? <span className="cp-labhead-count is-warn mono">{warning} WARN</span> : null}
          {critical === 0 && warning === 0 ? <span className="cp-labhead-count is-ok mono">0 CRITICAL · 0 WARN</span> : null}
        </div>
        <div className="cp-verdict-right">
          <button
            type="button"
            className={`cp-btn ghost${autoRefresh ? " is-active" : ""}`}
            aria-pressed={autoRefresh}
            onClick={() => setAutoRefresh((v) => !v)}
          >
            {autoRefresh ? "Auto-refresh on" : "Auto-refresh off"}
          </button>
        </div>
      </div>

      {/* Attention exceptions strip — deduped by condition+resource */}
      {attention.length > 0 ? (
        <div className="cp-section-block">
          <SectionBand icon={<PanelIcon />} title="Attention" count={attention.length} />
          <div className="cp-alerts">
            {attention.slice(0, 6).map((a) => (
              <div key={a.id} className={`cp-alert ${a.severity === "error" ? "is-error" : a.severity === "info" ? "is-info" : ""}`}>
                <span className={`cp-dot ${a.severity === "error" ? "error" : a.severity === "warn" ? "warn" : "info"}`} />
                <span className="cp-alert-msg">{a.message}</span>
                {a.count > 1 ? <Chip>×{a.count}</Chip> : null}
                {a.target ? (
                  <button type="button" className="cp-alert-link" onClick={() => navigate(a.target as AppRoute)}>
                    View →
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="cp-strip">
          <StatusDot status="running" />
          <span className="cp-strip-text">No active alerts — lab is healthy.</span>
          {offline > 0 ? <span className="cp-strip-text mono">{offline} node{offline === 1 ? "" : "s"} offline</span> : null}
        </div>
      )}

      {/* LEVEL 2 — instrument cluster: PRIMARY first with greater weight, then
          other actives, then the physical lab fabric panel. */}
      <div className="cp-section-block">
        <SectionBand
          icon={<BotIcon />}
          title="Instrument cluster"
          count={visibleInstruments.length}
          actions={
            <button type="button" className="cp-alert-link" onClick={() => navigate({ section: "models" })}>
              Models →
            </button>
          }
        />
        {visibleInstruments.length === 0 ? (
          <div className="cp-table-empty">No deployments registered — cluster idle.</div>
        ) : (
          <div className="cp-cluster">
            <div className="cp-cluster-instruments">
              {visibleInstruments.map((v) => {
                const role = roleOf(v, views);
                return (
                  <DeploymentInstrument
                    key={v.key}
                    view={v}
                    role={role}
                    state={states[views.indexOf(v)] ?? deriveRuntimeState(v.deployment, v.telemetry)}
                    history={history[v.key]?.samples ?? []}
                    lastRequestAt={history[v.key]?.lastRequestAt ?? null}
                    now={now}
                    runtimeLabels={runtimeLabels}
                    runtimeMetrics={runtimeMetrics}
                    temperatureUnit={temperatureUnit}
                    onOpen={() => navigate({ section: "model", modelId: v.deployment.modelId })}
                  />
                );
              })}
            </div>
            <FabricPanel sparks={sparks} views={views} navigate={(nodeId) => navigate({ section: "node", nodeId })} onAddCompute={onAddCompute} />
          </div>
        )}
      </div>

      {/* NODE TELEMETRY — compact, scalable strip; keeps per-machine telemetry
          accessible without recreating three giant cards. */}
      <div className="cp-section-block">
        <SectionBand
          icon={<NetworkIcon />}
          title="Node telemetry"
          count={windowedNodes.length}
          local={<WindowPicker value={nodeWindow} onChange={setNodeWindow} ariaLabel="Node window" />}
          actions={
            <button type="button" className="cp-alert-link" onClick={() => navigate({ section: "fleet" })}>
              Fleet →
            </button>
          }
        />
        <NodeTelemetryStrip
          sparks={windowedNodes}
          deployments={deployments}
          models={models}
          temperatureUnit={temperatureUnit}
          onOpenNode={(nodeId) => navigate({ section: "node", nodeId })}
        />
      </div>

      {/* Compact deployments index — link into detail */}
      <div className="cp-section-block">
        <SectionBand
          icon={<BotIcon />}
          title="Deployments"
          count={views.length}
          actions={
            <button type="button" className="cp-alert-link" onClick={() => navigate({ section: "models" })}>
              Models →
            </button>
          }
        />
        {views.length === 0 ? (
          <div className="cp-table-empty">No deployments registered.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {views.map((v) => {
              const ctx = fmtContext(v.contextLength);
              const multi = v.nodes.length > 1;
              const state = states[views.indexOf(v)];
              const role = roleOf(v, views);
              return (
                <div
                  key={v.key}
                  className={`cp-deploy-row${state === "offline" ? " is-offline" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate({ section: "model", modelId: v.deployment.modelId })}
                  onKeyDown={(e) => e.key === "Enter" && navigate({ section: "model", modelId: v.deployment.modelId })}
                >
                  <span className={`cp-deploy-role mono${isPrimary(role) ? " is-primary" : ""}`}>{role}</span>
                  <span className={`cp-inst-state tone-${stateTone(state)}`}>
                    <span className="cp-inst-state-dot" aria-hidden="true" />
                    {stateLabel(state)}
                  </span>

                  <div className="cp-deploy-model">
                    <span className="cp-deploy-name" title={v.modelName}>{v.modelName}</span>
                    <span className="cp-deploy-id" title={v.rawModelId}>{v.rawModelId}</span>
                    {v.deployment.lastError ? <span className="cp-deploy-err">{v.deployment.lastError}</span> : null}
                  </div>

                  <div className="cp-deploy-meta">
                    <Chip>{runtimeLabel(v.runtime, runtimeLabels)}</Chip>
                    {v.topology !== "single" ? <Chip>{v.topology.toUpperCase()}</Chip> : <Chip>single</Chip>}
                    {ctx ? <Chip tone="mono">{ctx} ctx</Chip> : null}
                    {v.deployment.managedBy === "external" ? <Chip>external</Chip> : null}
                  </div>

                  <div className="cp-deploy-nodes">
                    {multi ? (
                      <div className="cp-node-cluster">
                        <span className="cp-node-cluster-label">{v.topology.toUpperCase()} · {v.nodes.length} nodes</span>
                        <span className="cp-node-cluster-chips">
                          {v.nodes.map((n) => (
                            <span key={n.id} className="cp-node-chip">
                              <StatusDot status={n.online ? "online" : "offline"} />
                              {n.name}
                              {n.role === "worker" ? <span className="cp-node-chip-role">worker</span> : null}
                            </span>
                          ))}
                        </span>
                      </div>
                    ) : (
                      <span className="cp-node-chip">
                        <StatusDot status={v.nodes[0]?.online ? "online" : "offline"} />
                        {v.nodes[0]?.name ?? v.deployment.nodeIds[0] ?? "—"}
                      </span>
                    )}
                  </div>

                  <div className="cp-deploy-right">
                    <span className={`cp-deploy-tps${v.decodeTps == null ? " is-idle" : ""}`}>
                      {v.decodeTps == null ? "—" : v.decodeTps}
                      {v.decodeTps != null ? <span className="cp-unit"> tok/s</span> : null}
                    </span>
                    <span className="cp-deploy-port mono">{v.port}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Layer 3 — runtime activity */}
      <div className="cp-section-block">
        <SectionBand
          icon={<ActivityIcon />}
          title="Runtime activity"
          count={recent.length}
          local={<WindowPicker value={activityWindow} onChange={setActivityWindow} ariaLabel="Activity window" />}
          actions={
            <button type="button" className="cp-alert-link" onClick={() => navigate({ section: "activity" })}>
              Activity →
            </button>
          }
        />
        {recent.length === 0 ? (
          <EmptyState title="No runtime activity in this window." />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {recent.map((e) => (
              <div key={e.seq} className="cp-activity-row">
                <Chip>{e.kind}</Chip>
                <span className="cp-activity-msg">{e.summary}</span>
                <span className="cp-activity-ts mono" title={absoluteTs(e.ts)}>
                  {relativeTs(e.ts)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
