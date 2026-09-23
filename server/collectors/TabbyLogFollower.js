/**
 * TabbyLogFollower — a LONG-LIVED, READ-ONLY streamer of one Spark's active
 * TabbyAPI log into a continuous in-memory live-inference state (TabbyLogState).
 *
 * WHY: the periodic `tail -n 200` snapshot only refreshed every few seconds and
 * could not tell us a request had STARTED until a later poll happened to catch a
 * completion. This follower keeps ONE persistent SSH connection open running a
 * remote `tail -F` loop that (a) follows appended lines the instant TabbyAPI
 * writes them and (b) re-points when a NEW timestamped log appears (a TabbyAPI
 * launch creates a fresh file, so `tail -F <file>` alone would go blind). The
 * parser folds each line into TabbyLogState, so BUSY lights up on START and
 * completion metrics land the moment the request finishes — no page refresh, no
 * polling window.
 *
 * SAFETY (non-negotiable):
 *   READ-ONLY — the remote command is `ls` + `tail -F` only; it never writes,
 *   rotates, deletes, or signals anything on the Spark.
 *   NO SECRETS — auth is the shared SSH transport (key/agent); no API key is ever
 *   in argv, the stream, or the state.
 *   SINGLE INSTANCE — one follower per Spark, guarded; never a duplicate.
 *   LIFECYCLE — start()/stop() tie it to SparkMonitor; a dropped SSH reconnects
 *   with backoff; the remote loop dies on SIGHUP when the connection closes.
 */
import { spawn } from "child_process";
import { sshCommandSpec } from "./ssh.js";
import { TabbyLogState } from "./TabbyLogProbe.js";

/** Reconnect backoff (ms), growing per consecutive failure, capped. */
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
/** A log line older than this with a live connection is just an idle log, not a fault. */
const IDLE_OK_MS = 5 * 60_000;

/**
 * Build the READ-ONLY remote follow loop.
 *
 * `tail` MUST run in the FOREGROUND: a backgrounded `tail` writing to the SSH
 * pipe is block-buffered by the shell and delivers in minute-long bursts (verified
 * empirically), which is exactly the stale-state failure we are fixing. The
 * foreground `tail -F` streams line-by-line in real time. A tiny background
 * watchdog (writes NOTHING to stdout, so its own buffering is irrelevant) polls
 * for a newer *.log and `pkill`s this exact tail when the active file changes
 * (TabbyAPI relaunch/rotation), so the outer loop re-points. A dead TCP
 * connection is caught by SSH ServerAlive* keepalives (ssh exits → `close` →
 * reconnect), so no heartbeat is needed.
 * @param {string} dir
 * @param {number} seedLines how many trailing lines to replay on (re)point
 */
export function buildFollowCommand(dir, seedLines = 200) {
  const safeDir = String(dir).replace(/'/g, "'\\''");
  return (
    `d='${safeDir}'; ` +
    `while :; do ` +
    `f=$(ls -1t "$d"/*.log 2>/dev/null | head -n 1); ` +
    `if [ -n "$f" ]; then ` +
    `echo "__TABBYFILE__=$(basename -- "$f")"; ` +
    `( while :; do sleep 2; nf=$(ls -1t "$d"/*.log 2>/dev/null | head -n 1); ` +
    `[ "$nf" != "$f" ] && { pkill -f "tail -n ${seedLines} -F -- $f"; break; }; done ) & w=$!; ` +
    `tail -n ${seedLines} -F -- "$f"; ` +
    `kill "$w" 2>/dev/null; wait "$w" 2>/dev/null; ` +
    `else sleep 5; fi; ` +
    `done`
  );
}

export class TabbyLogFollower {
  /**
   * @param {object} spark
   * @param {{ spawnFn?: Function, seedLines?: number }} [opts] injectable spawn (tests)
   */
  constructor(spark, opts = {}) {
    this.spark = spark;
    this._spawn = opts.spawnFn || spawn;
    this._seedLines = Number.isFinite(opts.seedLines) ? opts.seedLines : 200;
    this.state = new TabbyLogState();
    /** @type {import("child_process").ChildProcess | null} */
    this._child = null;
    this._stopped = true;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._buf = "";
    this._connected = false;
    this._lastError = null;
  }

  logDir() {
    const raw = this.spark?.tabbyLogDir;
    const s = typeof raw === "string" ? raw.trim() : "";
    return s || null;
  }

  /** Start (or restart) the follower. No-op when disabled (no log dir). */
  start() {
    this._stopped = false;
    this._spawnChild();
  }

  /** Point at a new Spark config; restart the stream if the target changed. */
  setTarget(spark) {
    const changed =
      spark?.id !== this.spark?.id ||
      spark?.tabbyLogDir !== this.spark?.tabbyLogDir ||
      spark?.ssh?.host !== this.spark?.ssh?.host ||
      spark?.ssh?.user !== this.spark?.ssh?.user;
    this.spark = spark;
    if (changed && !this._stopped) {
      this._killChild();
      this.state = new TabbyLogState();
      this._spawnChild();
    }
  }

  /** Stop the follower + any reconnect. Idempotent. */
  stop() {
    this._stopped = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._killChild();
    this._connected = false;
    this.state.connected = false;
  }

  _killChild() {
    if (this._child) {
      try {
        this._child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      this._child = null;
    }
  }

  _spawnChild() {
    if (this._stopped) return;
    const dir = this.logDir();
    if (!dir) {
      // No log configured — nothing to follow; stay idle (honest absence).
      this._connected = false;
      this.state.connected = false;
      return;
    }
    let spec;
    try {
      // multiplex:false — a long-lived stream must own its connection so killing
      // it tears the channel down; it must not share the short-lived poll master.
      // ServerAlive* makes a silently-dropped TCP connection exit the ssh process
      // (so `close` fires + we reconnect) instead of hanging half-open forever.
      spec = sshCommandSpec(this.spark, {
        remoteArgv: [buildFollowCommand(dir, this._seedLines)],
        multiplex: false,
        extraSshArgs: ["-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3", "-o", "TCPKeepAlive=yes"],
      });
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      this._scheduleReconnect();
      return;
    }

    let child;
    try {
      child = this._spawn(spec.file, spec.args, { env: spec.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      this._scheduleReconnect();
      return;
    }
    this._child = child;
    this._connected = true;
    this.state.connected = true;
    this._buf = "";

    child.stdout?.on("data", (chunk) => this._onData(chunk));
    child.stderr?.on("data", () => {
      /* ssh noise (e.g. control-socket notes) is not data; ignore, never log secrets */
    });
    child.on("error", (err) => {
      this._lastError = err instanceof Error ? err.message : String(err);
    });
    child.on("close", () => {
      if (this._stopped) return;
      this._connected = false;
      this.state.connected = false;
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this._reconnectAttempts);
    this._reconnectAttempts++;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._spawnChild();
    }, delay);
    // Do not keep the event loop alive solely for a reconnect.
    this._reconnectTimer.unref?.();
  }

  /** Line-buffer the stdout stream; dispatch complete lines to the state. */
  _onData(chunk) {
    this._buf += chunk.toString("utf8");
    let nl;
    while ((nl = this._buf.indexOf("\n")) !== -1) {
      const line = this._buf.slice(0, nl);
      this._buf = this._buf.slice(nl + 1);
      this._onLine(line);
    }
    // Bound the buffer against a pathological non-newline flood.
    if (this._buf.length > 1_000_000) this._buf = this._buf.slice(-100_000);
  }

  _onLine(line) {
    if (typeof line !== "string") return;
    const marker = /^__TABBYFILE__=(.*)$/.exec(line);
    if (marker) {
      const file = marker[1].trim() || null;
      // A (re)point resets per-file active/dedupe state inside setFile().
      this.state.setFile(file);
      // And on EVERY (re)connect — even to the same file — drop in-flight state so
      // a completion lost during the gap cannot leave a phantom BUSY; the replay
      // that follows rebuilds it.
      this.state.onReconnect();
      // A fresh connection resets the reconnect backoff once data is flowing.
      this._reconnectAttempts = 0;
      return;
    }
    this.state.ingestLine(line);
  }

  /**
   * Current live snapshot for SparkMonitor. `available` reflects stream health:
   * connected (the SSH follow is up). A quiet log with a live connection is still
   * available — only a dropped connection is an absence.
   * @param {number} [now]
   */
  getState(now = Date.now()) {
    const snap = this.state.snapshot(now);
    const dir = this.logDir();
    const available = Boolean(dir) && this._connected;
    return {
      configured: Boolean(dir),
      available,
      dir: dir ?? null,
      error: available ? null : this._lastError,
      collectedAt: now,
      // A live-but-quiet stream is NOT stale due to liveness; staleness is about
      // the last completion, already computed in the snapshot.
      idleOkMs: IDLE_OK_MS,
      ...snap,
    };
  }
}