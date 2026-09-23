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
/** Default per-Spark log directory (active session log lives inside `logs/`). */
export { TABBY_LOG_DEFAULT_DIR };

/** U+00B7 separator used by TabbyAPI's log lines. */
const SEP = "\u00B7";

const TS_RE = "(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3})";

/** COMPLETION line — carries every metric. Draft segment is OPTIONAL. */
const COMPLETION_RE = new RegExp(
  "^" +
    TS_RE +
    "\\s*\\|\\s*INFO.*?#(\\d+)\\s+.*?:\\s*([\\d,]+)\\s+tokens generated at\\s+([\\d.]+)\\s+T/s\\s*" +
    SEP +
    "\\s*prompt\\s+([\\d,]+)\\s+tokens,\\s*(?:(\\d+)%|none)\\s*cached,\\s*([\\d,]+)\\s*new in\\s+([\\d.]+)\\s*s\\s*\\(([\\d.]+)\\s*T/s\\)\\s*" +
    SEP +
    "\\s*first token\\s+([\\d.]+)\\s*s,\\s*total\\s+([\\d.]+)\\s*s" +
    "(?:\\s*" +
    SEP +
    "\\s*draft\\s+(\\d+)/(\\d+)\\s+accepted\\s*\\(\\d+%\\))?"
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
 * Parse the tabby log timestamp (`YYYY-MM-DD HH:MM:SS.mmm`, no TZ) as local ms.
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
  if (
    tsMs == null ||
    id == null ||
    genTps == null ||
    promptTokens == null ||
    cachedPct == null ||
    newTokens == null ||
    prefillSeconds == null ||
    prefillTps == null ||
    ttftSeconds == null ||
    totalSeconds == null
  ) {
    return null;
  }
  return {
    tsMs,
    id,
    genTps,
    promptTokens,
    cachedPct,
    newTokens,
    prefillTps,
    ttftSeconds,
    totalSeconds,
    draftAccepted,
    draftTotal,
  };
}

/**
 * Parse ONE start line into `{ tsMs, id }`. null when it does not match or is
 * malformed (no throw).
 * @param {string} line
 * @returns {null | {tsMs:number,id:number}}
 */
export function parseStartLine(line) {
  if (typeof line !== "string" || !line.trim()) return null;
  const m = START_RE.exec(line);
  if (!m) return null;
  const tsMs = parseTimestamp(m[1]);
  const id = num(m[2]);
  if (tsMs == null || id == null) return null;
  return { tsMs, id };
}

/** Parse a single line as completion-first, then start. null when neither. */
export function parseTabbyLogLine(line) {
  return parseCompletionLine(line) || null;
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

  let windowAvgTps = null;
  let peakTps = null;
  if (recentRequest.length > 0) {
    const tps = recentRequest.map((r) => r.genTps).filter((n) => Number.isFinite(n));
    if (tps.length > 0) {
      peakTps = Math.max(...tps);
      windowAvgTps = Math.round((tps.reduce((a, b) => a + b, 0) / tps.length) * 100) / 100;
      peakTps = Math.round(peakTps * 100) / 100;
    }
  }

  const now = Date.now();
  const stale =
    lastRequestAtMs != null &&
    activeIds.length === 0 &&
    now - lastRequestAtMs > TABBY_LOG_STALE_MS;

  return {
    recentRequest,
    lastRequest,
    active: activeIds.length > 0,
    activeIds,
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
export function applyTabbyLog(entry, log) {
  if (!entry || entry.backend !== "tabbyapi") return entry;
  if (!log || !log.available) {
    // Tail failed / no log: keep the honest "—" (do not invent).
    return entry;
  }
  const provenance = log.file ? `TabbyAPI log (${log.file})` : "TabbyAPI log";
  entry.provenance = provenance;
  entry.lastRequestAtMs = log.lastRequestAtMs ?? null;
  entry.perfStale = !!log.stale;
  entry.requestActive = !!log.active;
  /** The tps/prefill here are LAST-REQUEST values, not a live instantaneous gauge. */
  entry.perfFromLastRequest = !log.active;
  entry.windowAvgTps = log.windowAvgTps ?? null;
  entry.peakTps = log.peakTps ?? null;
  entry.tabbyLog = {
    provenance,
    file: log.file ?? null,
    lastRequestAtMs: log.lastRequestAtMs ?? null,
    stale: !!log.stale,
    active: !!log.active,
    windowAvgTps: log.windowAvgTps ?? null,
    peakTps: log.peakTps ?? null,
  };

  if (log.active) {
    entry.requestsRunning = 1;
    entry.slotsActive = 1;
  } else if (log.lastRequestAtMs != null) {
    // Recent completions known and nothing in flight => a REAL zero.
    entry.requestsRunning = 0;
    entry.slotsActive = 0;
  } else {
    entry.requestsRunning = null;
    entry.slotsActive = null;
  }

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
      windowAvgTps: null,
      peakTps: null,
      lastRequestAtMs: null,
      stale: false,
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
