/**
 * TabbyLogProbe — READ-ONLY metrics from TabbyAPI's own log file.
 *
 * WHY: the DGX Spark Qwen deployment runs a TabbyAPI fork with NO HTTP metrics
 * endpoint (/metrics, /stats, /server_info all 404) and Seq down. The ONLY real
 * inference-perf source is TabbyAPI's console log, which it writes to a file.
 * So we tail the ACTIVE log (newest *.log by mtime in a per-Spark configured
 * directory) over read-only SSH and parse the raw completion lines.
 *
 * READ-ONLY contract: `ls` + `tail` only. Never write/rotate/delete the log,
 * never restart TabbyAPI. Nothing here is a secret.
 *
 * GOLDEN RULE: these are REAL numbers copied out of TabbyAPI's own log, labelled
 * with provenance + timestamp. A missing/failed tail or an unparseable line is
 * null => the UI renders "—", never a fabricated 0.
 */

import { sshExec } from "./ssh.js";
import {
  TABBY_LOG_TAIL_LINES,
  TABBY_LOG_PROBE_TIMEOUT_MS,
  TABBY_LOG_DEFAULT_DIR,
} from "../config.js";

/** Only re-read the log this often; the file can be ~1MB. */
export const TABBY_LOG_CACHE_MS = 4000;
/** A last-request older than this, with nothing in flight, is STALE (historical). */
export const TABBY_LOG_STALE_MS = 5 * 60_000;
/** An in-flight START older than this is assumed lost (tail window/rotation). */
export const TABBY_LOG_ACTIVE_MAX_MS = 30 * 60_000;
/**
 * A START only opens an in-flight slot if its LOG timestamp is within this of the
 * NEWEST timestamp the stream has seen. A live start is ~contemporaneous with the
 * newest line; a START re-fed by a reconnect `tail -n 200` replay whose completion
 * already scrolled out is far older than the newer lines around it — opening it
 * would latch a phantom BUSY. Using the LOG clock (not wall clock) keeps this
 * independent of the node/host clock. Errs toward under-reporting activity.
 */
export const TABBY_LOG_START_FRESH_MS = 120_000;
/**
 * Safety net against a completion line the stream ever fails to deliver: request
 * ids are strictly monotonic, so once we have completed an id this many ABOVE an
 * in-flight start, that start is unambiguously finished (its completion was lost)
 * — close it so BUSY can never latch forever. Sized far above real concurrency
 * (~8) and above any plausible single-request length, so it never prunes a live
 * request; it only reaps provably-dead ones.
 */
export const TABBY_LOG_ACTIVE_ID_SLACK = 1000;
/**
 * How many most-recent COMPLETED requests the perf aggregates span. TabbyAPI has
 * NO live metrics endpoint (console-only status bar), so every perf number is a
 * RECENT-WINDOW aggregate over real log lines — never a live instantaneous value.
 */
export const TABBY_LOG_RECENT_WINDOW_N = 12;
/** Default per-Spark log directory (active session log lives inside `logs/`). */
export { TABBY_LOG_DEFAULT_DIR };

/** U+00B7 separator used by TabbyAPI's log lines. */
const SEP = "\u00B7";

const TS_RE = "(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3})";

/**
 * COMPLETION line — carries every metric.
 * The prefill `(N T/s)` segment is OPTIONAL: a cache-warm completion logs
 * `…N new in 0.68 s · first token…` with NO prefill throughput (nothing to
 * prefill), and previously matched NEITHER this nor START_RE, so it was silently
 * dropped — BUSY latched and the completion never entered the window. The draft
 * segment is OPTIONAL too; its acceptance % is captured for per-request fidelity.
 */
const COMPLETION_RE = new RegExp(
  "^" +
    TS_RE +
    "\\s*\\|\\s*INFO.*?#(\\d+)\\s+.*?:\\s*([\\d,]+)\\s+tokens generated at\\s+([\\d.]+)\\s+T/s\\s*" +
    SEP +
    "\\s*prompt\\s+([\\d,]+)\\s+tokens,\\s*(?:(\\d+)%|none)\\s*cached,\\s*([\\d,]+)\\s*new in\\s+([\\d.]+)\\s*s" +
    "(?:\\s*\\(([\\d.]+)\\s*T/s\\))?\\s*" +
    SEP +
    // A queued request inserts `· queued <N> s,` before the timing segment.
    "(?:\\s*queued\\s+[\\d.]+\\s*s,)?\\s*" +
    "first token\\s+([\\d.]+)\\s*s,\\s*total\\s+([\\d.]+)\\s*s" +
    "(?:\\s*" +
    SEP +
    "\\s*draft\\s+(\\d+)/(\\d+)\\s+accepted\\s*\\((\\d+)%\\))?"
);

/**
 * START line — request begin, no metrics. Real form is
 * `#<id> chat/completions (stream): 184,855 prompt tokens · temperature: …`,
 * i.e. the prompt-token count is followed by an optional word ("prompt") before
 * "tokens", so allow zero-or-more words between the number and the literal
 * "tokens" before the `·` separator. (Only reached when COMPLETION_RE fails, so
 * it can never shadow a completion line.)
 */
const START_RE = new RegExp(
  "^" +
    TS_RE +
    "\\s*\\|\\s*INFO.*?#(\\d+)\\s+.*?:\\s*([\\d,]+)\\s+(?:[a-zA-Z]+\\s+)*tokens\\s*" +
    SEP
);

/**
 * TOOL-CALL line — intermediate per-request activity (a tool loop iterating).
 * Carries NO token count, but is a real LIVENESS heartbeat during a long
 * generation and keeps the owning request's BUSY fresh. INFO level.
 */
const TOOL_RE = new RegExp(
  "^" + TS_RE + "\\s*\\|\\s*INFO.*?#(\\d+)\\s+.*?:\\s*parsed\\s+(\\d+)\\s+tool calls?\\s*\\(([^)]+)\\)"
);

/**
 * CANCEL line — the client disconnected and generation was cancelled (WARNING
 * level). Must close the owning active request, else BUSY latches until the
 * in-flight cap. Previously matched nothing (both other regexes demand INFO).
 */
const CANCEL_RE = new RegExp(
  "^" + TS_RE + "\\s*\\|\\s*WARNING.*?#(\\d+)\\s+.*?:\\s*client disconnected, generation cancelled"
);

/**
 * Parse the tabby log timestamp (`YYYY-MM-DD HH:MM:SS.mmm`, no TZ) as local ms.
 * PRECONDITION: the log stamps carry no timezone and are parsed against the DSH
 * host clock. The staleness rule AND the swap-guard comparison (which checks a
 * completion's stamp against a host `Date.now()` change time) assume the serving
 * node and the DSH host share timezone + a synchronised clock (they do in this
 * single-lab deployment). A node/host TZ mismatch or clock skew would shift every
 * staleness/swap judgment — keep node and host clocks in sync.
 * @param {string} s
 * @returns {number | null}
 */
export function parseTimestamp(s) {
  const ms = Date.parse(String(s).replace(" ", "T"));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Number from a possibly thousands-comma'd string. null (never 0) when absent
 * or non-finite.
 * @param {string | undefined | null} s
 * @returns {number | null}
 */
function num(s) {
  if (s == null) return null;
  const n = Number(String(s).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Round to `digits` decimals (never fabricates). */
function roundN(v, digits) {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

/**
 * Mean of a numeric array, rounded to `digits`; null for an empty array.
 * @param {number[]} arr
 * @param {number} digits
 * @returns {number | null}
 */
function mean(arr, digits) {
  if (arr.length === 0) return null;
  return roundN(arr.reduce((a, b) => a + b, 0) / arr.length, digits);
}

/**
 * Median of a numeric array, rounded to `digits`; null for an empty array.
 * Preferred over the mean for latency/rate metrics: a single cold-cache request
 * (e.g. a 164K-token full prefill taking 278 s to first token) would otherwise
 * drag a mean far above the typical value the operator actually experiences.
 * @param {number[]} arr
 * @param {number} digits
 * @returns {number | null}
 */
function median(arr, digits) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const m = s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return roundN(m, digits);
}

/**
 * Parse ONE completion line into a metric record. null when it does not match
 * or any required number is malformed (no throw).
 * @param {string} line
 * @returns {null | {tsMs:number,id:number,genTps:number,promptTokens:number,cachedPct:number,newTokens:number,prefillTps:number,ttftSeconds:number,totalSeconds:number,draftAccepted:number|null,draftTotal:number|null}}
 */
export function parseCompletionLine(line) {
  if (typeof line !== "string" || !line.trim()) return null;
  const m = COMPLETION_RE.exec(line);
  if (!m) return null;
  const tsMs = parseTimestamp(m[1]);
  const id = num(m[2]);
  const genTps = num(m[4]);
  const promptTokens = num(m[5]);
  // TabbyAPI logs an empty cache as "none cached" (not "0% cached"); map it to 0.
  const cachedPct = m[6] == null ? 0 : num(m[6]);
  const newTokens = num(m[7]);
  const prefillSeconds = num(m[8]);
  const prefillTps = num(m[9]);
  const ttftSeconds = num(m[10]);
  const totalSeconds = num(m[11]);
  const draftAccepted = num(m[12]);
  const draftTotal = num(m[13]);
  const draftPct = num(m[14]);
  if (
    tsMs == null ||
    id == null ||
    genTps == null ||
    promptTokens == null ||
    cachedPct == null ||
    newTokens == null ||
    prefillSeconds == null ||
    ttftSeconds == null ||
    totalSeconds == null
  ) {
    // prefillTps is intentionally NOT required — a cache-warm completion omits
    // the `(N T/s)` prefill segment; leave it null (golden rule: never fabricate).
    return null;
  }
  return {
    tsMs,
    id,
    genTps,
    promptTokens,
    cachedPct,
    newTokens,
    prefillSeconds,
    prefillTps,
    ttftSeconds,
    totalSeconds,
    draftAccepted,
    draftTotal,
    draftPct,
  };
}

/**
 * Parse ONE start line into `{ tsMs, id, promptTokens, maxTokens }`.
 * `promptTokens` (the request's input size) and `maxTokens` (the generation
 * ceiling — a progress denominator) are real emitted values, previously matched
 * then discarded. null when the line does not match.
 * @param {string} line
 * @returns {null | {tsMs:number,id:number,promptTokens:number|null,maxTokens:number|null}}
 */
export function parseStartLine(line) {
  if (typeof line !== "string" || !line.trim()) return null;
  const m = START_RE.exec(line);
  if (!m) return null;
  const tsMs = parseTimestamp(m[1]);
  const id = num(m[2]);
  if (tsMs == null || id == null) return null;
  const promptTokens = num(m[3]);
  const mt = /max_tokens:\s*([\d,]+)/.exec(line);
  const maxTokens = mt ? num(mt[1]) : null;
  return { tsMs, id, promptTokens, maxTokens };
}

/**
 * Parse ONE tool-call activity line into `{ tsMs, id, count, parser }`.
 * @param {string} line
 * @returns {null | {tsMs:number,id:number,count:number,parser:string}}
 */
export function parseToolCallLine(line) {
  if (typeof line !== "string" || !line.trim()) return null;
  const m = TOOL_RE.exec(line);
  if (!m) return null;
  const tsMs = parseTimestamp(m[1]);
  const id = num(m[2]);
  const count = num(m[3]);
  if (tsMs == null || id == null || count == null) return null;
  return { tsMs, id, count, parser: String(m[4]).trim() };
}

/**
 * Parse ONE cancel line into `{ tsMs, id }` (client disconnected).
 * @param {string} line
 * @returns {null | {tsMs:number,id:number}}
 */
export function parseCancelLine(line) {
  if (typeof line !== "string" || !line.trim()) return null;
  const m = CANCEL_RE.exec(line);
  if (!m) return null;
  const tsMs = parseTimestamp(m[1]);
  const id = num(m[2]);
  if (tsMs == null || id == null) return null;
  return { tsMs, id };
}

/**
 * Parse a single line into a typed event: `{kind:"completion"|"start"|"tool"|"cancel", ...}`
 * or null. Completion first (it also contains "prompt tokens", so it must win),
 * then start, then tool-call, then cancel.
 * @param {string} line
 * @returns {null | object}
 */
export function parseTabbyLogLine(line) {
  const c = parseCompletionLine(line);
  if (c) return { kind: "completion", ...c };
  const s = parseStartLine(line);
  if (s) return { kind: "start", ...s };
  const t = parseToolCallLine(line);
  if (t) return { kind: "tool", ...t };
  const x = parseCancelLine(line);
  if (x) return { kind: "cancel", ...x };
  return null;
}

/**
 * RECENT-WINDOW aggregates over a chronological array of completion records.
 * TabbyAPI has no live metrics endpoint, so these are the honest perf readout:
 * real log values aggregated over a window, never a live instantaneous figure.
 * Rate/latency use the MEDIAN (robust to rare cold-cache full-prefill outliers);
 * cache-hit and MTP use a sum-based share. All null when the window is empty —
 * never 0. Shared by the batch parser and the streaming follower.
 * @param {object[]} win chronological completion records (already window-sliced)
 */
export function aggregateWindow(win) {
  let windowAvgTps = null;
  let peakTps = null;
  let recentMedGenTps = null;
  if (win.length > 0) {
    const tps = win.map((r) => r.genTps).filter((n) => Number.isFinite(n));
    if (tps.length > 0) {
      peakTps = roundN(Math.max(...tps), 2);
      windowAvgTps = mean(tps, 2);
      recentMedGenTps = median(tps, 2);
    }
  }
  let recentMedPrefillTps = null;
  let recentMedTtftSeconds = null;
  let recentCacheHitRate = null;
  let recentMtpAcceptance = null;
  if (win.length > 0) {
    recentMedPrefillTps = median(win.map((r) => r.prefillTps).filter((n) => Number.isFinite(n)), 2);
    recentMedTtftSeconds = median(win.map((r) => r.ttftSeconds).filter((n) => Number.isFinite(n)), 2);
    // Cached tokens = promptTokens - newTokens. Sum-based share over the window.
    const promptSum = win.reduce((a, r) => a + r.promptTokens, 0);
    const cachedSum = win.reduce((a, r) => a + (r.promptTokens - r.newTokens), 0);
    if (promptSum > 0) recentCacheHitRate = roundN(cachedSum / promptSum, 4);
    const withDraft = win.filter((r) => r.draftTotal != null && r.draftTotal > 0);
    if (withDraft.length > 0) {
      const accSum = withDraft.reduce((a, r) => a + r.draftAccepted, 0);
      const totSum = withDraft.reduce((a, r) => a + r.draftTotal, 0);
      if (totSum > 0) recentMtpAcceptance = roundN(accSum / totSum, 4);
    }
  }
  return {
    windowAvgTps,
    peakTps,
    recentMedGenTps,
    recentMedPrefillTps,
    recentMedTtftSeconds,
    recentCacheHitRate,
    recentMtpAcceptance,
  };
}

/**
 * TabbyLogState — the CONTINUOUS in-memory live-inference accumulator.
 *
 * A streaming follower feeds it appended log lines (and a seed tail on start);
 * it maintains per-node live request state — BUSY the instant a START lands,
 * active-request accounting closed by COMPLETION or CANCEL, a bounded recent
 * completion ring for the honest window medians — WITHOUT re-reading the file.
 * This is the single live-state engine behind the TabbyAPI telemetry adapter;
 * the batch `parseTabbyLog` shares its aggregation.
 */
export class TabbyLogState {
  constructor({ windowN = TABBY_LOG_RECENT_WINDOW_N, activeMaxMs = TABBY_LOG_ACTIVE_MAX_MS } = {}) {
    this.windowN = windowN;
    this.activeMaxMs = activeMaxMs;
    this.file = null;
    this.connected = false;
    /** Wall-clock ms of the last line received (stream liveness → available). */
    this.lastLineAtMs = null;
    this.linesSeen = 0;
    /** @type {Map<number,{startTsMs:number,startedAtWallMs:number,promptTokens:number|null,maxTokens:number|null,lastActivityWallMs:number}>} */
    this.active = new Map();
    /** @type {object[]} bounded ring of the last windowN completions (chronological). */
    this.recent = [];
    /** @type {Set<number>} completion ids already folded into `recent` this file (dedupe replays). */
    this._seenIds = new Set();
    this.lastStart = null;
    this.lastCompletion = null;
    this.lastToolCall = null;
    this.lastCancel = null;
    this.startedTotal = 0;
    this.completedTotal = 0;
    this.cancelledTotal = 0;
    /** Newest log timestamp seen (the stream's own monotonic clock). */
    this._maxTsMs = null;
    /** Highest completed request id seen (monotonic; drives the orphan reaper). */
    this._maxCompletedId = null;
  }

  /**
   * Point at a (possibly new) log file. A new file = a new TabbyAPI launch = a
   * fresh request-id space and fresh log: clear per-file active + dedupe state.
   * Returns true when the file actually changed.
   * @param {string|null} file
   */
  setFile(file) {
    if (file === this.file) return false;
    this.file = file;
    this.active.clear();
    this._seenIds.clear();
    return true;
  }

  /**
   * Called on EVERY stream (re)connect (the loop re-emits the file marker each
   * time). A reconnect means a delivery gap: any in-flight entry from before the
   * drop can no longer be trusted (its completion may have been written and
   * scrolled out of the replay window while we were disconnected). Clear the
   * in-flight map; the `tail -n 200` replay that follows rebuilds it correctly —
   * a genuinely-running request still has its START in the window with no
   * completion after it, while a finished one has both lines gone or its START
   * deduped against a completion we already saw. Keeps dedupe/window/counters.
   */
  onReconnect() {
    this.active.clear();
  }

  /**
   * Feed one raw log line. Returns true when it produced a state change worth
   * publishing. Never throws.
   * @param {string} line
   */
  ingestLine(line) {
    if (typeof line !== "string" || !line.trim()) return false;
    this.linesSeen++;
    this.lastLineAtMs = Date.now();
    const ev = parseTabbyLogLine(line);
    if (!ev) return false;
    return this.ingestEvent(ev);
  }

  /** Fold one already-parsed typed event. Returns true if state changed. */
  ingestEvent(ev) {
    if (!ev || typeof ev.kind !== "string") return false;
    // The stream's own monotonic clock (log timestamps), captured BEFORE this
    // event advances it so a start can be judged against the lines around it.
    const prevMaxTsMs = this._maxTsMs;
    if (ev.tsMs != null && (this._maxTsMs == null || ev.tsMs > this._maxTsMs)) this._maxTsMs = ev.tsMs;
    switch (ev.kind) {
      case "start": {
        // A START whose completion was ALREADY folded in (e.g. re-fed by a
        // reconnect's `tail -n 200` replay) must NOT re-open — that request is
        // done; re-adding it would orphan it and latch BUSY.
        if (this._seenIds.has(ev.id)) return false;
        // A START far older than the newest line already seen is a replayed start
        // whose completion scrolled out — finished, not in flight. Skip it so it
        // cannot latch a phantom BUSY. Live starts are ~contemporaneous → pass.
        if (ev.tsMs != null && prevMaxTsMs != null && prevMaxTsMs - ev.tsMs > TABBY_LOG_START_FRESH_MS) return false;
        this.startedTotal++;
        this.lastStart = ev;
        // BUSY the instant a request starts — no wait for completion.
        this.active.set(ev.id, {
          startTsMs: ev.tsMs,
          startedAtWallMs: Date.now(),
          promptTokens: ev.promptTokens ?? null,
          maxTokens: ev.maxTokens ?? null,
          lastActivityWallMs: Date.now(),
        });
        return true;
      }
      case "tool": {
        this.lastToolCall = ev;
        const a = this.active.get(ev.id);
        if (a) a.lastActivityWallMs = Date.now(); // liveness heartbeat during a long generation
        return true;
      }
      case "cancel": {
        this.cancelledTotal++;
        this.lastCancel = ev;
        this.active.delete(ev.id); // close the request so BUSY does not latch
        return true;
      }
      case "completion": {
        // Monotonic high-water mark of completed ids (drives the orphan reaper).
        if (typeof ev.id === "number" && (this._maxCompletedId == null || ev.id > this._maxCompletedId)) {
          this._maxCompletedId = ev.id;
        }
        // Dedupe replays: the follower's `tail -n 200` intentionally re-feeds the
        // tail on reconnect/rotation; a duplicate must not skew the medians. Even
        // when deduped, CLOSE any active entry for this id — a replay may have
        // re-added its START, and this completion proves it is finished.
        if (this._seenIds.has(ev.id)) {
          const had = this.active.delete(ev.id);
          return had;
        }
        this._seenIds.add(ev.id);
        this.completedTotal++;
        this.lastCompletion = ev;
        this.recent.push(ev);
        if (this.recent.length > this.windowN) this.recent.shift();
        this.active.delete(ev.id);
        return true;
      }
      default:
        return false;
    }
  }

  /** Drop in-flight starts idle longer than the cap (lost starts on crash/rotation). */
  _pruneActive(now) {
    for (const [id, a] of this.active) {
      if (now - a.lastActivityWallMs > this.activeMaxMs) {
        this.active.delete(id);
        continue;
      }
      // Orphan reaper: if we have completed an id far above this in-flight start,
      // the start is provably finished (its completion line was lost) — close it so
      // BUSY cannot latch even under a rare delivery gap.
      if (
        this._maxCompletedId != null &&
        typeof id === "number" &&
        id < this._maxCompletedId - TABBY_LOG_ACTIVE_ID_SLACK
      ) {
        this.active.delete(id);
      }
    }
  }

  /**
   * Snapshot the live state. Shape-compatible with `parseTabbyLog` output plus
   * LIVE fields (activeCount, elapsedSeconds, lastStart/lastToolCall/lastCancel,
   * stream liveness). All absent values null — never 0.
   * @param {number} [now]
   */
  snapshot(now = Date.now()) {
    this._pruneActive(now);
    const activeIds = [...this.active.keys()].sort((a, b) => a - b);
    const lastRequest = this.recent.length > 0 ? this.recent[this.recent.length - 1] : null;
    const lastRequestAtMs = lastRequest ? lastRequest.tsMs : null;
    const agg = aggregateWindow(this.recent);
    const stale =
      activeIds.length === 0 && lastRequestAtMs != null && now - lastRequestAtMs > TABBY_LOG_STALE_MS;
    const perfMetricsStale =
      this.recent.length === 0 || (lastRequestAtMs != null && now - lastRequestAtMs > TABBY_LOG_STALE_MS);
    // Elapsed of the OLDEST in-flight request, from wall-clock receipt (log stamps
    // carry no TZ — see parseTimestamp precondition).
    let elapsedSeconds = null;
    if (activeIds.length > 0) {
      let oldest = Infinity;
      for (const id of activeIds) {
        const a = this.active.get(id);
        if (a && a.startedAtWallMs < oldest) oldest = a.startedAtWallMs;
      }
      if (Number.isFinite(oldest)) elapsedSeconds = Math.max(0, Math.round(((now - oldest) / 1000) * 10) / 10);
    }
    return {
      connected: this.connected,
      lastLineAtMs: this.lastLineAtMs,
      linesSeen: this.linesSeen,
      file: this.file,
      recentRequest: this.recent,
      lastRequest,
      active: activeIds.length > 0,
      activeIds,
      activeCount: activeIds.length,
      perfMetricsStale,
      recentWindowCount: this.recent.length,
      windowAvgTps: agg.windowAvgTps,
      peakTps: agg.peakTps,
      recentMedGenTps: agg.recentMedGenTps,
      recentMedPrefillTps: agg.recentMedPrefillTps,
      recentMedTtftSeconds: agg.recentMedTtftSeconds,
      recentCacheHitRate: agg.recentCacheHitRate,
      recentMtpAcceptance: agg.recentMtpAcceptance,
      lastRequestId: lastRequest ? lastRequest.id : null,
      lastRequestAtMs,
      stale,
      elapsedSeconds,
      lastStart: this.lastStart,
      lastToolCall: this.lastToolCall,
      lastCancel: this.lastCancel,
      startedTotal: this.startedTotal,
      completedTotal: this.completedTotal,
      cancelledTotal: this.cancelledTotal,
    };
  }
}

/**
 * Parse a raw tail into structured metrics. Chronological. Never throws.
 *
 * `active` = a START id with NO matching COMPLETION still open (bounded by
 * TABBY_LOG_ACTIVE_MAX_MS so an ancient start does not latch forever).
 *
 * @param {string} text
 * @returns {{
 *   recentRequest: object[], lastRequest: object|null,
 *   active: boolean, activeIds: number[],
 *   windowAvgTps: number|null, peakTps: number|null,
 *   recentWindowCount: number, recentMedGenTps: number|null,
 *   recentMedPrefillTps: number|null, recentMedTtftSeconds: number|null,
 *   recentCacheHitRate: number|null, recentMtpAcceptance: number|null,
 *   lastRequestId: number|null,
 *   lastRequestAtMs: number|null, stale: boolean,
 * }}
 */
export function parseTabbyLog(text) {
  const lines = typeof text === "string" ? text.split(/\r?\n/) : [];
  /** @type {object[]} */
  const recentRequest = [];
  /** @type {Map<number, number>} start id -> tsMs */
  const starts = new Map();
  const completedIds = new Set();

  for (const line of lines) {
    const c = parseCompletionLine(line);
    if (c) {
      recentRequest.push(c);
      completedIds.add(c.id);
      continue;
    }
    const s = parseStartLine(line);
    if (s) starts.set(s.id, s.tsMs);
  }

  recentRequest.sort((a, b) => a.tsMs - b.tsMs);
  const lastRequest = recentRequest.length > 0 ? recentRequest[recentRequest.length - 1] : null;
  const lastRequestAtMs = lastRequest ? lastRequest.tsMs : null;

  // In-flight = open start not yet completed, and not so old it must be lost.
  const newestTs = lastRequestAtMs ?? (starts.size > 0 ? Math.max(...starts.values()) : 0);
  const activeIds = [];
  for (const [id, ts] of starts) {
    if (completedIds.has(id)) continue;
    if (newestTs && newestTs - ts > TABBY_LOG_ACTIVE_MAX_MS) continue;
    activeIds.push(id);
  }
  activeIds.sort((a, b) => a - b);

  // RECENT-WINDOW aggregates over the last N completed requests. TabbyAPI has no
  // live metrics endpoint, so these are the honest perf readout: real log values
  // aggregated over a window, never a live instantaneous figure. Rate/latency use
  // the MEDIAN (robust to rare cold-cache full-prefill outliers); cache-hit and
  // MTP use a sum-based share. All null when the window is empty — never 0.
  const win = recentRequest.slice(-TABBY_LOG_RECENT_WINDOW_N);
  const recentWindowCount = win.length;
  const {
    windowAvgTps,
    peakTps,
    recentMedGenTps,
    recentMedPrefillTps,
    recentMedTtftSeconds,
    recentCacheHitRate,
    recentMtpAcceptance,
  } = aggregateWindow(win);
  const lastRequestId = lastRequest ? lastRequest.id : null;

  const now = Date.now();
  const stale =
    lastRequestAtMs != null &&
    activeIds.length === 0 &&
    now - lastRequestAtMs > TABBY_LOG_STALE_MS;
  // The per-request PERF metrics (MTP / cache / TTFT / prefill) come from the
  // last COMPLETED request. They are old whenever that completion is old — even
  // while a NEW request is in flight (active), since metrics are logged only at
  // completion. So this staleness is INDEPENDENT of active, unlike `stale`.
  const perfMetricsStale =
    recentWindowCount === 0 ||
    (lastRequestAtMs != null && now - lastRequestAtMs > TABBY_LOG_STALE_MS);

  return {
    recentRequest,
    lastRequest,
    active: activeIds.length > 0,
    activeIds,
    activeCount: activeIds.length,
    elapsedSeconds: null, // batch tail has no reliable wall-clock receipt time; LIVE elapsed comes from the follower
    perfMetricsStale,
    recentWindowCount,
    recentMedGenTps,
    recentMedPrefillTps,
    recentMedTtftSeconds,
    recentCacheHitRate,
    recentMtpAcceptance,
    lastRequestId,
    windowAvgTps,
    peakTps,
    lastRequestAtMs,
    stale,
  };
}

/**
 * Project a log result onto a tabbyapi LlmProbe snapshot entry, in place.
 * This is where the REAL log numbers become the readout, with provenance and
 * the last-request timestamp so the UI shows history, not a fake live gauge.
 *
 * Every value is null when the log has nothing — never 0.
 *
 * @param {object} entry tabbyapi LlmProbe snapshot
 * @param {object|null} log TabbyLogProbe.probe() result
 * @returns {object} the mutated entry
 */
export function applyTabbyLog(entry, log, modelChangedAtMs = 0) {
  if (!entry || entry.backend !== "tabbyapi") return entry;
  if (!log || !log.available) {
    // Tail failed / no log: keep the honest "—" (do not invent).
    return entry;
  }
  const provenance = log.file ? `TabbyAPI log (${log.file})` : "TabbyAPI log";
  entry.provenance = provenance;
  entry.lastRequestAtMs = log.lastRequestAtMs ?? null;
  entry.perfStale = !!log.stale;
  entry.perfMetricsStale = !!log.perfMetricsStale;
  // Stale-on-swap guard: if a serving-model change was detected and this recent
  // window's last completion predates it, these numbers belong to the PREVIOUS
  // model — never present them as current under the new name. Dim until fresh
  // post-swap traffic lands (lastRequestAtMs newer than the change).
  if (modelChangedAtMs && log.lastRequestAtMs != null && log.lastRequestAtMs < modelChangedAtMs) {
    entry.perfStale = true;
    entry.perfMetricsStale = true;
  }
  entry.requestActive = !!log.active;
  /** The tps/prefill here are LAST-REQUEST values, not a live instantaneous gauge. */
  entry.perfFromLastRequest = !log.active;
  entry.windowAvgTps = log.windowAvgTps ?? null;
  entry.peakTps = log.peakTps ?? null;
  // RECENT-WINDOW aggregates — the honest perf readout (TabbyAPI has no live
  // endpoint). Rate/latency are the window MEDIAN (robust to cold-prefill
  // outliers); cache-hit/MTP are sum-based shares. All null when empty; never 0.
  entry.recentWindowCount = log.recentWindowCount ?? 0;
  entry.recentMedGenTps = log.recentMedGenTps ?? null;
  entry.recentMedPrefillTps = log.recentMedPrefillTps ?? null;
  entry.recentMedTtftSeconds = log.recentMedTtftSeconds ?? null;
  entry.recentCacheHitRate = log.recentCacheHitRate ?? null;
  entry.recentMtpAcceptance = log.recentMtpAcceptance ?? null;
  entry.lastRequestId = log.lastRequestId ?? null;
  entry.tabbyLog = {
    provenance,
    file: log.file ?? null,
    lastRequestAtMs: log.lastRequestAtMs ?? null,
    stale: !!log.stale,
    perfMetricsStale: !!log.perfMetricsStale,
    active: !!log.active,
    recentWindowCount: log.recentWindowCount ?? 0,
    recentMedGenTps: log.recentMedGenTps ?? log.windowAvgTps ?? null,
    recentMedPrefillTps: log.recentMedPrefillTps ?? null,
    recentMedTtftSeconds: log.recentMedTtftSeconds ?? null,
    recentCacheHitRate: log.recentCacheHitRate ?? null,
    recentMtpAcceptance: log.recentMtpAcceptance ?? null,
    lastRequestId: log.lastRequestId ?? null,
    windowAvgTps: log.windowAvgTps ?? null,
    peakTps: log.peakTps ?? null,
    activeRequests: Number.isFinite(log.activeCount) ? log.activeCount : log.active ? 1 : 0,
    requestElapsedSeconds: log.active ? log.elapsedSeconds ?? null : null,
    lastRequestDetail: entry.lastRequestDetail ?? null,
    activeRequest: entry.activeRequest ?? null,
    activeIds: Array.isArray(log.activeIds) ? log.activeIds : [],
  };

  if (log.active) {
    // Real concurrent count from the follower's active-request map (was hardcoded 1).
    const n = Number.isFinite(log.activeCount) ? log.activeCount : log.activeIds?.length ?? 1;
    entry.requestsRunning = n > 0 ? n : 1;
    entry.slotsActive = entry.requestsRunning;
  } else if (log.lastRequestAtMs != null) {
    // Recent completions known and nothing in flight => a REAL zero.
    entry.requestsRunning = 0;
    entry.slotsActive = 0;
  } else {
    entry.requestsRunning = null;
    entry.slotsActive = null;
  }

  // ── LIVE request state (from the continuous follower) ──
  // These are genuinely live: BUSY the instant a START lands, active count, and
  // elapsed wall-clock of the oldest in-flight request. Throughput is NOT live
  // (TabbyAPI emits decode tok/s only at completion) — see perfFromLastRequest.
  entry.activeRequests = Number.isFinite(log.activeCount) ? log.activeCount : log.active ? 1 : 0;
  entry.requestElapsedSeconds = log.active ? log.elapsedSeconds ?? null : null;
  entry.telemetrySource = "tabbyapi-log-stream";
  // Per-request LIVE detail of the most recent completion (null-safe).
  const lrDetail = log.lastRequest;
  entry.lastRequestDetail = lrDetail
    ? {
        id: lrDetail.id ?? null,
        genTps: lrDetail.genTps ?? null,
        prefillTps: lrDetail.prefillTps ?? null,
        prefillSeconds: lrDetail.prefillSeconds ?? null,
        ttftSeconds: lrDetail.ttftSeconds ?? null,
        totalSeconds: lrDetail.totalSeconds ?? null,
        promptTokens: lrDetail.promptTokens ?? null,
        newTokens: lrDetail.newTokens ?? null,
        cachedPct: lrDetail.cachedPct ?? null,
        draftAccepted: lrDetail.draftAccepted ?? null,
        draftTotal: lrDetail.draftTotal ?? null,
        draftPct: lrDetail.draftPct ?? null,
      }
    : null;
  // LIVE in-flight request context (prompt size / generation ceiling) when active.
  entry.activeRequest =
    log.active && log.lastStart
      ? {
          id: log.lastStart.id ?? null,
          promptTokens: log.lastStart.promptTokens ?? null,
          maxTokens: log.lastStart.maxTokens ?? null,
          elapsedSeconds: log.elapsedSeconds ?? null,
        }
      : null;

  const lr = log.lastRequest;
  if (lr) {
    entry.generationTps = lr.genTps;
    entry.prefillTps = lr.prefillTps;
    entry.ttftSeconds = lr.ttftSeconds;
    entry.prefixCacheHitRate = Math.round((lr.cachedPct / 100) * 10000) / 10000;
    entry.mtpAcceptanceRate =
      lr.draftTotal != null && lr.draftTotal > 0
        ? Math.round((lr.draftAccepted / lr.draftTotal) * 10000) / 10000
        : null;
  }
  // Cumulative output tokens are not derivable from a 200-line tail.
  entry.totalOutputTokens = null;
  return entry;
}

/**
 * READ-ONLY probe of the ACTIVE TabbyAPI log for one Spark.
 *
 * `probe()` returns an honest absence object (never throws) when the directory
 * is unconfigured or the SSH tail fails.
 */
export class TabbyLogProbe {
  /**
   * @param {object} spark
   * @param {(spark: object, cmd: string, opts?: object) => Promise<string>} [sshExecFn]
   *   Injectable executor (defaults to the shared read-only sshExec) — lets the
   *   tests stay hermetic with no real SSH.
   */
  constructor(spark, sshExecFn = sshExec) {
    this.spark = spark;
    this._sshExec = sshExecFn;
    /** @type {object | null} */
    this._cache = null;
    this._cacheAt = 0;
  }

  setTarget(spark) {
    if (spark !== this.spark) {
      this.spark = spark;
      this._cache = null;
      this._cacheAt = 0;
    }
  }

  /** Configured log directory, or null when absent. */
  logDir() {
    const raw = this.spark?.tabbyLogDir;
    const s = typeof raw === "string" ? raw.trim() : "";
    return s || null;
  }

  /** Honest empty result. */
  _empty(configured, error) {
    return {
      configured,
      available: false,
      dir: this.logDir(),
      file: null,
      error: error ?? null,
      collectedAt: Date.now(),
      recentRequest: [],
      lastRequest: null,
      active: false,
      activeIds: [],
      recentWindowCount: 0,
      recentMedGenTps: null,
      recentMedPrefillTps: null,
      recentMedTtftSeconds: null,
      recentCacheHitRate: null,
      recentMtpAcceptance: null,
      lastRequestId: null,
      windowAvgTps: null,
      peakTps: null,
      lastRequestAtMs: null,
      stale: false,
      perfMetricsStale: true,
    };
  }

  /**
   * Read-only tail of the newest *.log. Cached briefly so a 1MB file is not
   * re-read every poll.
   * @returns {Promise<object>}
   */
  async probe() {
    const dir = this.logDir();
    if (!dir) return this._empty(false, "No TabbyAPI log directory configured");

    const now = Date.now();
    if (this._cache && now - this._cacheAt < TABBY_LOG_CACHE_MS) return this._cache;

    // READ-ONLY: newest log by mtime, then tail the last N lines. No writes.
    const safeDir = dir.replace(/'/g, "'\\''");
    const cmd =
      `dir='${safeDir}'; ` +
      `f=$(ls -1t "$dir"/*.log 2>/dev/null | head -n 1); ` +
      `if [ -z "$f" ]; then echo "__TABBYFILE__="; else ` +
      `echo "__TABBYFILE__=$(basename -- "$f")"; tail -n ${TABBY_LOG_TAIL_LINES} -- "$f"; fi`;

    let text;
    try {
      text = await this._sshExec(this.spark, cmd, { timeoutMs: TABBY_LOG_PROBE_TIMEOUT_MS });
    } catch (err) {
      const empty = this._empty(true, err instanceof Error ? err.message : String(err));
      this._cache = empty;
      this._cacheAt = now;
      return empty;
    }

    let file = null;
    let body = text;
    const firstNl = text.indexOf("\n");
    const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
    const marker = firstLine.match(/^__TABBYFILE__=(.*)$/);
    if (marker) {
      file = marker[1].trim() || null;
      body = firstNl === -1 ? "" : text.slice(firstNl + 1);
    }

    const parsed = parseTabbyLog(body);
    const out = {
      configured: true,
      available: true,
      dir,
      file,
      error: null,
      collectedAt: now,
      ...parsed,
    };
    this._cache = out;
    this._cacheAt = now;
    return out;
  }
}
