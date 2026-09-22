/**
 * LiveConsole — read-only live view of model-server logs.
 *
 * Streams the newest log file(s) of a recipe's logDir over a dedicated SSH
 * `spawn` running `tail -n N -F` (the buffered sshExec cannot follow). The
 * remote command is built ONLY from a validated recipe logDir via shlexQuote;
 * there is no path by which a client supplies a command.
 *
 * Two views over the same stream:
 *  - Raw: every line with level classification (loguru format).
 *  - Telemetry: parsed request lifecycle records (TabbyAPI/EXL3 format):
 *    request id, prompt/gen tokens, cached %, new prompt tokens, prefill T/s,
 *    TTFT, decode T/s, MTP draft accepted/attempted/acceptance, tool calls,
 *    duration, errors.
 *
 * SAFETY: strictly read-only. Never touches the model process. The log dir
 * grammar is re-checked at spawn time even though recipes are validated at
 * write time (defense in depth).
 */
import { spawn } from "child_process";
import { shlexQuote } from "../util/shlex.js";
import { isValidPosixPath } from "../validate.js";
import { providerFor } from "../domain/providers/registry.js";
import { TabbyApiProvider } from "../domain/providers/tabbyapi.js";

const MAX_BUFFERED_LINES = 2000;
const MAX_TELEMETRY_ROWS = 500;
const TAIL_INITIAL_LINES = 400;

/** Default (TabbyAPI-shaped) provider used by the exported parse helpers. */
const tabby = new TabbyApiProvider();

/**
 * Parse one loguru line. Shaping now lives behind the provider; the collector
 * stays generic. Kept exported (back-compat) for existing tests/consumers.
 */
export function parseLoguruLine(raw) {
  return tabby.parseLogLine(raw);
}

/** Parse one TabbyAPI telemetry payload. Kept exported for back-compat. */
export function parseTelemetryLine(msg) {
  return tabby.parseTelemetryLine(msg);
}

const RE_ERRORISH = /\b(error|exception|traceback|failed|abort)/i;

/** Merge parsed events into per-request telemetry rows (newest first). */
export class TelemetryAggregator {
  constructor(max = MAX_TELEMETRY_ROWS) {
    this.max = max;
    /** @type {Map<number, object>} */
    this.rows = new Map();
    /** @type {number[]} insertion-ordered req ids (oldest first) */
    this.order = [];
  }

  apply(event, ts) {
    if (!event || event.reqId == null) return null;
    let row = this.rows.get(event.reqId);
    if (!row) {
      row = {
        reqId: event.reqId,
        ts: ts || null,
        state: "inflight",
        promptTokens: null,
        generatedTokens: null,
        cachedPct: null,
        newPromptTokens: null,
        prefillTps: null,
        ttftSeconds: null,
        decodeTps: null,
        totalSeconds: null,
        draftAccepted: null,
        draftAttempted: null,
        draftPct: null,
        toolCalls: 0,
        temperature: null,
      };
      this.rows.set(event.reqId, row);
      this.order.push(event.reqId);
      while (this.order.length > this.max) {
        this.rows.delete(this.order.shift());
      }
    }
    if (ts && !row.ts) row.ts = ts;
    switch (event.phase) {
      case "start":
        row.promptTokens = event.promptTokens ?? row.promptTokens;
        row.temperature = event.temperature ?? row.temperature;
        row.state = "inflight";
        break;
      case "tool":
        row.toolCalls += event.toolCalls || 0;
        break;
      case "complete":
        Object.assign(row, {
          generatedTokens: event.generatedTokens,
          decodeTps: event.decodeTps,
          promptTokens: event.promptTokens ?? row.promptTokens,
          cachedPct: event.cachedPct,
          newPromptTokens: event.newPromptTokens,
          prefillTps: event.prefillTps,
          ttftSeconds: event.ttftSeconds,
          totalSeconds: event.totalSeconds,
          draftAccepted: event.draftAccepted,
          draftAttempted: event.draftAttempted,
          draftPct: event.draftPct,
          state: "done",
        });
        break;
    }
    return row;
  }

  listNewestFirst() {
    return [...this.order].reverse().map((id) => this.rows.get(id));
  }
}

/**
 * One console stream per recipe. Spawn is owned by the server, not the
 * browser; multiple subscribers share the same tail and ring buffer.
 */
export class LiveConsoleManager {
  /**
   * @param {{
   *   recipeRegistry: {get:(id:string)=>object|null},
   *   sparkResolver: (nodeId: string) => {ssh: {host: string, user: string}} | null,
   *   onLine?: (recipeId: string, line: object, telemetryRow: object|null) => void,
   *   spawnFn?: Function, // injectable for tests
   * }} opts
   */
  constructor(opts) {
    this.recipeRegistry = opts.recipeRegistry;
    this.sparkResolver = opts.sparkResolver;
    this.onLine = opts.onLine || (() => {});
    this.spawnFn = opts.spawnFn || spawn;
    /** @type {Map<string, {proc: object|null, lines: object[], telemetry: TelemetryAggregator, subscribers: Set<Function>, error: string|null, startedAt: number|null}>} */
    this.streams = new Map();
  }

  _stream(recipeId) {
    let s = this.streams.get(recipeId);
    if (!s) {
      s = {
        proc: null,
        lines: [],
        telemetry: new TelemetryAggregator(),
        subscribers: new Set(),
        error: null,
        startedAt: null,
      };
      this.streams.set(recipeId, s);
    }
    return s;
  }

  /** Build the read-only remote tail command. Exported shape for tests. */
  static buildTailCommand(logDir) {
    if (!isValidPosixPath(logDir)) {
      const err = new Error("recipe logDir failed path validation — refusing to tail");
      err.status = 400;
      throw err;
    }
    // Glob stays outside the quotes so the REMOTE shell expands it; the
    // directory itself is quoted and grammar-validated, so nothing is live.
    return `tail -n ${TAIL_INITIAL_LINES} -F ${shlexQuote(logDir)}/*.log`;
  }

  /**
   * Ensure a tail stream is running for the recipe and register a subscriber.
   * @returns {{ ok: boolean, reason?: string, buffered: object[], telemetry: object[] }}
   */
  subscribe(recipeId, subscriber) {
    const recipe = this.recipeRegistry.get(recipeId);
    if (!recipe) return { ok: false, reason: "recipe not found", buffered: [], telemetry: [] };
    const logDir = recipe.logSource?.path ?? recipe.logDir;
    if (!logDir)
      return { ok: false, reason: "no logDir configured on this recipe", buffered: [], telemetry: [] };
    const spark = this.sparkResolver(recipe.nodeIds?.[0]);
    if (!spark?.ssh?.host || !spark?.ssh?.user)
      return { ok: false, reason: "recipe node is not registered in the fleet", buffered: [], telemetry: [] };

    const s = this._stream(recipeId);
    s.subscribers.add(subscriber);

    if (!s.proc) {
      let cmd;
      try {
        cmd = LiveConsoleManager.buildTailCommand(logDir);
      } catch (err) {
        s.error = err.message;
        return { ok: false, reason: err.message, buffered: s.lines.slice(), telemetry: s.telemetry.listNewestFirst() };
      }
      const remote = `${spark.ssh.user}@${spark.ssh.host}`;
      const args = [
        "-o", "ConnectTimeout=8",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "BatchMode=yes",
        "-o", "ServerAliveInterval=30",
        "--", remote, cmd,
      ];
      try {
        s.proc = this.spawnFn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
        s.startedAt = Date.now();
        s.error = null;
      } catch (err) {
        s.error = `spawn failed: ${err.message}`;
        return { ok: false, reason: s.error, buffered: s.lines.slice(), telemetry: s.telemetry.listNewestFirst() };
      }
      let pending = "";
      s.proc.stdout.on("data", (chunk) => {
        pending += chunk.toString("utf8");
        const parts = pending.split("\n");
        pending = parts.pop();
        for (const rawLine of parts) this._ingest(recipeId, rawLine);
      });
      s.proc.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8").trim();
        if (text && /permission denied|no such|connection|timed out/i.test(text)) {
          s.error = text.split("\n")[0].slice(0, 200);
        }
      });
      s.proc.on("exit", () => {
        s.proc = null;
        s.startedAt = null;
        s.error = s.error || "log stream ended";
      });
      s.proc.on("error", (err) => {
        s.proc = null;
        s.error = `log stream error: ${err.message}`;
      });
    }

    return { ok: true, buffered: s.lines.slice(), telemetry: s.telemetry.listNewestFirst() };
  }

  unsubscribe(recipeId, subscriber) {
    const s = this.streams.get(recipeId);
    if (!s) return;
    s.subscribers.delete(subscriber);
    if (s.subscribers.size === 0 && s.proc) {
      // No viewers: stop the tail. The ring buffer stays warm for re-open.
      try {
        s.proc.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      s.proc = null;
      s.startedAt = null;
    }
  }

  _ingest(recipeId, rawLine) {
    if (rawLine === "") return;
    const s = this._stream(recipeId);
    const recipe = this.recipeRegistry.get(recipeId);
    // Log/telemetry shaping is provider-owned; the collector stays generic.
    const provider = providerFor(recipe?.engine?.runtime ?? recipe?.runtime);
    const line = provider.parseLogLine(rawLine);
    if (line.level === "RAW" || line.level === "raw") line.level = "info";
    if (line.level === "info" && RE_ERRORISH.test(line.msg) && !provider.parseTelemetryLine(line.msg)) {
      line.level = "warn";
    }
    s.lines.push(line);
    while (s.lines.length > MAX_BUFFERED_LINES) s.lines.shift();
    const event = provider.parseTelemetryLine(line.msg);
    const row = event ? s.telemetry.apply(event, line.ts) : null;
    for (const sub of s.subscribers) {
      try {
        sub(line, row);
      } catch {
        /* subscriber failures must not kill the stream */
      }
    }
    this.onLine(recipeId, line, row);
  }

  status(recipeId) {
    const s = this.streams.get(recipeId);
    return {
      streaming: Boolean(s?.proc),
      error: s?.error || null,
      bufferedLines: s?.lines.length || 0,
      startedAt: s?.startedAt || null,
    };
  }

  /** Kill every tail (server shutdown). */
  closeAll() {
    for (const s of this.streams.values()) {
      if (s.proc) {
        try {
          s.proc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        s.proc = null;
      }
    }
  }
}