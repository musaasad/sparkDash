import type { ConsoleLine, ConsoleTelemetryRow, DeploymentStatus } from "../../api/types";

/**
 * Pure Live Console model — query parsing, filter pipeline, follow/pause
 * reducer, histogram bucketing, outlier thresholds and JSONL export.
 *
 * Everything here is side-effect free so the component stays a thin renderer
 * and the behaviour is directly unit-testable. Filtering is client-side and
 * instant: changing a filter NEVER re-subscribes / restarts the server tail.
 */

export type Severity = "debug" | "info" | "warn" | "error";

/**
 * Stream state: a recipe with no logDir is merely unconfigured (neutral info —
 * vLLM containerized logs), never a disconnect. Only a configured recipe whose
 * WS/SSH dropped is a real disconnect with a Reconnect action.
 */
export type StreamState = "streaming" | "not-configured" | "disconnected";

export function streamState(logDir: string | null, connected: boolean): StreamState {
  if (!logDir) return "not-configured";
  return connected ? "streaming" : "disconnected";
}
export const SEVERITIES: readonly Severity[] = ["debug", "info", "warn", "error"];

export interface ParsedQuery {
  reqId: number | null;
  model: string | null;
  node: string | null;
  /** Free-text AND terms (case-insensitive substring match). */
  terms: string[];
  /** Active severity facets; empty set = all severities. */
  severity: Set<Severity>;
}

export const EMPTY_QUERY: ParsedQuery = Object.freeze({
  reqId: null,
  model: null,
  node: null,
  terms: [] as string[],
  severity: new Set<Severity>(),
});

/** One console row with its owning deployment context attached. */
export interface ConsoleRow {
  key: string;
  recipeId: string;
  modelId: string;
  nodeIds: string[];
  ts: number | null;
  level: Severity;
  row: ConsoleTelemetryRow;
  rawText: string;
}

const LEVEL_MAP: Record<string, Severity> = {
  trace: "debug",
  debug: "debug",
  info: "info",
  notice: "info",
  success: "info",
  warn: "warn",
  warning: "warn",
  error: "error",
  critical: "error",
  fatal: "error",
};

export function severityOf(level: string | null | undefined): Severity {
  return LEVEL_MAP[String(level ?? "info").toLowerCase()] ?? "info";
}

/**
 * Parse the toolbar query. Field prefixes are `reqId:`, `model:` and `node:`;
 * everything else is a free-text term. Prefix tokens without a value fall back
 * to free text so typing "reqId:" never empties the table.
 */
export function parseQuery(input: string): ParsedQuery {
  const q: ParsedQuery = { reqId: null, model: null, node: null, terms: [], severity: new Set() };
  for (const token of input.trim().split(/\s+/)) {
    if (!token) continue;
    const idx = token.indexOf(":");
    if (idx > 0) {
      const field = token.slice(0, idx).toLowerCase();
      const value = token.slice(idx + 1);
      if (!value) {
        q.terms.push(token);
        continue;
      }
      if (field === "reqid" || field === "req") {
        const n = Number(value.replace(/^#/, ""));
        if (Number.isFinite(n)) q.reqId = n;
        else q.terms.push(value);
      } else if (field === "model") {
        q.model = value.toLowerCase();
      } else if (field === "node") {
        q.node = value.toLowerCase();
      } else {
        q.terms.push(token);
      }
      continue;
    }
    q.terms.push(token.toLowerCase());
  }
  return q;
}

export interface TimeWindow {
  /** epoch ms inclusive lower bound, null = unbounded */
  from: number | null;
  /** epoch ms inclusive upper bound, null = unbounded */
  to: number | null;
}

export const ALL_WINDOW: TimeWindow = Object.freeze({ from: null, to: null });

export type WindowChip = "15m" | "1h" | "24h" | "all";
export const WINDOW_CHIPS: readonly WindowChip[] = ["15m", "1h", "24h", "all"];
const WINDOW_MS: Record<Exclude<WindowChip, "all">, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "24h": 24 * 60 * 60_000,
};

export function rangeForWindow(chip: WindowChip, now: number): TimeWindow {
  if (chip === "all") return ALL_WINDOW;
  return { from: now - WINDOW_MS[chip], to: now };
}

export function windowLabel(w: TimeWindow): string {
  if (w.from === null && w.to === null) return "All retained";
  const fmt = (t: number) => new Date(t).toISOString().slice(11, 19) + "Z";
  return `${w.from === null ? "start" : fmt(w.from)} → ${w.to === null ? "now" : fmt(w.to)}`;
}

/** Resolved, absolute range restated for the toolbar (global design rule 7). */
export function describeRange(w: TimeWindow): string {
  if (w.from === null && w.to === null) return "All retained";
  const d = (t: number) => new Date(t).toISOString().slice(0, 19).replace("T", " ") + "Z";
  return `${w.from === null ? "beginning" : d(w.from)} — ${w.to === null ? "now" : d(w.to)}`;
}

/** True when a row passes the query + window. */
export function matchesRow(row: ConsoleRow, q: ParsedQuery, w: TimeWindow): boolean {
  const { reqId, model, node, severity, terms } = q;
  if (reqId !== null && row.row.reqId !== reqId) return false;
  if (model && !row.modelId.toLowerCase().includes(model)) return false;
  if (node && !row.nodeIds.some((n) => n.toLowerCase().includes(node))) return false;
  if (severity.size && !severity.has(row.level)) return false;
  if (w.from !== null && row.ts !== null && row.ts < w.from) return false;
  if (w.to !== null && row.ts !== null && row.ts > w.to) return false;
  if (terms.length) {
    const hay = `${row.row.reqId} ${row.modelId} ${row.nodeIds.join(" ")} ${row.rawText}`.toLowerCase();
    for (const term of q.terms) if (!hay.includes(term)) return false;
  }
  return true;
}

export function filterRows(rows: readonly ConsoleRow[], q: ParsedQuery, w: TimeWindow): ConsoleRow[] {
  return rows.filter((r) => matchesRow(r, q, w));
}

export function hasActiveQuery(q: ParsedQuery, w: TimeWindow): boolean {
  return q.reqId !== null || !!q.model || !!q.node || q.terms.length > 0 || q.severity.size > 0 || w.from !== null || w.to !== null;
}

export function countBySeverity(rows: readonly ConsoleRow[]): Record<Severity, number> {
  const out: Record<Severity, number> = { debug: 0, info: 0, warn: 0, error: 0 };
  for (const r of rows) out[r.level]++;
  return out;
}

export interface Bucket {
  start: number;
  end: number;
  total: number;
  errors: number;
}

/** Fixed-width time buckets across the window (the scrubber). */
export function bucketize(rows: readonly ConsoleRow[], w: TimeWindow, now: number, bucketCount = 40): Bucket[] {
  let from = w.from;
  let to = w.to ?? now;
  if (from === null) {
    const stamps = rows.map((r) => r.ts).filter((t): t is number => t !== null);
    from = stamps.length ? Math.min(...stamps) : to - 15 * 60_000;
  }
  const span = Math.max(to - from, 1);
  const step = span / bucketCount;
  const buckets: Bucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    start: from! + i * step,
    end: from! + (i + 1) * step,
    total: 0,
    errors: 0,
  }));
  for (const r of rows) {
    if (r.ts === null) continue;
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((r.ts - from!) / step)));
    buckets[idx].total++;
    if (r.level === "error") buckets[idx].errors++;
  }
  return buckets;
}

/** p-th percentile of a numeric series (nearest-rank). */
export function percentile(values: readonly number[], p: number): number | null {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const idx = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1));
  return nums[idx];
}

export interface OutlierThresholds {
  ttft: number | null;
  decode: number | null;
}

/** p90 thresholds; a threshold only exists once there are enough samples. */
export function outlierThresholds(rows: readonly ConsoleRow[]): OutlierThresholds {
  if (rows.length < 5) return { ttft: null, decode: null };
  return {
    ttft: percentile(rows.map((r) => r.row.ttftSeconds ?? NaN).filter((v) => Number.isFinite(v)), 90),
    decode: percentile(rows.map((r) => r.row.decodeTps ?? NaN).filter((v) => Number.isFinite(v)), 90),
  };
}

export function isOutlier(row: ConsoleRow, t: OutlierThresholds): boolean {
  const ttft = row.row.ttftSeconds;
  const decode = row.row.decodeTps;
  return (t.ttft !== null && ttft !== null && ttft >= t.ttft) || (t.decode !== null && decode !== null && decode >= t.decode);
}

// ─── Follow / pause stream state ────────────────────────────────────────────
export interface FollowState {
  following: boolean;
  unseen: number;
  lastSync: number | null;
}

export const INITIAL_FOLLOW: FollowState = Object.freeze({ following: true, unseen: 0, lastSync: null });

export type FollowAction =
  | { type: "append"; at: number }
  | { type: "scroll"; atBottom: boolean }
  | { type: "pause" }
  | { type: "resume"; at?: number };

/**
 * Follow-tail reducer. Scrolling up auto-pauses; returning to the bottom or
 * pressing resume re-follows. Appends keep lastSync fresh and count unseen
 * rows only while paused (and never while following).
 */
export function reduceFollow(state: FollowState, action: FollowAction): FollowState {
  switch (action.type) {
    case "append": {
      const unseen = state.following ? 0 : state.unseen + 1;
      return { following: state.following, unseen, lastSync: action.at };
    }
    case "scroll":
      if (action.atBottom) return { following: true, unseen: 0, lastSync: state.lastSync };
      if (!state.following) return state;
      return { following: false, unseen: state.unseen, lastSync: state.lastSync };
    case "pause":
      return state.following ? { ...state, following: false } : state;
    case "resume":
      return { ...state, following: true, unseen: 0, lastSync: action.at ?? state.lastSync };
  }
}

// ─── Fixed-order metric chips ────────────────────────────────────────────────
export interface MetricChip {
  key: string;
  label: string;
  text: string;
  /** true when the store actually parsed a value for this field */
  present: boolean;
}

const num = (v: number | null, digits = 0): string => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(digits));
const secs = (v: number | null): string => (v == null ? "—" : `${v.toFixed(2)}s`);

/**
 * Chips in FIXED order. Absent parsed fields become a muted em-dash — a field
 * is never fabricated.
 */
export function metricChips(row: ConsoleTelemetryRow): MetricChip[] {
  const chip = (key: string, label: string, text: string, present: boolean): MetricChip => ({
    key,
    label,
    text,
    present,
  });
  return [
    chip("prompt", "prompt", num(row.promptTokens), row.promptTokens != null),
    chip("gen", "gen", num(row.generatedTokens), row.generatedTokens != null),
    chip("cached", "cached", row.cachedPct == null ? "—" : `${num(row.cachedPct)}%`, row.cachedPct != null),
    chip("prefill", "prefill", row.prefillTps == null ? "—" : `${num(row.prefillTps)} t/s`, row.prefillTps != null),
    chip("ttft", "ttft", row.ttftSeconds == null ? "—" : `${num(row.ttftSeconds * 1000)}ms`, row.ttftSeconds != null),
    chip("decode", "decode", row.decodeTps == null ? "—" : `${num(row.decodeTps, 1)} t/s`, row.decodeTps != null),
    chip(
      "mtp",
      "MTP",
      row.draftAccepted == null || row.draftAttempted == null ? "—" : `${row.draftAccepted}/${row.draftAttempted}`,
      row.draftAccepted != null && row.draftAttempted != null
    ),
    chip("tools", "tools", row.toolCalls ? String(row.toolCalls) : "—", row.toolCalls > 0),
    chip("duration", "duration", secs(row.totalSeconds), row.totalSeconds != null),
  ];
}

// ─── Expanded-row payloads ───────────────────────────────────────────────────
export interface FieldEntry {
  key: string;
  label: string;
  value: string;
}

/** Structured field table for the Parsed half of the row drawer. */
export function fieldTable(row: ConsoleTelemetryRow): FieldEntry[] {
  return [
    { key: "reqId", label: "reqId", value: String(row.reqId) },
    { key: "ts", label: "timestamp", value: row.ts ?? "—" },
    { key: "state", label: "state", value: row.state },
    { key: "promptTokens", label: "prompt tokens", value: num(row.promptTokens) },
    { key: "generatedTokens", label: "generated tokens", value: num(row.generatedTokens) },
    { key: "cachedPct", label: "cached %", value: row.cachedPct == null ? "—" : `${num(row.cachedPct)}%` },
    { key: "newPromptTokens", label: "new prompt tokens", value: num(row.newPromptTokens) },
    { key: "prefillTps", label: "prefill tok/s", value: num(row.prefillTps) },
    { key: "ttftSeconds", label: "TTFT ms", value: num(row.ttftSeconds == null ? null : row.ttftSeconds * 1000) },
    { key: "decodeTps", label: "decode tok/s", value: num(row.decodeTps, 1) },
    { key: "draft", label: "MTF accepted/attempted", value: row.draftAccepted == null ? "—" : `${row.draftAccepted}/${row.draftAttempted ?? "—"}` },
    { key: "draftPct", label: "MTF %", value: row.draftPct == null ? "—" : `${row.draftPct}%` },
    { key: "toolCalls", label: "tool calls", value: String(row.toolCalls) },
    { key: "temperature", label: "temperature", value: num(row.temperature, 2) },
    { key: "totalSeconds", label: "duration", value: secs(row.totalSeconds) },
  ];
}

export type HighlightKind = "level" | "num" | "key" | "plain";

/** Tokenize a raw log line so the Raw pane can highlight structure. */
export function highlightTokens(raw: string): { text: string; kind: HighlightKind }[] {
  const out: { text: string; kind: HighlightKind }[] = [];
  const re = /([A-Z]{3,8}\b)|(\b\d+(?:\.\d+)?\b)|([a-zA-Z_][a-zA-Z0-9_]*(?==))|(\s+|\S)/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) out.push({ text: raw.slice(last, m.index), kind: "plain" });
    const kind: HighlightKind = m[1] ? "level" : m[2] ? "num" : m[3] ? "key" : "plain";
    out.push({ text: m[0], kind });
    last = m.index + m[0].length;
  }
  if (last < raw.length) out.push({ text: raw.slice(last), kind: "plain" });
  return out;
}

// ─── Export ─────────────────────────────────────────────────────────────────
/** One JSON object per line for the current query (client-side blob). */
export function toJsonl(rows: readonly ConsoleRow[]): string {
  return rows
    .map((r) =>
      JSON.stringify({
        ts: r.ts === null ? null : new Date(r.ts).toISOString(),
        level: r.level,
        reqId: r.row.reqId,
        recipeId: r.recipeId,
        modelId: r.modelId,
        nodeIds: r.nodeIds,
        state: r.row.state,
        promptTokens: r.row.promptTokens,
        generatedTokens: r.row.generatedTokens,
        cachedPct: r.row.cachedPct,
        newPromptTokens: r.row.newPromptTokens,
        prefillTps: r.row.prefillTps,
        ttftSeconds: r.row.ttftSeconds,
        decodeTps: r.row.decodeTps,
        draftAccepted: r.row.draftAccepted,
        draftAttempted: r.row.draftAttempted,
        draftPct: r.row.draftPct,
        toolCalls: r.row.toolCalls,
        totalSeconds: r.row.totalSeconds,
        temperature: r.row.temperature,
        raw: r.rawText,
      })
    )
    .join("\n");
}

/** Plain-text copy of visible filtered rows. */
export function toCopyText(rows: readonly ConsoleRow[]): string {
  return rows.map((r) => r.rawText || `${r.ts === null ? "" : new Date(r.ts).toISOString()} [${r.level}] #${r.row.reqId}`).join("\n");
}

// ─── Sources ─────────────────────────────────────────────────────────────────
export interface ConsoleSource {
  label: string;
  recipeIds: string[];
  modelIds: string[];
  nodeIds: string[];
}

/**
 * Enclosure label for a console tab — derived purely from entity data:
 * a distributed deployment groups by its node span, a single node by model id.
 */
export function sourceLabel(nodeIds: readonly string[], modelId: string): string {
  if (nodeIds.length > 1) return `TP${nodeIds.length}`;
  return modelId || nodeIds[0] || "console";
}

/** Build source tabs: one per deployment enclosure, plus a trailing "All". */
export function buildSources(deployments: readonly DeploymentStatus[], fallbackRecipeId: string | null): ConsoleSource[] {
  const groups = new Map<string, ConsoleSource>();
  for (const d of deployments) {
    const label = sourceLabel(d.nodeIds, d.modelId);
    const g = groups.get(label) ?? { label, recipeIds: [], modelIds: [], nodeIds: [] };
    if (!g.recipeIds.includes(d.recipeId)) g.recipeIds.push(d.recipeId);
    if (!g.modelIds.includes(d.modelId)) g.modelIds.push(d.modelId);
    for (const n of d.nodeIds) if (!g.nodeIds.includes(n)) g.nodeIds.push(n);
    groups.set(label, g);
  }
  const sources = [...groups.values()];
  if (!sources.length && fallbackRecipeId) {
    sources.push({ label: "console", recipeIds: [fallbackRecipeId], modelIds: [], nodeIds: [] });
  }
  const allRecipes = sources.flatMap((s) => s.recipeIds);
  if (allRecipes.length) {
    sources.push({
      label: "All",
      recipeIds: [...new Set(allRecipes)],
      modelIds: [...new Set(sources.flatMap((s) => s.modelIds))],
      nodeIds: [...new Set(sources.flatMap((s) => s.nodeIds))],
    });
  }
  return sources;
}

/** Which source tab owns a recipe (default tab for the focused deployment). */
export function sourceForRecipe(sources: readonly ConsoleSource[], recipeId: string | null): string {
  if (!recipeId) return sources[0]?.label ?? "All";
  return sources.find((s) => s.recipeIds.includes(recipeId))?.label ?? sources[0]?.label ?? "All";
}

/** Merge a raw console line + its parsed telemetry row into a ConsoleRow. */
export function toConsoleRow(
  recipeId: string,
  modelId: string,
  nodeIds: readonly string[],
  row: ConsoleTelemetryRow,
  rawText: string
): ConsoleRow {
  return {
    key: `${recipeId}:${row.reqId}`,
    recipeId,
    modelId,
    nodeIds: [...nodeIds],
    ts: row.ts ? Date.parse(row.ts) || null : null,
    level: severityOf(rawText.match(/\b(DEBUG|INFO|WARN|WARNING|ERROR|CRITICAL)\b/)?.[1]),
    row,
    rawText,
  };
}

/**
 * Anchored reqId extraction. The server emits request lines that either start
 * with a `#NNN` token or carry a `reqId`/`req=NNN` field; ports, IPs and token
 * counts must NOT be misread as ids. Returns the numeric id or null.
 */
const REQ_ID_FIELD_RE = /\breq(?:Id|_id)?[:= ]\s*#?(\d{1,10})\b/i;
const REQ_ID_HASH_RE = /(?:^|\s)#(\d{1,10})\b/;

export function extractReqId(raw: string): number | null {
  const m = REQ_ID_FIELD_RE.exec(raw) ?? REQ_ID_HASH_RE.exec(raw);
  return m ? Number(m[1]) : null;
}

/**
 * Index raw lines by their ANCHORED reqId so each telemetry row keeps its
 * original log line and cannot bind to an unrelated digit run.
 */
export function indexRawLines(lines: readonly { recipeId: string; line: ConsoleLine }[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const { recipeId, line } of lines) {
    const id = extractReqId(line.raw);
    if (id === null) continue;
    const key = `${recipeId}:${id}`;
    if (!map.has(key)) map.set(key, line.raw);
  }
  return map;
}
