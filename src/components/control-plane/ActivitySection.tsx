import { useMemo, useState } from "react";
import type { ActivityEvent } from "../../api/types";
import { DataTable, type Column } from "../ui/DataTable";
import { Chip, EmptyState } from "../ui/Status";

const KINDS = ["all", "node", "lifecycle", "bench", "showcase", "console", "alert"] as const;

interface ActivityProps {
  events: ActivityEvent[];
}

/** Unified activity feed — real events only (no synthetic filler). */
export function ActivitySection({ events }: ActivityProps) {
  const [kind, setKind] = useState<(typeof KINDS)[number]>("all");

  const rows = useMemo(() => (kind === "all" ? events : events.filter((e) => e.kind === kind)), [events, kind]);

  const columns: Column<ActivityEvent>[] = [
    {
      key: "ts",
      header: "Time",
      mono: true,
      muted: true,
      width: "170px",
      render: (e) => e.ts.slice(0, 19).replace("T", " "),
    },
    { key: "kind", header: "Kind", width: "110px", render: (e) => <Chip>{e.kind}</Chip> },
    {
      key: "summary",
      header: "Event",
      render: (e) => (
        <span>
          {e.summary}
          {e.attribution?.actor ? <span className="muted"> · {e.attribution.actor}</span> : null}
        </span>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div className="cp-section-title">Activity</div>
        <div className="cp-section-sub">Everything that happened in the lab — node changes, deployments, benchmarks, alerts.</div>
      </div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className={`cp-btn ghost ${kind === k ? "is-active" : ""}`}
            style={{ padding: "4px 10px", fontSize: 11, background: kind === k ? "var(--color-surface-hover)" : undefined }}
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
          >
            {k}
          </button>
        ))}
      </div>
      <DataTable
        ariaLabel="Activity feed"
        columns={columns}
        rows={rows}
        rowKey={(e) => String(e.seq)}
        empty={<EmptyState title="No activity yet" subtitle="Node transitions, lifecycle operations and benchmark runs will appear here." />}
      />
    </div>
  );
}