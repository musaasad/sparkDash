import { useState } from "react";
import type { DeploymentStatus, RecipePublic } from "../../api/types";
import { deploymentAction } from "../../api/client";
import { StatusPill } from "../ui/Status";
import { Modal } from "../ui/Modal";

interface DeployControlsProps {
  recipe: RecipePublic;
  deployment?: DeploymentStatus;
  onUpdated?: () => void;
}

/**
 * Lifecycle controls. This phase is DRY-RUN: managed recipes simulate; the
 * externally-managed deployment renders controls DISABLED with an explicit reason —
 * showing live controls on a never-touch process is a trust violation.
 */
export function DeployControls({ recipe, deployment, onUpdated }: DeployControlsProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"stop" | "restart" | null>(null);

  const targetId = deployment?.deploymentId ?? recipe.id;
  const external = deployment?.managedBy === "external";
  const state = deployment?.state ?? "available";
  const reason = external
    ? "Externally managed · SparkDash observes this process but does not control it (dry-run phase)"
    : "Dry-run: lifecycle mutations are simulated until real testing is approved";

  async function run(action: "start" | "stop" | "restart") {
    setBusy(action);
    setError(null);
    try {
      await deploymentAction(targetId, action);
      onUpdated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  const canStart = state === "stopped" || state === "available";
  const canStop = state === "running" || state === "loading" || state === "starting";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <StatusPill status={state as never} />
        <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
          <button
            type="button"
            className="cp-btn primary"
            disabled={external || busy != null || !canStart}
            onClick={() => run("start")}
            title={external ? reason : "Start (dry-run)"}
          >
            {busy === "start" ? "Starting…" : "Start"}
          </button>
          <button
            type="button"
            className="cp-btn"
            disabled={external || busy != null || !canStop}
            onClick={() => setConfirm("stop")}
            title={external ? reason : "Stop (dry-run)"}
          >
            Stop
          </button>
          <button
            type="button"
            className="cp-btn"
            disabled={external || busy != null || state !== "running"}
            onClick={() => setConfirm("restart")}
            title={external ? reason : "Restart (dry-run)"}
          >
            Restart
          </button>
        </div>
      </div>
      <div style={{ fontSize: 11, color: external ? "var(--color-warning)" : "var(--color-muted)" }}>
        {external ? "⦿ " : "◐ "}
        {reason}
      </div>
      {error ? <div className="cp-field-error" role="alert">{error}</div> : null}

      <Modal
        open={confirm != null}
        title={`${confirm === "stop" ? "Stop" : "Restart"} ${recipe.id}?`}
        consequence={
          confirm === "restart"
            ? "Active requests will be interrupted while the process cycles."
            : "The runtime stops serving until started again. State is simulated (dry-run)."
        }
        diagram={
          <span className="cp-modal-diagram-row">
            <StatusPill status={(state as never)} />
            <span aria-hidden="true">→</span>
            <StatusPill status={confirm === "stop" ? "stopping" : "starting"} />
          </span>
        }
        confirmLabel={confirm === "stop" ? "Stop" : "Restart"}
        tone="danger"
        busy={busy != null}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm && run(confirm)}
      />
    </div>
  );
}