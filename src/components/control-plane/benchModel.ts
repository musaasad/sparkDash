import type { DecodeBenchJob, PrefillBenchJob } from "../../api/types";

/**
 * Pure model for the Benchmarks surface (docs/DESIGN_BRIEF.md §Benchmarks).
 * Everything is derived from what the server actually stores on bench jobs —
 * no fabricated metrics. Percentiles come from the per-level result rows.
 */

export type BenchKind = "decode" | "prefill";
export type BenchJob = DecodeBenchJob | PrefillBenchJob;

export interface TimedPoint {
  at: number;
  value: number;
}

/** Sorted-percentile helper (linear interpolation). Null for empty input. */
export function percentile(values: readonly number[], p: number): number | null {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  if (nums.length === 1) return nums[0];
  const idx = (nums.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return nums[lo];
  return nums[lo] + (nums[hi] - nums[lo]) * (idx - lo);
}

function levels(job: BenchJob): BenchJob["results"] {
  return job.results;
}

/** Mean throughput per level: decode tok/s or prefill tok/s. */
export function throughputSeries(job: BenchJob, kind: BenchKind): number[] {
  if (kind === "decode") return (job as DecodeBenchJob).results.map((r) => r.meanDecodeTps);
  return (job as PrefillBenchJob).results.map((r) => r.prefillTps);
}

/** Mean TTFT ms per level. */
export function ttftSeries(job: BenchJob, kind: BenchKind): number[] {
  if (kind === "decode") return (job as DecodeBenchJob).results.map((r) => r.meanTtftMs);
  return (job as PrefillBenchJob).results.map((r) => r.ttftMs);
}

/** Level duration ms (used to spread points on the time axis). */
export function levelDurations(job: BenchJob): number[] {
  return levels(job).map((l) => l.durationMs || 0);
}

/** Synthetic time axis anchored at the real job start, cumulative by level duration. */
export function timedSeries(values: readonly number[], job: BenchJob): TimedPoint[] {
  const start = job.startedAt || Date.now();
  const durations = levelDurations(job);
  let cursor = start;
  return values.map((value, i) => {
    const at = cursor;
    cursor += durations[i] ?? 0;
    return { at, value };
  });
}

/** Median throughput per level (decode) / prefill tok/s, for the per-level chart. */
export function medianSeries(job: BenchJob, kind: BenchKind): number[] {
  if (kind === "decode") return (job as DecodeBenchJob).results.map((r) => r.medianDecodeTps);
  return (job as PrefillBenchJob).results.map((r) => r.prefillTps);
}

/** Level axis value (concurrency or context size) for the sweep chart. */
export function levelAxis(job: BenchJob, kind: BenchKind): number[] {
  if (kind === "decode") return (job as DecodeBenchJob).results.map((r) => r.concurrency);
  return (job as PrefillBenchJob).results.map((r) => r.targetTokens);
}

/** Anchor p50/p90 pairs with owned empty state (null → "No data"). */
export function anchorTiles(job: BenchJob, kind: BenchKind): {
  throughput: { p50: number | null; p90: number | null };
  ttft: { p50: number | null; p90: number | null };
} {
  const tps = throughputSeries(job, kind);
  const ttft = ttftSeries(job, kind);
  return {
    throughput: { p50: percentile(tps, 0.5), p90: percentile(tps, 0.9) },
    ttft: { p50: percentile(ttft, 0.5), p90: percentile(ttft, 0.9) },
  };
}

/** Token composition for proportional bars: prefill vs decode token share. */
export function tokenComposition(job: BenchJob, kind: BenchKind): { prefill: number; decode: number } {
  let prefill = 0;
  let decode = 0;
  if (kind === "decode") {
    for (const l of (job as DecodeBenchJob).results) {
      prefill += l.totalPrefillTokens || 0;
      decode += l.totalDecodeTokens || 0;
    }
  } else {
    for (const r of (job as PrefillBenchJob).results) {
      prefill += r.promptTokens || 0;
      decode += r.completionTokens || 0;
    }
  }
  const total = prefill + decode;
  if (total <= 0) return { prefill: 0, decode: 0 };
  return { prefill: (prefill / total) * 100, decode: (decode / total) * 100 };
}

export interface Delta {
  text: string;
  direction: "improvement" | "regression" | "flat";
}

/**
 * Signed percentage delta of `to` against `from`. Green=improvement, red=regression
 * only; `higherIsBetter` flips the interpretation for TTFT.
 */
export function signedDelta(from: number | null, to: number | null, higherIsBetter: boolean): Delta {
  if (from == null || to == null || !Number.isFinite(from) || !Number.isFinite(to) || from <= 0) {
    return { text: "—", direction: "flat" };
  }
  const pct = ((to - from) / from) * 100;
  const rounded = Math.round(pct);
  if (rounded === 0) return { text: "±0%", direction: "flat" };
  const improved = higherIsBetter ? rounded > 0 : rounded < 0;
  return {
    text: `${rounded > 0 ? "+" : ""}${rounded}%`,
    direction: improved ? "improvement" : "regression",
  };
}

export function fmtTokS(v: number | null): string {
  return v == null ? "—" : `${Math.round(v)} tok/s`;
}

export function fmtMs(v: number | null): string {
  return v == null ? "—" : `${Math.round(v)} ms`;
}

export function fmtDuration(ms: number): string {
  if (!ms || ms <= 0) return "—";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/** Human bench name from stored config — never invent a label. */
export function benchName(job: BenchJob, kind: BenchKind): string {
  if (kind === "decode") return `decode · c${(job as DecodeBenchJob).config.concurrencies.join("/")}`;
  return `prefill · ctx${(job as PrefillBenchJob).config.contextSizes.join("/")}`;
}

/** Comparability shape: the workload fingerprint grouping truly comparable runs. */
export function benchShape(job: BenchJob, kind: BenchKind): string {
  if (kind === "decode") {
    const c = job as DecodeBenchJob;
    return `${c.config.promptType ?? "structured"} · c${c.config.concurrencies.join("/")}`;
  }
  return `ctx${(job as PrefillBenchJob).config.contextSizes.join("/")}`;
}

export interface BenchEntry {
  key: string;
  kind: BenchKind;
  job: BenchJob;
  sparkId: string;
  sparkName: string;
  recipeId: string | null;
  modelId: string | null;
  status: BenchJob["status"];
  startedAt: number;
  durationMs: number;
  shape: string;
}

/** Group comparable completed runs (kind + recipe + shape), newest last. */
export function comparableGroups(rows: readonly BenchEntry[]): BenchEntry[][] {
  const map = new Map<string, BenchEntry[]>();
  for (const r of rows) {
    if (r.status !== "completed") continue;
    const key = `${r.kind}|${r.recipeId ?? r.modelId ?? r.sparkId}|${r.shape}`;
    const list = map.get(key) ?? [];
    list.push(r);
    map.set(key, list);
  }
  return [...map.values()]
    .filter((g) => g.length >= 2)
    .map((g) => [...g].sort((a, b) => a.startedAt - b.startedAt).slice(-2));
}

/** Side-by-side delta pair for a comparable group: [baseline, candidate]. */
export function comparisonOf(group: BenchEntry[]): {
  baseline: BenchEntry;
  candidate: BenchEntry;
  throughput: Delta;
  ttft: Delta;
} | null {
  if (group.length < 2) return null;
  const [baseline, candidate] = group;
  const baseTps = percentile(throughputSeries(baseline.job, baseline.kind), 0.5);
  const candTps = percentile(throughputSeries(candidate.job, candidate.kind), 0.5);
  const baseTtft = percentile(ttftSeries(baseline.job, baseline.kind), 0.5);
  const candTtft = percentile(ttftSeries(candidate.job, candidate.kind), 0.5);
  return {
    baseline,
    candidate,
    throughput: signedDelta(baseTps, candTps, true),
    ttft: signedDelta(baseTtft, candTtft, false),
  };
}
