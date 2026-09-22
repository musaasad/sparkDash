import { useMemo } from "react";
import type { SparkSnapshot, DeploymentStatus, RecipePublic } from "../../api/types";
import type { Route } from "../../hooks/router";
import { DataTable, type Column } from "../ui/DataTable";
import { StatusPill, Chip } from "../ui/Status";
import { EmptyState } from "../ui/Status";
import { primaryNodes, workersOf, recipesOnNode, fmtUptime } from "./fleetModel";
import { Topology } from "./Topology";
import { isWorkerSpark } from "../../api/sparkRole";

interface FleetProps {
  sparks: SparkSnapshot[];
  deployments: readonly DeploymentStatus[];
  recipes: readonly RecipePublic[];
  navigate: (route: Route) => void;
}

export function FleetSection({ sparks, deployments, recipes, navigate }: FleetProps) {
  const nodes = useMemo(() => primaryNodes(sparks), [sparks]);
  const workers = useMemo(() => sparks.filter(isWorkerSpark), [sparks]);

  const columns: Column<SparkSnapshot>[] = [
    {
      key: "name",
      header: "Node",
      render: (n) => (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className={`cp-dot ${n.online ? "running" : "stopped"}`} />
          <span style={{ fontWeight: 500 }}>{n.name}</span>
          <Chip>{n.kind === "host" ? "host" : "spark"}</Chip>
          {n.role === "head" ? <Chip tone="accent">head</Chip> : null}
        </div>
      ),
    },
    { key: "ip", header: "Address", mono: true, muted: true, render: (n) => n.lanIp || "—" },
    {
      key: "models",
      header: "Deployments",
      render: (n) => {
        const onNode = recipesOnNode(recipes, n.id);
        if (!onNode.length) return <span className="muted">—</span>;
        return (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {onNode.map((r) => {
              const dep = deployments.find((d) => d.recipeId === r.id);
              return <StatusPill key={r.id} status={(dep?.state ?? "available") as never} label={r.modelId} />;
            })}
          </div>
        );
      },
    },
    {
      key: "gpu",
      header: "GPU",
      align: "right",
      render: (n) => (n.metrics?.gpu ? `${Math.round(n.metrics.gpu.usage)}%` : "—"),
    },
    {
      key: "power",
      header: "Power",
      align: "right",
      render: (n) => {
        const p = n.metrics?.gpu?.power?.systemDraw ?? n.metrics?.gpu?.power?.draw;
        return p != null ? `${Math.round(p)} W` : "—";
      },
    },
    {
      key: "uptime",
      header: "Uptime",
      align: "right",
      muted: true,
      render: (n) => fmtUptime(n.uptime),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div className="cp-section-title">Fleet</div>
        <div className="cp-section-sub">
          {nodes.length} compute node{nodes.length === 1 ? "" : "s"}
          {workers.length ? ` · ${workers.length} worker${workers.length === 1 ? "" : "s"}` : ""} · scales to any node count
        </div>
      </div>

      {nodes.length === 0 ? (
        <div className="cp-panel">
          <EmptyState title="No compute nodes" subtitle="Add a Spark or host in Settings to start observing your lab." />
        </div>
      ) : (
        <>
          {nodes.length <= 4 ? (
            <div className="cp-panel">
              <div className="cp-panel-title">Topology</div>
              <Topology sparks={sparks} recipes={recipes} deployments={deployments} onNodeClick={(id) => navigate({ section: "node", nodeId: id })} />
            </div>
          ) : null}
          <DataTable
            ariaLabel="Compute nodes"
            columns={columns}
            rows={nodes}
            rowKey={(n) => n.id}
            onRowClick={(n) => navigate({ section: "node", nodeId: n.id })}
          />
          {workers.length > 0 ? (
            <div>
              <div className="cp-panel-title" style={{ marginBottom: 6 }}>Worker nodes</div>
              <DataTable
                ariaLabel="Worker nodes"
                columns={[
                  {
                    key: "name",
                    header: "Worker",
                    render: (n) => (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span className={`cp-dot ${n.online ? "running" : "stopped"}`} />
                        <span style={{ fontWeight: 500 }}>{n.name}</span>
                        <Chip>worker</Chip>
                      </div>
                    ),
                  },
                  {
                    key: "label",
                    header: "Cluster",
                    render: (n) => n.workerLabel || n.workerDerivedLabel || <span className="muted">unknown</span>,
                  },
                  {
                    key: "status",
                    header: "Status",
                    render: (n) => <StatusPill status={n.online ? "online" : "offline"} />,
                  },
                ]}
                rows={workers}
                rowKey={(n) => n.id}
                onRowClick={(n) => navigate({ section: "node", nodeId: n.id })}
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}