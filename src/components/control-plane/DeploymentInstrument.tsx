import type { KeyboardEvent, MouseEvent } from "react";
import type { DeploymentView, RuntimeState } from "./fleetModel";
import { ThroughputGauge } from "./ThroughputGauge";
import { TopologySummary } from "./TopologySummary";
import {
  aggregationLegend,
  declaredMetrics,
  hottestThermal,
  isPrimary,
  lastRequestAgo,
  nodeInstruments,
  primaryMemberNode,
  runtimeName,
  secondaryInstruments,
  stateLabel,
  stateTone,
  thermalLabel,
  thermalTone,
  type InstrumentRole,
  type SecondaryInstrument,
} from "./cockpitModel";
import { fmtUptime } from "./fleetModel";
import { TELEMETRY_STALE_MS } from "../../shared/runtimeState.js";
import type { RuntimeLabelMap } from "./runtimeLabels";

export interface DeploymentInstrumentProps {
  view: DeploymentView;
  role: InstrumentRole;
  state: RuntimeState;
  history: readonly number[];
  lastRequestAt: number | null;
  /** Age of the oldest reporting member's llm sample (ms); stale ⇒ STALE marker. */
  telemetryAgeMs?: number | null;
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
 * One instrument per deployment — the PRIMARY place a model is shown, and a
 * PURE READOUT: lifecycle actions live once in the Deployments list, never here.
 * PRIMARY gets greater weight (larger gauge/typography) — geometry, not glow.
 * Role, state and performance are three SEPARATE channels.
 *
 * The card is an EQUAL-width grid cell that fills itself: gauge beside a dense
 * readout grid, then the secondary micro-instruments as a full-width row — so a
 * single-node card has no hollow middle and no sparse vertical stack.
 *
 * MULTI-NODE: telemetry is aggregated with an explicit MAX/SUM legend and any
 * member without a readable probe is NAMED (never treated as 0). Thermal is the
 * HOTTEST GPU/CPU across member nodes, labelled with that node.
 */
export function DeploymentInstrument({
  view,
  role,
  state,
  history,
  lastRequestAt,
  telemetryAgeMs = null,
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
  // A stale sample is never presented as current — visible marker, calm state.
  // TabbyAPI log-derived perf is last-REQUEST history: it goes stale when the
  // log shows nothing recent (`perfStale`), even though the HTTP probe is fresh.
  const staleAge =
    telemetryAgeMs ?? (view.telemetry?.lastRequestAtMs != null ? Math.max(0, now - view.telemetry.lastRequestAtMs) : null);
  const stale = (staleAge != null && staleAge > TELEMETRY_STALE_MS) || view.telemetry?.perfStale === true;
  // Log-derived numbers are labelled with their provenance so nobody reads them
  // as a live instantaneous gauge.
  const provenance = view.telemetry?.provenance ?? null;
  // Log-derived backends (TabbyAPI) expose no live endpoint: the perf tiles/gauge
  // are RECENT-WINDOW aggregates over real log lines, labelled as such. They are
  // dimmed/'—' when the window is empty or the last completion is old — even
  // while a NEW request is in flight (BUSY), since metrics log only at completion.
  const winCount = view.telemetry?.recentWindowCount ?? null;
  const lastId = view.telemetry?.lastRequestId ?? null;
  const logPerfDim = provenance != null && (view.telemetry?.perfMetricsStale === true || view.telemetry?.recentWindowCount === 0);
  const perfTilesStale = logPerfDim;
  // Live tracking: while the model is actively serving (a request in flight, or
  // one completed seconds ago) the gauge shows the LATEST request's throughput so
  // it MOVES as the model works. TabbyAPI logs a rate at each completion — that
  // latest rate is the closest thing to a live reading it offers. When idle it
  // calms to the recent-window median (labelled RECENT MED), never a frozen
  // single value presented as current.
  const servingNow =
    view.telemetry?.requestActive === true ||
    (view.telemetry?.lastRequestAtMs != null && now - view.telemetry.lastRequestAtMs < 8000);
  const gaugeValue = provenance
    ? logPerfDim
      ? null
      : servingNow
        ? view.telemetry?.generationTps ?? view.telemetry?.recentMedGenTps ?? null
        : view.telemetry?.recentMedGenTps ?? null
    : view.telemetry?.generationTps ?? null;
  // Honest labelling (never call a last-completed rate "LIVE"):
  //  • TabbyAPI log — decode tok/s is emitted only AT completion. While a request
  //    is in flight the freshest number is the LAST COMPLETED request → "LAST
  //    REQUEST"; when idle it calms to the window median → "RECENT MED".
  //  • vLLM native — /metrics is already an instantaneous live reading conveyed
  //    by the moving value + BUSY state; no extra caption (minimal markers).
  const gaugeNote = provenance ? (servingNow ? "LAST REQUEST" : "RECENT MED") : null;
  // LIVE activity from the continuous follower — genuinely live (lights up on the
  // request START line, closed on completion/cancel), unlike the completion-only
  // throughput. Elapsed is wall-clock since the oldest in-flight request started.
  const generating = view.telemetry?.requestActive === true;
  const activeRequests = view.telemetry?.activeRequests ?? null;
  const activeElapsed = view.telemetry?.requestElapsedSeconds ?? null;

  const thermal = hottestThermal(view.nodes, temperatureUnit);
  const agg = view.telemetry?.aggregation ?? aggregationLegend(view.telemetry?.membersReporting ?? 0, view.nodes.length);
  const missing = view.telemetry?.membersMissingTelemetry ?? [];
  // TP worker ranks online but API-served by the head — expected, shown calmly,
  // never lumped into the "no endpoint" fault wording.
  const headServed = view.telemetry?.membersHeadServedApi ?? [];
  // TP topology gates the rank-row "api·head" marker: only a TP worker legitimately
  // lacks its own endpoint. A dp/pp/replica member may serve its own API, so the
  // marker must not be inferred from node count alone.
  const isTp = typeof view.topology === "string" && /^tp\d?/i.test(view.topology);

  // Latency/queue micro-gauges first, then the hottest node's physical read-outs
  // — subordinate to the dominant throughput number, never competing with it.
  const secondary: SecondaryInstrument[] = [
    ...secondaryInstruments(declaredMetrics(view.runtime, runtimeMetrics), view.telemetry, 5).map((s) => ({
      ...s,
      stale: perfTilesStale,
    })),
    ...nodeInstruments(node, temperatureUnit, 6),
  ].slice(0, 8);

  const rowActivate = (e: MouseEvent | KeyboardEvent) => {
    if (e.type === "keydown") {
      const k = (e as KeyboardEvent).key;
      if (k !== "Enter" && k !== " ") return;
    }
    onOpen();
  };

  return (
    <div
      className={`cp-inst tone-${tone}${primary ? " is-primary" : " is-secondary"}${state === "offline" ? " is-offline" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onOpen()}
      onKeyDown={rowActivate}
    >
      <div className="cp-inst-head">
        <div className="cp-inst-id">
          <span className="cp-inst-role mono">{role}</span>
          <h3 className="cp-inst-name" title={view.modelName}>
            {view.modelName}
          </h3>
          <span className="cp-inst-runtime">{runtime}</span>
          {view.diverged ? (
            <span
              className="cp-inst-live mono"
              title={`Serving model discovered live (${view.modelName}); this deployment's recipe is bound to ${view.configuredModelId}.`}
            >
              · live
            </span>
          ) : null}
        </div>
        <span className={`cp-inst-state tone-${tone}`}>
          <span className="cp-inst-state-dot" aria-hidden="true" />
          {stateLabel(state)}
          {stale ? <span className="cp-inst-stale mono" title={staleAge != null ? `sample ${Math.round(staleAge / 1000)}s old` : "stale"}> · STALE</span> : null}
        </span>
      </div>

      {/* Aggregation is explicit and labelled — never a silent blend. */}
      {agg ? (
        <div className="cp-inst-agg mono">
          AGGREGATE · {agg}
          {missing.length > 0 ? <span className="cp-inst-agg-missing"> · no endpoint: {missing.join(", ")}</span> : null}
          {headServed.length > 0 ? (
            <span className="cp-inst-agg-worker" title="TP worker rank — the head serves the OpenAI API for the whole group; this rank still reports its own physical telemetry, so this is expected, not a fault">
              {" "}· API via head: {headServed.join(", ")}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Balanced inner grid: gauge beside a dense readout grid, then the
          micro-instruments span the FULL card width — no dead middle region. */}
      <div className="cp-inst-body">
        <ThroughputGauge
          value={gaugeValue}
          history={history}
          state={state}
          valueNote={gaugeNote}
          size={primary ? 176 : 148}
          unavailable={!telemetryReadable}
          note={needsKey ? "metrics require key" : telemetryReadable ? null : "throughput unknown"}
          ariaLabel={`${view.modelName} throughput, ${stateLabel(state)}`}
        />

        <div className="cp-inst-side">
          {/* Placement expressed ONCE by TopologySummary; node names not repeated. */}
          <div className="cp-inst-meta is-wide">
            <span className="cp-inst-meta-label mono">PLACEMENT</span>
            <TopologySummary view={view} />
          </div>

          {/* Thermal: HOTTEST across member nodes, labelled. NORMAL by default. */}
          <div className="cp-inst-meta">
            <span className="cp-inst-meta-label mono">HOTTEST {thermal.memberCount > 1 ? `(MAX ${thermal.reporting}/${thermal.memberCount})` : ""}</span>
            <span className={`cp-inst-thermal mono tone-${thermalTone(thermal.level)}`}>
              {thermalLabel(thermal.level)}
              {thermal.value ? ` ${thermal.value}${thermal.unit}` : " —"}
              {thermal.nodeName ? <span className="cp-inst-thermal-node"> · {thermal.nodeName}</span> : null}
            </span>
          </div>

          <div className="cp-inst-meta">
            <span className="cp-inst-meta-label mono">CONTEXT</span>
            <span className="cp-inst-meta-value mono">{ctx ?? <span className="cp-nodata">—</span>}</span>
          </div>
          {view.uptime != null ? (
            <div className="cp-inst-meta">
              <span className="cp-inst-meta-label mono">UPTIME</span>
              <span className="cp-inst-meta-value mono">{fmtUptime(view.uptime)}</span>
            </div>
          ) : null}

          {/* idle stays calm: state + recency, never an alarming 0.
              Unreadable telemetry never claims "no traffic yet". */}
          {/* ALWAYS visible while provenance exists — even when BUSY — so the
              recent-window framing + last-request recency can never be lost. */}
          {provenance ? (
            <span
              className={`cp-inst-recency cp-inst-recent is-wide${generating ? " is-live" : ""}`}
              title={
                generating
                  ? "LIVE activity from TabbyAPI's log stream (request in flight). Throughput still reflects the LAST COMPLETED request — TabbyAPI emits decode tok/s only at completion."
                  : "RECENT-WINDOW aggregate from TabbyAPI's own log — real log values, never a live instantaneous reading"
              }
            >
              {generating ? (
                <>
                  GENERATING · {activeRequests ?? "—"} active
                  {activeElapsed != null ? ` · ${activeElapsed}s` : ""} · {provenance}
                </>
              ) : (
                <>
                  RECENT · last {winCount ?? "—"} requests · {provenance}
                  {lastId != null && recency ? ` · last #${lastId} ${recency}` : ""}
                </>
              )}
            </span>
          ) : null}
          {loaded && recency && !provenance ? (
            <span className="cp-inst-recency is-wide">last request {recency}</span>
          ) : null}
          {loaded && !recency && !telemetryReadable ? (
            <span className="cp-inst-recency is-wide">{needsKey ? "metrics require key" : "throughput unknown"}</span>
          ) : null}
          {loaded && !recency && telemetryReadable ? <span className="cp-inst-recency is-wide">no active traffic</span> : null}
          {state === "serving" || state === "busy" ? (
            <span className="cp-inst-live mono is-wide">
              {view.telemetry?.requestsRunning ?? "—"} RUNNING
              {view.telemetry?.requestsWaiting ? ` · ${view.telemetry.requestsWaiting} QUEUED` : ""}
            </span>
          ) : null}
        </div>

        {/* Compact aircraft-style micro-gauges: thin bars for ratios, mono for the
            rest. A declared-but-absent metric renders '—', never 0. */}
        {secondary.length > 0 ? (
          <div className="cp-inst-secondary">
            {secondary.map((s) => (
              <div key={s.key} className={`cp-inst-cell${s.stale ? " is-stale" : ""}`}>
                <span className="cp-inst-cell-label mono">
                  {s.label}
                  {s.stale ? <span className="cp-inst-cell-stale-dot" aria-hidden="true" title="recent window empty or old — not current"> ·</span> : null}
                </span>
                <span className="cp-inst-cell-value mono" title={s.stale ? `${s.title ?? s.label} · recent window empty or old (not current)` : s.title}>
                  {s.value}
                  {s.unit ? <span className="cp-inst-cell-unit"> {s.unit}</span> : null}
                </span>
                {s.fraction != null ? (
                  <span className="cp-inst-bar" aria-hidden="true">
                    <span className="cp-inst-bar-fill" style={{ width: `${Math.round(s.fraction * 100)}%` }} />
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* TP / multi-node: report each participating rank INDEPENDENTLY underneath
          the logical deployment — head vs worker, each with its own physical
          telemetry. A worker showing api·head is expected, not a fault. */}
      {view.nodes.length > 1 ? (
        <div className="cp-inst-ranks mono">
          <span className="cp-inst-ranks-label">RANKS · {view.nodes.length}</span>
          {view.nodes.map((n) => {
            const isHead = node != null && n.id === node.id;
            const g = n.metrics?.gpu;
            const um = n.metrics?.unifiedMemory;
            // A failed collection leaves DEFAULTS (0) — gate on the domain's
            // collect-success flag and render '—', never a fabricated 0°C / 0% (F6).
            const gpuOk = g != null && n.metricsCollectSuccess?.gpu !== false;
            const memPct = um && Number.isFinite(um.percentage) ? Math.round(um.percentage) : null;
            return (
              <span key={n.id} className={`cp-inst-rank${n.online ? "" : " is-offline"}`}>
                <span className="cp-inst-rank-dot" aria-hidden="true" />
                <span className="cp-inst-rank-name">{n.name || n.id}</span>
                <span className="cp-inst-rank-role">{isHead ? "head" : "worker"}</span>
                <span className="cp-inst-rank-metric">{gpuOk && g?.temperature != null ? `${g.temperature}°C` : "—"}</span>
                <span className="cp-inst-rank-metric">{gpuOk && g?.usage != null ? `util ${g.usage}%` : "util —"}</span>
                <span className="cp-inst-rank-metric">{memPct != null ? `mem ${memPct}%` : "mem —"}</span>
                {!isHead && isTp ? <span className="cp-inst-rank-api" title="TP worker — the head serves the OpenAI API for the whole group (expected)">api·head</span> : null}
                {!n.online ? <span className="cp-inst-rank-off">OFFLINE</span> : null}
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
