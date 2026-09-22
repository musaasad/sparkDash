import { useMemo } from "react";
import type { ModelEntry, SparkSnapshot, DeploymentStatus } from "../../api/types";
import { Chip } from "../ui/Status";
import { nodeTelemetryRow } from "./cockpitModel";
import { deploymentsForNode, friendlyName } from "./fleetModel";

export interface NodeTelemetryStripProps {
  sparks: readonly SparkSnapshot[];
  deployments: readonly DeploymentStatus[];
  models?: readonly ModelEntry[];
  temperatureUnit?: "celsius" | "fahrenheit";
  onOpenNode?: (nodeId: string) => void;
}

/**
 * Compact per-node telemetry strip. Stays a slim row per node at any N — no
 * giant cards. Reuses fleet node data, never a per-gauge endpoint poll.
 *
 * Honesty: a missing metric renders `—` (NOT 0); an offline node keeps its last
 * measured values but is unmistakably OFFLINE; deploy membership is named.
 */
export function NodeTelemetryStrip({
  sparks,
  deployments,
  models = [],
  temperatureUnit = "celsius",
  onOpenNode,
}: NodeTelemetryStripProps) {
  const rows = useMemo(
    () =>
      sparks.map((s) =>
        nodeTelemetryRow(
          s,
          deploymentsForNode(deployments, s.id).map((d) => friendlyName(d.modelId, models)),
          temperatureUnit
        )
      ),
    [sparks, deployments, models, temperatureUnit]
  );

  if (rows.length === 0) {
    return <div className="cp-table-empty">No compute nodes registered.</div>;
  }

  return (
    <div className="cp-nodestrip" role="table" aria-label="Node telemetry">
      <div className="cp-nodestrip-head" role="row">
        <span className="cp-nodestrip-h cell-node">NODE</span>
        <span className="cp-nodestrip-h cell-state">STATE</span>
        <span className="cp-nodestrip-h cell-metrics">TELEMETRY</span>
        <span className="cp-nodestrip-h cell-deploys">DEPLOYMENTS</span>
      </div>
      {rows.map((r) => (
        <div
          key={r.id}
          className={`cp-nodestrip-row tone-${r.tone}${r.online ? "" : " is-offline"}`}
          role="row"
          tabIndex={onOpenNode ? 0 : undefined}
          onClick={onOpenNode ? () => onOpenNode(r.id) : undefined}
          onKeyDown={onOpenNode ? (e) => e.key === "Enter" && onOpenNode(r.id) : undefined}
        >
          <span className="cp-nodestrip-node cell-node">
            <span className="cp-nodestrip-dot" aria-hidden="true" />
            <span className="cp-nodestrip-name" title={r.name}>
              {r.name}
            </span>
            {r.roleNote ? <Chip>{r.roleNote}</Chip> : null}
          </span>

          <span className="cp-nodestrip-state cell-state mono">{r.online ? "ONLINE" : "OFFLINE"}</span>

          <span className="cp-nodestrip-metrics cell-metrics">
            {r.metrics.length === 0 ? (
              <span className="cp-nodata">no telemetry reported</span>
            ) : (
              r.metrics.map((m) => (
                <span key={m.key} className="cp-nodestrip-cell" title={m.title}>
                  <span className="cp-nodestrip-cell-label mono">{m.label}</span>
                  <span className="cp-nodestrip-cell-value mono">
                    {m.value}
                    {m.unit ? <span className="cp-nodestrip-cell-unit"> {m.unit}</span> : null}
                  </span>
                </span>
              ))
            )}
          </span>

          <span className="cp-nodestrip-deploys cell-deploys">
            {r.deployments.length === 0 ? (
              <span className="cp-nodata">—</span>
            ) : (
              r.deployments.map((d, i) => (
                <span key={`${d}-${i}`} className="cp-nodestrip-chip" title={d}>
                  {d}
                </span>
              ))
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
