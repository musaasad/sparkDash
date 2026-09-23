/**
 * WeightsScanService — BOUNDED, READ-ONLY local weight discovery.
 *
 * Purpose: let an operator register a model that ALREADY HAS weight files on
 * disk, without retyping an absolute path from memory. The scan looks ONLY at
 * paths that are already CONFIGURED:
 *   1. settings.weightsDirs  — operator-configured weight directories
 *   2. every model.weightPaths value — the existing registry's configured paths
 *   3. optional ad-hoc dirs the operator types in the wizard (still bounded)
 *
 * SAFETY (non-negotiable):
 *  - `readdir`/`stat` only. No writes, no copy/move, no process touched.
 *  - NEVER a whole-filesystem sweep: a bounded BFS over ≤ MAX_TARGET_DIRS
 *    targets and ≤ MAX_VISITED_DIRS directories, ≤ MAX_MATCHES matches.
 *  - Degrades gracefully: a missing/unreadable directory is reported as missing
 *    and the scan still returns. `configured:false` when no dir is configured —
 *    an honest state, never a fake empty success.
 *  - Never fabricates: family is NOT derived from a filename; only the real
 *    path/name/size are reported, each with provenance.
 */

import fs from "fs";
import path from "path";

/** Hard bounds — deliberately small, never a sweep. */
const MAX_TARGET_DIRS = 8;
const MAX_VISITED_DIRS = 24;
const MAX_MATCHES = 200;
const MAX_ENTRIES_PER_DIR = 400;

/** Suffixes that ARE weight artifacts. */
const WEIGHT_FILE_RE = /\.(gguf|safetensors|bin|pt|pth|onnx|exl3|awq|gptq|npz)$/i;
/** Shard / index sidecar files (e.g. model-00001-of-00004.safetensors, *.safetensors.index.json). */
const WEIGHT_SIDECAR_RE = /\.(safetensors|gguf)\.index\.json$/i;

export const isWeightFile = (name) => WEIGHT_FILE_RE.test(name) || WEIGHT_SIDECAR_RE.test(name);

/** Absolute POSIX path only; anything else is skipped honestly. */
const isAbsPosix = (p) => typeof p === "string" && p.trim().startsWith("/");

const uniq = (list) => [...new Set(list.filter(Boolean))];

export class WeightsScanService {
  /**
   * @param {{
   *   getConfiguredDirs?: () => string[],
   *   readdirFn?: (dir: string, opts: {withFileTypes: true}) => fs.Dirent[],
   *   statFn?: (p: string) => fs.Stats,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.getConfiguredDirs = opts.getConfiguredDirs || (() => []);
    this.readdirFn = opts.readdirFn || ((dir, o) => fs.readdirSync(dir, o));
    this.statFn = opts.statFn || ((p) => fs.statSync(p));
  }

  /** Configured dirs from config (never throws). */
  configuredDirs() {
    try {
      return (this.getConfiguredDirs() || []).filter(isAbsPosix).map((d) => d.trim());
    } catch {
      return [];
    }
  }

  /**
   * Bounded, read-only scan. Never throws on a missing directory.
   *
   * @param {{dirs?: string[]}} [input] extra operator-typed dirs (bounded)
   */
  async scan({ dirs } = {}) {
    const configured = uniq(this.configuredDirs());
    const requested = uniq((Array.isArray(dirs) ? dirs : []).filter(isAbsPosix).map((d) => d.trim())).slice(
      0,
      MAX_TARGET_DIRS
    );

    const steps = [];
    const notes = [];
    const matches = [];
    const scannedDirs = [];
    const missingDirs = [];

    // Configured first, then operator-typed — both are operator intent, but the
    // provenance distinguishes "configured" from a one-off "user" path.
    const targets = [
      ...configured.map((dir) => ({ dir, provenance: "configured" })),
      ...requested.map((dir) => ({ dir, provenance: "user" })),
    ].slice(0, MAX_TARGET_DIRS);

    if (targets.length === 0) {
      steps.push("no configured weight directory — honest empty state, nothing swept");
      return this._result({ configured: configured.length > 0, configuredDirs: configured, matches, scannedDirs, missingDirs, notes, steps });
    }
    steps.push(`scanning ${targets.length} configured/typed path(s) — readdir/stat only, no recursion beyond a bounded depth`);

    const queue = [...targets];
    let visited = 0;
    let truncated = false;

    while (queue.length && visited < MAX_VISITED_DIRS && matches.length < MAX_MATCHES) {
      const { dir, provenance } = queue.shift();
      visited += 1;

      // A configured weightPath may point straight at a FILE — report it.
      let stat = null;
      try {
        stat = this.statFn(dir);
      } catch (err) {
        missingDirs.push(dir);
        notes.push(`${dir} not readable (${err.code || err.message}) — UNKNOWN, not fabricated`);
        continue;
      }
      if (stat && stat.isFile()) {
        if (isWeightFile(path.basename(dir))) {
          matches.push(this._match(dir, provenance, stat.size));
          scannedDirs.push(dir);
        } else {
          notes.push(`${dir} is a file without a weight suffix`);
        }
        continue;
      }

      let entries = [];
      try {
        entries = this.readdirFn(dir, { withFileTypes: true });
      } catch (err) {
        missingDirs.push(dir);
        notes.push(`${dir} not readable (${err.code || err.message}) — UNKNOWN, not fabricated`);
        continue;
      }
      if (!Array.isArray(entries)) continue;
      if (entries.length > MAX_ENTRIES_PER_DIR) {
        truncated = true;
        entries = entries.slice(0, MAX_ENTRIES_PER_DIR);
      }
      scannedDirs.push(dir);

      for (const ent of entries) {
        const name = ent.name;
        if (ent.isFile() && isWeightFile(name)) {
          if (matches.length >= MAX_MATCHES) {
            truncated = true;
            break;
          }
          const full = path.join(dir, name);
          let size = null;
          try {
            size = this.statFn(full).size;
          } catch {
            size = null; // size stays UNKNOWN for an unstat-able entry
          }
          matches.push(this._match(full, provenance, size));
        } else if (ent.isDirectory()) {
          // bounded depth: descend while we still have a visitation budget
          if (visited + queue.length < MAX_VISITED_DIRS) {
            queue.push({ dir: path.join(dir, name), provenance });
          }
        }
      }
    }

    if (queue.length) {
      truncated = true;
      notes.push(`scan truncated at ${visited} directories — bounds kept deliberately small`);
    }
    if (matches.length === 0 && missingDirs.length === 0) {
      notes.push("configured directories exist but held no weight files (gguf/safetensors/bin/…)");
    }

    steps.push("read-only: no file moved, copied, renamed or downloaded");
    return this._result({ configured: configured.length > 0, configuredDirs: configured, matches, scannedDirs, missingDirs, notes, steps, truncated });
  }

  _match(fullPath, provenance, size) {
    return {
      path: fullPath,
      name: path.basename(fullPath),
      dir: path.dirname(fullPath),
      sizeBytes: typeof size === "number" ? size : null,
      ext: path.extname(fullPath).replace(/^\./, "") || null,
      provenance,
    };
  }

  _result(base) {
    return {
      configured: base.configured,
      configuredDirs: base.configuredDirs || [],
      scannedDirs: base.scannedDirs || [],
      missingDirs: base.missingDirs || [],
      matches: base.matches || [],
      truncated: Boolean(base.truncated),
      notes: base.notes || [],
      steps: base.steps || [],
      readOnly: true,
    };
  }
}
