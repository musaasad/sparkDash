import type { ActivityEvent } from "../../api/types";
import { relativeAge } from "./fleetModel";

/**
 * Pure model for the Activity surface (docs/DESIGN_BRIEF.md §Activity).
 *
 * Severity is DERIVED from what the server actually stores (kind + summary);
 * no synthetic fields. The feed keeps error/warning/info facets with live
 * counts, a source dropdown, time-range chips and repeat deduping — all
 * client-side over the real event list.
 */

export type ActivityLevel = "error" | "warning" | "info";
export type ActivitySource = "lifecycle" | "console" | "system";

export const ACTIVITY_LEVELS: ActivityLevel[] = ["error", "warning", "info"];

export const ACTIVITY_LEVEL_LABELS: Record<ActivityLevel, string> = {
  error: "Errors",
  warning: "Warnings",
  info: "Info",
};

export const ACTIVITY_SOURCES: ActivitySource[] = ["lifecycle", "console", "system"];

/** Time-range chips. `all` = no boundary. */
export const ACTIVITY_WINDOWS = [
  { key: "15m", label: "15m", ms: 15 * 60_000 },
  { key: "1h", label: "1h", ms: 60 * 60_000 },
  { key: "24h", label: "24h", ms: 24 * 60 * 60_000 },
  { key: "all", label: "All", ms: null },
] as const;

export type ActivityWindowKey = (typeof ACTIVITY_WINDOWS)[number]["key"];

const ERROR_RE = /\b(error|errors|failed|fail|failure|crash|crashed|exception|unreachable|refused|stuck)\b/i;
const WARN_RE = /\b(offline|degraded|warn|warning|timeout|throttl\w*|expected|high|exceeded|missing)\b/i;

/** Derive severity from stored kind + summary. Alert is always an error. */
export function activityLevel(e: ActivityEvent): ActivityLevel {
  if (e.kind === "alert") return "error";
  const text = `${e.summary} ${e.subject ?? ""}`;
  if (ERROR_RE.test(text)) return "error";
  if (WARN_RE.test(text)) return "warning";
  return "info";
}

/** Coarse source bucket for the source dropdown. */
export function activitySource(e: ActivityEvent): ActivitySource {
  if (e.kind === "console") return "console";
  if (e.kind === "lifecycle" || e.kind === "bench" || e.kind === "showcase") return "lifecycle";
  return "system";
}

export interface ActivityFilters {
  query?: string;
  levels?: readonly ActivityLevel[];
  source?: ActivitySource | "all";
  window?: ActivityWindowKey;
  now?: number;
}

/** Window lower bound in ms, or null for "all". */
export function windowFloor(window: ActivityWindowKey | undefined, now: number): number | null {
  const spec = ACTIVITY_WINDOWS.find((w) => w.key === (window ?? "24h"));
  return spec?.ms == null ? null : now - spec.ms;
}

function matchesQuery(e: ActivityEvent, q: string): boolean {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const hay = `${e.summary} ${e.subject ?? ""} ${e.kind} ${e.attribution?.actor ?? ""} ${
    e.meta ? JSON.stringify(e.meta) : ""
  }`.toLowerCase();
  return hay.includes(needle);
}

/**
 * Apply query + source + window (NOT severity). Severity facets are counted
 * over the result so the chips stay live against the other filters.
 */
export function filterActivity(events: readonly ActivityEvent[], f: ActivityFilters = {}): ActivityEvent[] {
  const now = f.now ?? Date.now();
  const floor = windowFloor(f.window, now);
  return events.filter((e) => {
    if (f.source && f.source !== "all" && activitySource(e) !== f.source) return false;
    if (floor != null) {
      const at = Date.parse(e.ts);
      if (Number.isFinite(at) && at < floor) return false;
    }
    return matchesQuery(e, f.query ?? "");
  });
}

/** Live severity counts over a pre-filtered set. */
export function activityFacets(events: readonly ActivityEvent[]): Array<{ level: ActivityLevel; label: string; count: number }> {
  const counts: Record<ActivityLevel, number> = { error: 0, warning: 0, info: 0 };
  for (const e of events) counts[activityLevel(e)]++;
  return ACTIVITY_LEVELS.map((level) => ({ level, label: ACTIVITY_LEVEL_LABELS[level], count: counts[level] }));
}

/** Apply the selected severity facets. */
export function applyLevels(events: readonly ActivityEvent[], levels: readonly ActivityLevel[] | undefined): ActivityEvent[] {
  if (!levels || levels.length === 0 || levels.length === ACTIVITY_LEVELS.length) return [...events];
  const set = new Set(levels);
  return events.filter((e) => set.has(activityLevel(e)));
}

export interface DedupedActivity {
  event: ActivityEvent;
  level: ActivityLevel;
  source: ActivitySource;
  count: number;
}

/**
 * Collapse identical repeats (same kind/subject/summary/level) into one row with
 * an ×N count, keeping the newest occurrence as the representative.
 */
export function dedupeActivity(events: readonly ActivityEvent[]): DedupedActivity[] {
  const groups = new Map<string, DedupedActivity>();
  for (const e of events) {
    const level = activityLevel(e);
    const key = `${e.kind}|${e.subject ?? ""}|${e.summary}|${level}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      if (Date.parse(e.ts) > Date.parse(existing.event.ts)) existing.event = e;
    } else {
      groups.set(key, { event: e, level, source: activitySource(e), count: 1 });
    }
  }
  return [...groups.values()].sort((a, b) => Date.parse(b.event.ts) - Date.parse(a.event.ts));
}

/** Relative timestamp for list rows; absolute in the expansion title. */
export function relativeTs(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? relativeAge(at, now) : "—";
}

export function absoluteTs(iso: string): string {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 19).replace("T", " ") : iso;
}

/** Actor-verb sentence: summary plus the observed actor when present. */
export function activitySentence(e: ActivityEvent): string {
  return e.summary || "(no summary)";
}

/** Right-aligned duration chip from meta when the server recorded one. */
export function activityDuration(e: ActivityEvent): string | null {
  const meta = e.meta;
  if (!meta) return null;
  const raw = meta.durationMs ?? meta.duration ?? meta.ms;
  const ms = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

/** Copy-able raw line for the inline expansion. */
export function activityRawLine(e: ActivityEvent): string {
  return JSON.stringify(e);
}

/** Structured fields for the inline expansion (meta flattened, primitives only). */
export function activityFields(e: ActivityEvent): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [
    { key: "kind", value: e.kind },
    { key: "subject", value: e.subject ?? "—" },
    { key: "actor", value: e.attribution?.actor ?? "unknown" },
    { key: "client", value: e.attribution?.client ?? "—" },
  ];
  if (e.meta) {
    for (const [k, v] of Object.entries(e.meta)) {
      if (v == null || typeof v === "object") continue;
      out.push({ key: k, value: String(v) });
    }
  }
  return out;
}
