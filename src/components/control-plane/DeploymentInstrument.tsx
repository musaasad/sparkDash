import type { DeploymentView, RuntimeState } from "./fleetModel";
import { ThroughputGauge } from "./ThroughputGauge";
import { TopologySummary } from "./TopologySummary";
import {
  declaredMetrics,
  lastRequestAgo,
  runtimeName,
  secondaryInstruments,
  stateLabel,
  stateTone,
  type InstrumentRole,
} from "./cockpitModel";
import { fmtUptime } from "./fleetModel";
import type { RuntimeLabelMap } from "./runtimeLabels";

export interface DeploymentInstrumentProps {
  view: DeploymentView;
  role: InstrumentRole;
  state: RuntimeState;
  history: readonly number[];
  lastRequestAt: number | null;
  now: number;
  runtimeLabels: RuntimeLabelMap;
  runtimeMetrics: Record<string, string[]>;
  onOpen: () => void;
}

function fmtContext(ctx: number | null): string | null {
  if (!ctx) return null;
  return ctx >= 1000 ? `${Math.round(ctx / 1000)}K` : String(ctx);
}

/**
 * One LARGE primary instrument per active deployment. Level 2 only — endpoint,
 * recipe, quant and fabric links stay behind the click-through.
 */
export function DeploymentInstrument({
  view,
  role,
  state,
  history,
  lastRequestAt,
  now,
  runtimeLabels,
  runtimeMetrics,
  onOpen,
}: DeploymentInstrumentProps) {
  const tone = stateTone(state);
  const runtime = runtimeName(view.runtime, runtimeLabels);
  const ctx = fmtContext(view.contextLength);
  const secondary = secondaryInstruments(declaredMetrics(view.runtime, runtimeMetrics), view.telemetry);
  const recency = lastRequestAgo(lastRequestAt, now);
  const loaded = state === "ready" || state === "idle";
  // Auth-gated external runtimes have NO readable metrics — say so honestly.
  const telemetryReadable = view.telemetry != null && view.telemetry.available;
  const needsKey = !telemetryReadable && !!view.telemetry?.error && /auth|401|403/i.test(view.telemetry.error);

  return (
    <div
      className={`cp-inst tone-${tone}${role === "WORKER" ? " is-worker" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
    >
      <div className="cp-inst-head">
        <div className="cp-inst-id">
          <span className="cp-inst-role mono">{role}</span>
          <h3 className="cp-inst-name">{view.modelName}</h3>
          <span className="cp-inst-runtime">{runtime}</span>
        </div>
        <span className={`cp-inst-state tone-${tone}`}>
          <span className="cp-inst-state-dot" aria-hidden="true" />
          {stateLabel(state)}
        </span>
      </div>

      <div className="cp-inst-body">
        <ThroughputGauge
          value={view.telemetry?.generationTps ?? null}
          history={history}
          state={state}
          size={188}
          ariaLabel={`${view.modelName} throughput, ${stateLabel(state)}`}
        />
        <div className="cp-inst-side">
          {/* L2 meta only — no Level-3 dump. Placement is expressed ONCE by
              TopologySummary; node names are not repeated below it. */}
          <div className="cp-inst-meta">
            <span className="cp-inst-meta-label mono">PLACEMENT</span>
            <TopologySummary view={view} />
          </div>
          {ctx ? (
            <div className="cp-inst-meta">
              <span className="cp-inst-meta-label mono">CONTEXT</span>
              <span className="cp-inst-meta-value mono">{ctx}</span>
            </div>
          ) : null}
          {view.uptime != null ? (
            <div className="cp-inst-meta">
              <span className="cp-inst-meta-label mono">UPTIME</span>
              <span className="cp-inst-meta-value mono">{fmtUptime(view.uptime)}</span>
            </div>
          ) : null}
          {/* idle must stay calm: show state + recency, never an alarming 0.
              Unreadable telemetry never claims "no traffic yet". */}
          {loaded && recency ? <span className="cp-inst-recency">last request {recency}</span> : null}
          {loaded && !recency && !telemetryReadable ? (
            <span className="cp-inst-recency">{needsKey ? "metrics require key" : "throughput unknown"}</span>
          ) : null}
          {loaded && !recency && telemetryReadable ? <span className="cp-inst-recency">no traffic yet</span> : null}
          {state === "serving" || state === "busy" ? (
            <span className="cp-inst-live mono">
              {view.telemetry?.requestsRunning ?? 0} RUNNING
              {view.telemetry?.requestsWaiting ? ` · ${view.telemetry.requestsWaiting} QUEUED` : ""}
            </span>
          ) : null}
        </div>
      </div>

      {secondary.length > 0 ? (
        <div className="cp-inst-secondary">
          {secondary.map((s) => (
            <div key={s.key} className="cp-inst-cell">
              <span className="cp-inst-cell-label mono">{s.label}</span>
              <span className="cp-inst-cell-value mono">
                {s.value}
                {s.unit ? <span className="cp-inst-cell-unit"> {s.unit}</span> : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
