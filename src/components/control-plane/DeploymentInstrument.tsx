import type { DeploymentView, RuntimeState } from "./fleetModel";
import { ThroughputGauge } from "./ThroughputGauge";
import { TopologySummary } from "./TopologySummary";
import {
  declaredMetrics,
  isPrimary,
  lastRequestAgo,
  nodeInstruments,
  primaryMemberNode,
  runtimeName,
  secondaryInstruments,
  stateLabel,
  stateTone,
  type InstrumentRole,
  type SecondaryInstrument,
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
  /** Config temperature scale for node-derived cells; never implied. */
  temperatureUnit?: "celsius" | "fahrenheit";
  onOpen: () => void;
}

function fmtContext(ctx: number | null): string | null {
  if (!ctx) return null;
  return ctx >= 1000 ? `${Math.round(ctx / 1000)}K` : String(ctx);
}

/**
 * One instrument per active deployment. PRIMARY gets greater weight (larger
 * gauge/typography) — geometry, not glow. Role, state and performance are three
 * SEPARATE channels: role label, state pill, and the tok/s gauge.
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
  temperatureUnit = "celsius",
  onOpen,
}: DeploymentInstrumentProps) {
  const tone = stateTone(state);
  const primary = isPrimary(role);
  const runtime = runtimeName(view.runtime, runtimeLabels);
  const ctx = fmtContext(view.contextLength);
  const node = primaryMemberNode(view);
  const recency = lastRequestAgo(lastRequestAt, now);
  const loaded = state === "ready" || state === "idle";
  // Auth-gated external runtimes have NO readable metrics — say so honestly.
  const telemetryReadable = view.telemetry != null && view.telemetry.available;
  const needsKey = !telemetryReadable && !!view.telemetry?.error && /auth|401|403/i.test(view.telemetry.error);

  // Latency/queue instruments first, then node temperature/memory/power — the
  // subordinate physical read backs the throughput without competing with it.
  const secondary: SecondaryInstrument[] = [
    ...secondaryInstruments(declaredMetrics(view.runtime, runtimeMetrics), view.telemetry, 5),
    ...nodeInstruments(node, temperatureUnit, 6),
  ].slice(0, 8);

  return (
    <div
      className={`cp-inst tone-${tone}${primary ? " is-primary" : " is-secondary"}${state === "offline" ? " is-offline" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
    >
      <div className="cp-inst-head">
        <div className="cp-inst-id">
          <span className="cp-inst-role mono">{role}</span>
          <h3 className="cp-inst-name" title={view.modelName}>
            {view.modelName}
          </h3>
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
          size={primary ? 208 : 168}
          ariaLabel={`${view.modelName} throughput, ${stateLabel(state)}`}
        />
        <div className="cp-inst-side">
          {/* Placement expressed ONCE by TopologySummary; node names not repeated. */}
          <div className="cp-inst-meta">
            <span className="cp-inst-meta-label mono">PLACEMENT</span>
            <TopologySummary view={view} />
          </div>
          {ctx ? (
            <div className="cp-inst-meta">
              <span className="cp-inst-meta-label mono">CONTEXT</span>
              <span className="cp-inst-meta-value mono">{ctx}</span>
            </div>
          ) : (
            <div className="cp-inst-meta">
              <span className="cp-inst-meta-label mono">CONTEXT</span>
              <span className="cp-inst-meta-value mono cp-nodata">—</span>
            </div>
          )}
          {view.uptime != null ? (
            <div className="cp-inst-meta">
              <span className="cp-inst-meta-label mono">UPTIME</span>
              <span className="cp-inst-meta-value mono">{fmtUptime(view.uptime)}</span>
            </div>
          ) : null}
          {/* idle stays calm: state + recency, never an alarming 0.
              Unreadable telemetry never claims "no traffic yet". */}
          {loaded && recency ? <span className="cp-inst-recency">last request {recency}</span> : null}
          {loaded && !recency && !telemetryReadable ? (
            <span className="cp-inst-recency">{needsKey ? "metrics require key" : "throughput unknown"}</span>
          ) : null}
          {loaded && !recency && telemetryReadable ? <span className="cp-inst-recency">no active traffic</span> : null}
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
              <span className="cp-inst-cell-value mono" title={s.title}>
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
