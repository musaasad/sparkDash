import { useEffect, useState, useSyncExternalStore } from "react";
import type { SparkSnapshot } from "../../api/types";
import type { Route } from "../../hooks/router";
import { fetchDeployments } from "../../api/client";
import { getDeployments, subscribeDomain } from "../../hooks/domainStore";
import { DataTable, type Column } from "../ui/DataTable";
import { Chip, StatusPill } from "../ui/Status";
import { ThemeSwitch } from "../ThemeSwitch";
import { AddSparkDialog } from "../AddSparkDialog";
import { EditSparkDialog } from "../EditSparkDialog";
import { SettingsDialog } from "../SettingsDialog";
import { isWorkerSpark } from "../../api/sparkRole";

interface SettingsProps {
  sparks: SparkSnapshot[];
  navigate: (route: Route) => void;
  onSparksChanged: () => void;
}

/** Settings = the control-plane surface for lab configuration. Reuses the
 * battle-tested node dialogs + server settings dialog; adds lifecycle status. */
export function SettingsSection({ sparks, navigate, onSparksChanged }: SettingsProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [serverOpen, setServerOpen] = useState(false);
  const [dryRun, setDryRun] = useState<boolean | null>(null);

  useEffect(() => {
    fetchDeployments()
      .then((r) => setDryRun(r.dryRun))
      .catch(() => setDryRun(null));
  }, []);

  const deployments = useSyncExternalStore(subscribeDomain, getDeployments, getDeployments);

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
    {
      key: "ports",
      header: "LLM ports",
      mono: true,
      render: (s) => (s.llmPorts?.length ? s.llmPorts.join(", ") : "—"),
    },
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div className="cp-section-title">Settings</div>
        <div className="cp-section-sub">Lab configuration — nodes, appearance, server, lifecycle policy.</div>
      </div>

      <div className="cp-panel">
        <div className="cp-panel-title">
          <span>Compute nodes</span>
          <button type="button" className="cp-btn primary" onClick={() => setAddOpen(true)}>
            + Add node
          </button>
        </div>
        <DataTable ariaLabel="Configured nodes" columns={columns} rows={sparks} rowKey={(s) => s.id} onRowClick={(s) => navigate({ section: "node", nodeId: s.id })} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div className="cp-panel">
          <div className="cp-panel-title">Appearance</div>
          <ThemeSwitch />
          <p className="cp-field-hint" style={{ marginTop: 8 }}>
            Dark-first themes; the choice persists on this device.
          </p>
        </div>
        <div className="cp-panel">
          <div className="cp-panel-title">Server</div>
          <button type="button" className="cp-btn" onClick={() => setServerOpen(true)}>
            Open server settings
          </button>
          <p className="cp-field-hint" style={{ marginTop: 8 }}>
            Poll interval, showcase defaults, LLM probe settings.
          </p>
        </div>
      </div>

      <div className="cp-panel">
        <div className="cp-panel-title">Lifecycle policy</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Chip tone={dryRun === false ? "accent" : "default"}>{dryRun === false ? "LIVE (unexpected)" : "DRY-RUN"}</Chip>
          <span style={{ fontSize: 12, color: "var(--color-muted)" }}>
            Start/Stop/Restart simulate state transitions and write audit entries. No process is launched or stopped.
            Externally managed deployments (like the seeded Qwen) always render controls disabled.
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
      </div>

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