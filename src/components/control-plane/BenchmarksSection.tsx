import { useEffect, useMemo, useState } from "react";
import type { SparkSnapshot, RecipePublic, DecodeBenchJob, PrefillBenchJob } from "../../api/types";
import type { Route } from "../../hooks/router";
import { listDecodeBench, listPrefillBench } from "../../api/client";
import { DataTable, CountedTabs, type Column } from "../ui/DataTable";
import { Chip, StatusPill, SkeletonRows } from "../ui/Status";
import { TimeSeriesChart } from "../ui/TimeSeriesChart";
import { SectionBand } from "../ui/SectionBand";
import { BoltIcon } from "../ui/icons";
import { relativeAge } from "./fleetModel";
import {
  anchorTiles,
  benchName,
  benchShape,
  comparisonOf,
  comparableGroups,
  fmtDuration,
  fmtMs,
  fmtTokS,
  levelAxis,
  medianSeries,
  timedSeries,
  tokenComposition,
  throughputSeries,
  ttftSeries,
  type BenchEntry,
  type BenchKind,
} from "./benchModel";

interface BenchmarksProps {
  sparks: SparkSnapshot[];
  recipes: RecipePublic[];
  navigate: (route: Route) => void;
}

const STATUS_DISPLAY: Record<string, string> = {
  completed: "stopped",
  running: "running",
  failed: "error",
  cancelled: "stopped",
};

/**
 * Benchmark history across the fleet. Comparison only pairs runs whose kind,
 * recipe and workload shape match. All metrics come from stored job results.
 */
export function BenchmarksSection({ sparks, recipes, navigate }: BenchmarksProps) {
  const [rows, setRows] = useState<BenchEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<"all" | BenchKind>("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const all: BenchEntry[] = [];
      for (const s of sparks) {
        const [d, p] = await Promise.all([
          listDecodeBench(s.id).catch(() => null),
          listPrefillBench(s.id).catch(() => null),
        ]);
        if (cancelled) return;
        const decodeJobs = [...(d?.history ?? []), ...(d?.last ? [d.last] : [])];
        for (const job of decodeJobs) push(all, job, "decode", s);
        const prefillJobs = [...(p?.history ?? []), ...(p?.last ? [p.last] : [])];
        for (const job of prefillJobs) push(all, job, "prefill", s);
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

    function push(list: BenchEntry[], job: DecodeBenchJob | PrefillBenchJob, k: BenchKind, s: SparkSnapshot) {
      const config = job.config as { recipeId?: string | null; modelId?: string | null };
      list.push({
        key: `${k}-${job.benchId}`,
        kind: k,
        job,
        sparkId: s.id,
        sparkName: s.name,
        recipeId: config.recipeId ?? null,
        modelId: config.modelId ?? null,
        status: job.status,
        startedAt: job.startedAt,
        durationMs: job.durationMs,
        shape: benchShape(job, k),
      });
    }
  }, [sparks]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (kind !== "all" && r.kind !== kind) return false;
      if (!q) return true;
      return `${benchName(r.job, r.kind)} ${r.sparkName} ${r.recipeId ?? ""} ${r.modelId ?? ""}`.toLowerCase().includes(q);
    });
  }, [rows, kind, query]);

  const groups = useMemo(() => comparableGroups(filtered), [filtered]);

  const toggleExpand = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const columns: Column<BenchEntry>[] = [
    {
      key: "status",
      header: "Status",
      width: "110px",
      render: (r) => <StatusPill status={(STATUS_DISPLAY[r.status] ?? "unknown") as never} label={r.status} />,
    },
    { key: "name", header: "Run", mono: true, render: (r) => <span className="cp-bench-name">{benchName(r.job, r.kind)}</span> },
    { key: "target", header: "Target", width: "120px", render: (r) => <Chip>{r.sparkName}</Chip> },
    {
      key: "recipe",
      header: "Recipe",
      render: (r) =>
        r.recipeId ? (
          <a
            href="/models"
            className="cp-alert-link mono"
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
    { key: "started", header: "Started", mono: true, muted: true, width: "92px", render: (r) => relativeAge(r.startedAt) },
    { key: "duration", header: "Duration", align: "right", width: "82px", render: (r) => <span className="mono">{fmtDuration(r.durationMs)}</span> },
    {
      key: "actions",
      header: "",
      width: "130px",
      render: (r) => (
        <span className="cp-row-actions">
          <button
            type="button"
            className="cp-btn ghost"
            onClick={(e) => {
              e.stopPropagation();
              toggleExpand(r.key);
            }}
          >
            {open.has(r.key) ? "Hide results" : "View results"}
          </button>
          <button
            type="button"
            className="cp-kebab"
            aria-label={`More actions for ${benchName(r.job, r.kind)}`}
            onClick={(e) => {
              e.stopPropagation();
              toggleExpand(r.key);
            }}
          >
            ⋯
          </button>
        </span>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="cp-toolbar" role="search">
        <div className="cp-toolbar-search">
          <input
            type="search"
            aria-label="Search benchmark runs"
            placeholder="Search recipe, model, target…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="cp-toolbar-filters">
          <CountedTabs
            tabs={[
              { key: "all", label: "All", count: rows.length },
              { key: "decode", label: "Decode", count: rows.filter((r) => r.kind === "decode").length },
              { key: "prefill", label: "Prefill", count: rows.filter((r) => r.kind === "prefill").length },
            ]}
            active={kind}
            onSelect={(k) => setKind(k as "all" | BenchKind)}
            ariaLabel="Benchmark type filters"
            panelId="bench-runs"
          />
        </div>
        <div className="cp-toolbar-primary">
          {query ? (
            <button type="button" className="cp-btn ghost" onClick={() => setQuery("")}>
              Clear
            </button>
          ) : null}
        </div>
      </div>

      <SectionBand icon={<BoltIcon />} title="Fleet runs" count={filtered.length} />

      {loading && rows.length === 0 ? (
        <div id="bench-runs">
          <SkeletonRows columns={4} rows={4} />
        </div>
      ) : (
        <div id="bench-runs">
          <DataTable
          ariaLabel="Benchmark history"
          columns={columns}
          rows={filtered}
          rowKey={(r) => r.key}
          expandedKeys={open}
          renderExpanded={(r) => <BenchExpansion entry={r} groups={groups} />}
          empty={
            <span className="cp-table-empty-box">
              {query || kind !== "all"
                ? "No runs match these filters — clear the search or pick another type."
                : "No benchmark runs yet — run a decode or prefill benchmark from a node page."}
            </span>
          }
        />
        </div>
      )}
    </div>
  );
}

/** Inline results: anchor tiles, composition bars, 2x2 chart grid, comparison. */
function BenchExpansion({ entry, groups }: { entry: BenchEntry; groups: BenchEntry[][] }) {
  const kind = entry.kind;
  const job = entry.job;
  const tiles = anchorTiles(job, kind);
  const comp = tokenComposition(job, kind);
  const tps = throughputSeries(job, kind);
  const ttft = ttftSeries(job, kind);
  const median = medianSeries(job, kind);
  const axis = levelAxis(job, kind);

  const group = groups.find((g) => g.some((e) => e.key === entry.key));
  const cmp = group ? comparisonOf(group) : null;
  const baseTiles = cmp ? anchorTiles(cmp.baseline.job, cmp.baseline.kind) : null;

  const completed = entry.status === "completed";
  const rangeStart = new Date(job.startedAt).toISOString().slice(0, 19).replace("T", " ");
  const rangeEnd = new Date(job.completedAt ?? job.startedAt + job.durationMs).toISOString().slice(0, 19).replace("T", " ");

  return (
    <div className="cp-expand-body cp-bench-expand">
      <div className="cp-expand-head">
        <span className="cp-crumb-current">Benchmarks</span>
        <span className="cp-crumb-sep">/</span>
        <span className="mono">{benchName(job, kind)}</span>
        <StatusPill status={(STATUS_DISPLAY[entry.status] ?? "unknown") as never} label={entry.status} />
        <Chip tone="mono">{entry.sparkName}</Chip>
        <span className="muted mono">
          {rangeStart} → {rangeEnd}
        </span>
        <span className="muted">· {job.progress.completedLevels}/{job.progress.totalLevels} levels</span>
      </div>

      {!completed ? (
        <div className="cp-banner is-amber" role="alert">
          Run {entry.status} — partial results below are still the stored data.
        </div>
      ) : null}

      {job.error ? <div className="cp-bench-error mono">{job.error}</div> : null}

      <div className="cp-bench-tiles">
        <Tile label="Requests" value={String(job.results.length)} />
        <Tile label="Throughput p50" value={fmtTokS(tiles.throughput.p50)} />
        <Tile label="Throughput p90" value={fmtTokS(tiles.throughput.p90)} />
        <Tile label="TTFT p50" value={fmtMs(tiles.ttft.p50)} />
        <Tile label="TTFT p90" value={fmtMs(tiles.ttft.p90)} />
      </div>

      <div className="cp-bench-comp" aria-label="Token composition">
        <span className="cp-bench-complabel">prefill {Math.round(comp.prefill)}%</span>
        <span className="cp-bench-bar">
          <span className="cp-bench-bar-prefill" style={{ width: `${comp.prefill}%` }} />
          <span className="cp-bench-bar-decode" style={{ width: `${comp.decode}%` }} />
        </span>
        <span className="cp-bench-complabel">decode {Math.round(comp.decode)}%</span>
      </div>

      {tps.length ? (
        <div className="cp-chart-grid">
          <div className="cp-chart-cell">
            <div className="cp-bignum-label">Throughput over time</div>
            <div className="cp-chart-body">
              <TimeSeriesChart
                series={[{ label: "tok/s", color: "var(--color-accent)", data: timedSeries(tps, job), format: (v) => `${Math.round(v)} tok/s` }]}
                windowMs={Math.max(60_000, job.durationMs)}
                height={150}
                emptyLabel="No throughput samples"
              />
            </div>
          </div>
          <div className="cp-chart-cell">
            <div className="cp-bignum-label">TTFT distribution</div>
            <div className="cp-chart-body">
              <TimeSeriesChart
                series={[{ label: "TTFT ms", color: "var(--color-warning)", data: timedSeries(ttft, job), format: (v) => `${Math.round(v)} ms` }]}
                windowMs={Math.max(60_000, job.durationMs)}
                height={150}
                emptyLabel="No TTFT samples"
              />
            </div>
          </div>
          <div className="cp-chart-cell">
            <div className="cp-bignum-label">{kind === "decode" ? "Decode tok/s per level" : "Prefill tok/s per size"}</div>
            <div className="cp-chart-body">
              <TimeSeriesChart
                series={[{ label: "tok/s", color: "var(--color-accent)", data: timedSeries(median, job), format: (v) => `${Math.round(v)} tok/s` }]}
                windowMs={Math.max(60_000, job.durationMs)}
                height={150}
                emptyLabel="No level samples"
              />
            </div>
          </div>
          <div className="cp-chart-cell">
            <div className="cp-bignum-label">{kind === "decode" ? "Concurrency sweep" : "Context-size sweep"}</div>
            <div className="cp-chart-body">
              <TimeSeriesChart
                series={[{ label: kind === "decode" ? "concurrency" : "ctx", color: "var(--color-grid-strong, var(--color-border-strong))", data: timedSeries(axis, job), format: (v) => `${v}` }]}
                windowMs={Math.max(60_000, job.durationMs)}
                height={150}
                emptyLabel="No sweep samples"
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="cp-table-empty">No result levels stored for this run.</div>
      )}

      {cmp ? (
        <div className="cp-bench-compare" aria-label="Comparison against the previous comparable run">
          <div className="cp-bench-compare-head">
            Comparison vs {relativeAge(cmp.baseline.startedAt)} · {benchShape(cmp.baseline.job, cmp.baseline.kind)}
          </div>
          <div className="cp-bench-compare-cols">
            <div>
              <div className="cp-bignum-label">Baseline</div>
              <div className="mono">{fmtTokS(baseTiles?.throughput.p50 ?? null)}</div>
            </div>
            <div>
              <div className="cp-bignum-label">This run</div>
              <div className="mono">{fmtTokS(tiles.throughput.p50)}</div>
            </div>
            <div>
              <div className="cp-bignum-label">Δ throughput</div>
              <div className={`cp-delta ${cmp.throughput.direction}`}>{cmp.throughput.text}</div>
            </div>
            <div>
              <div className="cp-bignum-label">Δ TTFT</div>
              <div className={`cp-delta ${cmp.ttft.direction}`}>{cmp.ttft.text}</div>
            </div>
          </div>
        </div>
      ) : (
        <div className="cp-field-hint">No comparable run yet — comparison appears once another run shares kind, recipe and workload shape.</div>
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  const absent = value === "—";
  return (
    <div className="cp-bench-tile">
      <div className="cp-bignum-label">{label}</div>
      <div className={`cp-bench-tile-value${absent ? " is-absent" : ""}`}>{absent ? "No data" : value}</div>
    </div>
  );
}

// Keep the type import used by the comparison contract.

