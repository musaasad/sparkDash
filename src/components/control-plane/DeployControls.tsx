import { useState } from "react";
import type { DeploymentStatus, RecipePublic } from "../../api/types";
import { deleteDeployment, deploymentAction } from "../../api/client";
import { StatusPill } from "../ui/Status";
import { Modal } from "../ui/Modal";
import { ExternalManagedIcon, ManagedIcon } from "../ui/icons";

interface DeployControlsProps {
  recipe: RecipePublic;
  deployment?: DeploymentStatus;
  onUpdated?: () => void;
}

/**
 * Lifecycle controls, kept deliberately SEPARATE:
 *
 *  START / STOP / RESTART — change desiredState + simulate a dry-run transition.
 *    They never touch the recipe or the weight files.
 *  REMOVE BINDING — deletes the deployment binding only; model, recipe and
 *    weights all survive.
 *
 * This phase is DRY-RUN: managed recipes simulate; an externally-managed
 * deployment renders START/STOP/RESTART DISABLED with an explicit reason —
 * showing live lifecycle controls on a never-touch process is a trust violation.
 * REMOVE BINDING is CONFIG-ONLY (DELETE /api/deployments/:id never touches the
 * external process) so it stays ENABLED for external deployments too — otherwise
 * an external binding could never be un-bound.
 */
export function DeployControls({ recipe, deployment, onUpdated }: DeployControlsProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"stop" | "restart" | "remove" | null>(null);

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

  async function remove() {
    setBusy("remove");
    setError(null);
    try {
      await deleteDeployment(targetId);
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
            disabled={external || busy != null || !canStart || !deployment}
            onClick={() => run("start")}
            title={external ? reason : deployment ? "Start (dry-run)" : "Create a binding first"}
          >
            {busy === "start" ? "Starting…" : "Start"}
          </button>
          <button
            type="button"
            className="cp-btn"
            disabled={external || busy != null || !canStop || !deployment}
            onClick={() => setConfirm("stop")}
            title={external ? reason : deployment ? "Stop (dry-run)" : "Create a binding first"}
          >
            Stop
          </button>
          <button
            type="button"
            className="cp-btn"
            disabled={external || busy != null || state !== "running" || !deployment}
            onClick={() => setConfirm("restart")}
            title={external ? reason : deployment ? "Restart (dry-run)" : "Create a binding first"}
          >
            Restart
          </button>
          <button
            type="button"
            className="cp-btn ghost"
            disabled={busy != null || !deployment}
            onClick={() => setConfirm("remove")}
            title={external ? "Removes the binding record; the external process is untouched" : "Remove the binding only — recipe, model and weights stay"}
          >
            Remove binding
          </button>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: external ? "var(--color-warning)" : "var(--color-muted)" }}>
        {external ? <ExternalManagedIcon size={12} /> : <ManagedIcon size={12} />}
        <span>{reason}</span>
      </div>
      {error ? (
        <div className="cp-field-error" role="alert">
          {error}
        </div>
      ) : null}

      <Modal
        open={confirm != null}
        title={`${confirm === "stop" ? "Stop" : confirm === "restart" ? "Restart" : "Remove binding for"} ${recipe.id}?`}
        consequence={
          confirm === "remove"
            ? "Deletes the DEPLOYMENT BINDING only. The recipe, the model and every weight file stay exactly where they are."
            : confirm === "restart"
              ? "Active requests are interrupted while the process cycles. The recipe is untouched."
              : "The runtime stops serving until started again. State is simulated (dry-run); the recipe is untouched."
        }
        diagram={
          confirm === "remove" ? undefined : (
            <span className="cp-modal-diagram-row">
              <StatusPill status={state as never} />
              <span aria-hidden="true">→</span>
              <StatusPill status={confirm === "stop" ? "stopping" : "starting"} />
            </span>
          )
        }
        info={confirm === "remove" ? "Re-create the binding any time; nothing is archived." : undefined}
        confirmLabel={confirm === "stop" ? "Stop" : confirm === "restart" ? "Restart" : "Remove binding"}
        tone={confirm === "remove" ? "danger" : "primary"}
        busy={busy != null}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm === "remove") void remove();
          else if (confirm) void run(confirm);
        }}
      />
    </div>
  );
}
