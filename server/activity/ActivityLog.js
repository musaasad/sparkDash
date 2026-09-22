/**
 * ActivityLog — the "what changed recently" feed.
 *
 * Honest by construction: events are pushed only from real observed
 * transitions (node online/offline, lifecycle operations, benchmark
 * completions, showcase sessions, console errors). Attribution is whatever
 * the server actually knows; unknown stays null and renders as "unknown".
 *
 * Storage: bounded append-only JSONL (config/activity.jsonl), rewritten when
 * it exceeds the cap. Mirrors the audit trail conventions.
 */
import fs from "fs";
import { atomicWrite } from "../util/atomicWrite.js";
import { ACTIVITY_LOG_PATH } from "../config.js";

const MAX_EVENTS = 2000;

export class ActivityLog {
  /** @param {{ path?: string, maxEvents?: number }} [opts] */
  constructor(opts = {}) {
    this.path = opts.path || ACTIVITY_LOG_PATH;
    this.maxEvents = opts.maxEvents || MAX_EVENTS;
    /** @type {object[]} oldest first */
    this._events = [];
    this._seq = 0;
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.path)) return;
      const lines = fs.readFileSync(this.path, "utf8").split("\n").filter(Boolean);
      for (const l of lines.slice(-this.maxEvents)) {
        try {
          const e = JSON.parse(l);
          if (e && typeof e.kind === "string") {
            this._events.push(e);
            if (typeof e.seq === "number" && e.seq > this._seq) this._seq = e.seq;
          }
        } catch {
          /* skip malformed line */
        }
      }
    } catch (err) {
      console.error("[ActivityLog] load failed:", err.message);
    }
  }

  push({ kind, subject, summary, attribution = null, meta = null }) {
    const event = {
      seq: ++this._seq,
      ts: new Date().toISOString(),
      kind, // node | lifecycle | bench | showcase | console | alert
      subject: subject != null ? String(subject).slice(0, 200) : null,
      summary: String(summary || "").slice(0, 500),
      attribution, // { client?: string, actor?: string } — only what is observed
      meta,
    };
    this._events.push(event);
    if (this._events.length > this.maxEvents) {
      this._events = this._events.slice(-this.maxEvents);
      this._rewrite();
    } else {
      try {
        fs.appendFileSync(this.path, JSON.stringify(event) + "\n", { mode: 0o600 });
      } catch (err) {
        console.error("[ActivityLog] append failed:", err.message);
      }
    }
    return event;
  }

  _rewrite() {
    try {
      atomicWrite(
        this.path,
        this._events.map((e) => JSON.stringify(e)).join("\n") + "\n",
        0o600
      );
    } catch (err) {
      console.error("[ActivityLog] rewrite failed:", err.message);
    }
  }

  /** Newest first, optional kind filter. */
  list({ limit = 100, kinds = null } = {}) {
    const cap = Math.max(1, Math.min(500, limit));
    const allowed = Array.isArray(kinds) && kinds.length ? new Set(kinds) : null;
    const out = [];
    for (let i = this._events.length - 1; i >= 0 && out.length < cap; i--) {
      const e = this._events[i];
      if (allowed && !allowed.has(e.kind)) continue;
      out.push(e);
    }
    return out;
  }
}

export const activityLog = new ActivityLog();