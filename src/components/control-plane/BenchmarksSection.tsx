import { useEffect, useMemo, useState } from "react";
import type { SparkSnapshot, RecipePublic, DecodeBenchJob, PrefillBenchJob } from "../../api/types";
import type { Route } from "../../hooks/router";
import { listDecodeBench, listPrefillBench } from "../../api/client";
import { DataTable, type Column } from "../ui/DataTable";
import { Chip, EmptyState, StatusPill } from "../ui/Status";

interface BenchRow {
  key: string;
  kind: "decode" | "prefill";
  sparkId: string;
  sparkName: string;
  recipeId: string | null;
  modelId: string | null;
  status: DecodeBenchJob["status"];
  startedAt: number;
  headline: string;
  comparability: string;
  job: DecodeBenchJob | PrefillBenchJob;
}

interface BenchmarksProps {
  sparks: SparkSnapshot[];
  recipes: RecipePublic[];
  navigate: (route: Route) => void;
}

/**
 * Benchmark history across the fleet. Comparison is restricted to comparable
 * workloads: runs are only grouped side-by-side when kind + recipe + workload
 * shape match (concurrency set / context sizes); everything else stays apart.
 */
export function BenchmarksSection({ sparks, recipes, navigate }: BenchmarksProps) {
  const [rows, setRows] = useState<BenchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<"all" | "decode" | "prefill">("all");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const all: BenchRow[] = [];
      for (const s of sparks) {
        const [d, p] = await Promise.all([
          listDecodeBench(s.id).catch(() => null),
          listPrefillBench(s.id).catch(() => null),
        ]);
        if (cancelled) return;
        for (const job of [...(d?.history ?? []), ...(d?.last && !(d.history || []).includes(d.last) ? [d.last] : [])]) {
          const peak = (job.results || []).reduce((m, r) => Math.max(m, r.aggregateDecodeTps || 0), 0);
          all.push({
            key: `d-${job.benchId}`,
            kind: "decode",
            sparkId: s.id,
            sparkName: s.name,
            recipeId: job.config.recipeId ?? null,
            modelId: job.config.modelId ?? null,
            status: job.status,
            startedAt: job.startedAt,
            headline: `${Math.round(peak)} tok/s`,
            comparability: `${job.config.promptType ?? "structural"} · c${(job.config.concurrencies || []).join("/")}`,
            job,
          });
        }
        for (const job of [...(p?.history ?? []), ...(p?.last && !(p.history || []).includes(p.last) ? [p.last] : [])]) {
          const peak = (job.results || []).reduce((m, r) => Math.max(m, r.prefillTps || 0), 0);
          all.push({
            key: `p-${job.benchId}`,
            kind: "prefill",
            sparkId: s.id,
            sparkName: s.name,
            recipeId: job.config.recipeId ?? null,
            modelId: job.config.modelId ?? null,
            status: job.status,
            startedAt: job.startedAt,
            headline: `${Math.round(peak)} tok/s`,
            comparability: `ctx ${(job.config.contextSizes || []).join("/")}`,
            job,
          });
        }
      }
      if (!cancelled) {
        all.sort((a, b) => b.startedAt - a.startedAt);
        setRows(all);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sparks]);

  const visible = useMemo(() => (kind === "all" ? rows : rows.filter((r) => r.kind === kind)), [rows, kind]);

  const columns: Column<BenchRow>[] = [
    {
      key: "when",
      header: "When",
      mono: true,
      muted: true,
      width: "170px",
      render: (r) => new Date(r.startedAt).toISOString().slice(0, 19).replace("T", " "),
    },
    { key: "kind", header: "Type", width: "90px", render: (r) => <Chip tone={r.kind === "decode" ? "accent" : "default"}>{r.kind}</Chip> },
    { key: "node", header: "Node", render: (r) => r.sparkName },
    {
      key: "recipe",
      header: "Recipe",
      render: (r) =>
        r.recipeId ? (
          <a
            href={`/models`}
            className="cp-alert-link"
            onClick={(e) => {
              e.preventDefault();
              const rec = recipes.find((x) => x.id === r.recipeId);
              if (rec) navigate({ section: "model", modelId: rec.modelId, tab: "performance" });
            }}
          >
            {r.recipeId}
          </a>
        ) : (
          <span className="muted">{r.modelId || "—"}</span>
        ),
    },
    { key: "shape", header: "Workload", mono: true, muted: true, render: (r) => r.comparability },
    { key: "peak", header: "Peak", align: "right", render: (r) => (r.status === "completed" ? r.headline : "—") },
    { key: "status", header: "Status", render: (r) => <StatusPill status={(r.status === "completed" ? "stopped" : r.status === "running" ? "running" : "error") as never} label={r.status} /> },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div className="cp-section-title">Benchmarks</div>
        <div className="cp-section-sub">
          Fleet benchmark history. Runs are only comparable when kind, recipe and workload shape match.
        </div>
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        {(["all", "decode", "prefill"] as const).map((k) => (
          <button
            key={k}
            type="button"
            className="cp-btn ghost"
            style={{ padding: "4px 10px", fontSize: 11, background: kind === k ? "var(--color-surface-hover)" : undefined }}
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
          >
            {k}
          </button>
        ))}
      </div>
      <DataTable
        ariaLabel="Benchmark history"
        columns={columns}
        rows={visible}
        rowKey={(r) => r.key}
        empty={
          loading ? (
            <div className="cp-table-empty">Loading benchmark history…</div>
          ) : (
            <EmptyState title="No benchmark runs yet" subtitle="Run a decode or prefill benchmark from a node page to populate this history." />
          )
        }
      />
    </div>
  );
}