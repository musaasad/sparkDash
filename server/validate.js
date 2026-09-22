import dns from "node:dns/promises";
import net from "node:net";
import { RUNTIME_TYPES } from "./domain/providers/registry.js";

/**
 * Input validation for Spark targets (host / user / lanIp).
 * Keeps SSRF-ish footguns smaller on an otherwise unauthenticated LAN dashboard.
 */

/** IPv4 dotted quad with each octet 0–255. */
export function isValidIPv4(host) {
  if (typeof host !== "string") return false;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every((o) => {
    const n = Number(o);
    return n >= 0 && n <= 255 && String(n) === String(Number(o));
  });
}

/** DNS hostname (no spaces/shell metacharacters). */
export function isValidHostname(host) {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) return false;
  if (host === "localhost") return true;
  return /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*$/.test(
    host
  );
}

/** Accept IPv4, IPv6, or hostname for SSH / LLM targets. */
export function isValidHost(host) {
  return typeof host === "string" && (net.isIP(host) !== 0 || isValidHostname(host));
}

function normalizedHost(host) {
  const value = String(host || "").trim().toLowerCase();
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

export function isForbiddenAddress(address) {
  const host = normalizedHost(address);
  const family = net.isIP(host);
  if (family === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 0 || (a === 169 && b === 254) || a >= 224;
  }
  if (family === 6) {
    if (host === "::" || host.startsWith("ff")) return true;
    const first = parseInt(host.split(":", 1)[0] || "0", 16);
    if ((first & 0xffc0) === 0xfe80) return true;
    if (host.startsWith("::ffff:")) return isForbiddenAddress(host.slice(7));
    return false;
  }
  return false;
}

/** Resolve an administrator-allowlisted target and reject unsafe DNS answers. */
export async function assertAllowedTarget(host, allowedHosts, { lookup = dns.lookup } = {}) {
  const target = normalizedHost(host);
  const allowed = new Set([...allowedHosts].map(normalizedHost));
  if (!allowed.has(target)) {
    const err = new Error(`Target ${target || "(empty)"} is not in the administrator allowlist`);
    err.status = 403;
    throw err;
  }
  let addresses;
  if (net.isIP(target)) {
    addresses = [{ address: target }];
  } else {
    try {
      addresses = await lookup(target, { all: true, verbatim: true });
    } catch (cause) {
      const err = new Error(`Could not resolve allowed target ${target}`);
      err.status = 400;
      err.cause = cause;
      throw err;
    }
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    const err = new Error(`Allowed target ${target} resolved to no addresses`);
    err.status = 400;
    throw err;
  }
  const resolved = [...new Set(addresses.map((entry) => normalizedHost(entry.address)))];
  const forbidden = resolved.find(isForbiddenAddress);
  if (forbidden) {
    const err = new Error(`Target ${target} resolved to forbidden address ${forbidden}`);
    err.status = 403;
    throw err;
  }
  return resolved;
}

/**
 * Classify a probe target for security-posture hints.
 * Uses the configured host only — not the process bind address.
 * Hostnames (except localhost) are "unknown" (no DNS lookup).
 *
 * @returns {"local" | "lan" | "public" | "unknown"}
 */
export function classifyHostScope(host) {
  if (typeof host !== "string" || !host.trim()) return "unknown";
  const h = host.trim().toLowerCase();
  if (h === "localhost" || h === "::1") return "local";
  if (!isValidIPv4(h)) return "unknown";
  const [a, b] = h.split(".").map(Number);
  if (a === 127) return "local";
  if (a === 10) return "lan";
  if (a === 172 && b >= 16 && b <= 31) return "lan";
  if (a === 192 && b === 168) return "lan";
  if (a === 100 && b >= 64 && b <= 127) return "lan"; // Tailscale CGNAT (100.64.0.0/10)
  if (a === 169 && b === 254) return "lan";
  if (a === 0 || a >= 224) return "unknown";
  return "public";
}

/**
 * Block cloud metadata / link-local misuse. Allow private, loopback, and public
 * (remote Sparks may be anywhere on a managed network).
 */
export function isAllowedTargetHost(host) {
  if (!isValidHost(host)) return false;
  return !isForbiddenAddress(host);
}

/** OpenSSH-safe username. */
export function isValidSshUser(user) {
  return typeof user === "string" && /^[a-zA-Z0-9._-]{1,64}$/.test(user);
}

/**
 * Reserved Spark ids that must never be accepted from an API client.
 * Matches the frontend `OVERVIEW_ID` constant (kept in sync manually — it is
 * a single value and duplicated across the boundary on purpose).
 */
export const RESERVED_SPARK_IDS = Object.freeze(new Set(["__overview__"]));

/**
 * Validate a client-supplied Spark id. Same character class as the SSH user
 * regex (no path traversal, no shell metacharacters), 1–64 chars, and not a
 * reserved id. The registry stores the id as a JSON key (no path-injection),
 * but rejecting early avoids accidental collisions with reserved tab ids.
 */
export function isValidSparkId(id) {
  if (typeof id !== "string") return false;
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(id)) return false;
  if (RESERVED_SPARK_IDS.has(id)) return false;
  return true;
}

/**
 * Validate fields used for SSH/LLM probes. Returns null if ok, else error message.
 * @param {{ lanIp?: string, ssh?: { host?: string, user?: string } }} body
 */
export function validateSparkTarget(body) {
  const lanIp = body?.lanIp || "";
  const sshHost = body?.ssh?.host || "";
  const target = sshHost || lanIp;
  if (!target) {
    return body?.isLocal ? null : "lanIp or ssh.host is required";
  }
  if (!isAllowedTargetHost(target)) {
    return `Invalid or disallowed host: ${target}`;
  }
  if (lanIp && !isAllowedTargetHost(lanIp)) {
    return `Invalid or disallowed lanIp: ${lanIp}`;
  }
  const user = body?.ssh?.user;
  if (user != null && user !== "" && !isValidSshUser(user)) {
    return "Invalid SSH user (allowed: letters, digits, . _ -)";
  }
  return null;
}

/**
 * Bounded per-key sliding-window limiter. Expired keys are removed on access;
 * new keys fail closed while the configured key ceiling is occupied.
 */
export function createRateLimiter(maxRequests, windowMs, options = {}) {
  /** @type {Map<string, number[]>} */
  const hits = new Map();
  const maxKeys = Math.max(1, Number(options.maxKeys) || 1024);
  const nowFn = typeof options.now === "function" ? options.now : Date.now;

  /**
   * @param {string} key
   * @param {boolean} [peek] when true, report whether a consume would succeed without recording a hit
   */
  function rateLimit(key, peek = false) {
    const now = nowFn();
    for (const [storedKey, times] of hits) {
      const live = times.filter((t) => now - t < windowMs);
      if (live.length) hits.set(storedKey, live);
      else hits.delete(storedKey);
    }
    if (!hits.has(key) && hits.size >= maxKeys) return false;
    const times = hits.get(key) || [];
    if (times.length >= maxRequests) return false;
    if (!peek) {
      times.push(now);
      hits.set(key, times);
    }
    return true;
  }
  rateLimit.size = () => hits.size;
  return rateLimit;
}

export const DECODE_BENCH_WORK_LIMIT = 262_144;

export function validateDecodeBudget(concurrencies, maxTokens, limit = DECODE_BENCH_WORK_LIMIT) {
  const work = (Array.isArray(concurrencies) ? concurrencies : []).reduce(
    (total, value) => total + Number(value || 0) * Number(maxTokens || 0),
    0
  );
  if (!Number.isFinite(work) || work <= 0 || work > limit) {
    const err = new Error(`Decode benchmark exceeds the ${limit}-token work budget`);
    err.status = 429;
    throw err;
  }
  return work;
}

export function validatePrefillBudget(contextSizes, limit = 600_000) {
  const work = (Array.isArray(contextSizes) ? contextSizes : []).reduce(
    (total, value) => total + Number(value || 0),
    0
  );
  if (!Number.isFinite(work) || work <= 0 || work > limit) {
    const err = new Error(`Prefill benchmark exceeds the ${limit}-token work budget`);
    err.status = 429;
    throw err;
  }
  return work;
}

// ─── Control-plane validators (Model Registry / Recipes) ──
// Every field that can later reach a remote command, a health probe, or a
// persisted config file has a strict grammar here. Values are validated at
// write time AND re-validated before interpolation (defense in depth).

/** Slug id: lowercase alnum with single dots/hyphens, 1–64 chars. */
export function isValidSlug(id) {
  return (
    typeof id === "string" &&
    /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/.test(id) &&
    !id.includes("..")
  );
}

/** Absolute POSIX path with no traversal and no shell metacharacters. */
export function isValidPosixPath(p) {
  if (typeof p !== "string" || p.length === 0 || p.length > 512) return false;
  if (!p.startsWith("/")) return false;
  if (p.includes("..")) return false;
  // letters/digits and . _ / - : + @ , only — no quotes, spaces, $, backticks…
  return /^[A-Za-z0-9._/:@+-]+$/.test(p);
}

/** Environment variable name grammar (POSIX-ish, uppercase convention free). */
export function isValidEnvName(name) {
  return typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name);
}

/**
 * Env value grammar for recipe env vars. Deliberately strict: these values are
 * interpolated into launcher environments. No quotes, no command
 * substitution, no newlines. Spaces allowed (quoted at launch time).
 */
export function isValidEnvValue(value) {
  return typeof value === "string" && value.length <= 1024 && !/[\x00-\x1f`$"'\\|&;<>()\n\r]/.test(value);
}

/** taskset -c style CPU affinity list: "5-9,15-19" or "0,2,4". */
export function isValidCpuAffinity(v) {
  if (typeof v !== "string" || v.length === 0 || v.length > 256) return false;
  return /^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(v);
}

/** TCP port 1–65535. */
export function isValidPort(p) {
  const n = Number(p);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/** Relative health path like "/v1/models" — path chars only, starts with /. */
export function isValidHealthPath(p) {
  return typeof p === "string" && /^\/[A-Za-z0-9._/-]{0,127}$/.test(p);
}

/** Free-text note fields: length-capped, no control characters. */
export function isValidNoteText(t) {
  return typeof t === "string" && t.length <= 4096 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(t);
}

// Provider-derived runtime enum (server/domain/providers/registry.js): a new
// runtime is a provider module, not an edit here or in a scattered switch.
export const RECIPE_RUNTIMES = RUNTIME_TYPES;

export const RECIPE_TOPOLOGIES = Object.freeze(["single", "tp2", "tp3"]);

/**
 * Validate a full recipe write. Returns { ok, errors: string[] }.
 * Pure — no fs, no network.
 * @param {object} body
 * @param {{ nodeIds?: string[] }} [ctx] known spark ids for node references
 */
export function validateRecipeWrite(body, ctx = {}) {
  const errors = [];
  const knownNodes = Array.isArray(ctx.nodeIds) ? new Set(ctx.nodeIds) : null;
  if (!isValidSlug(body?.id)) errors.push("recipe id must be a lowercase slug (a-z0-9._-)");
  if (!isValidSlug(body?.modelId)) errors.push("modelId must be a lowercase slug");
  if (!isValidNoteText(body?.name || "") || !body?.name?.trim())
    errors.push("recipe name is required (≤4096 chars, no control characters)");
  if (!RECIPE_RUNTIMES.includes(body?.runtime))
    errors.push(`runtime must be one of: ${RECIPE_RUNTIMES.join(", ")}`);
  if (!RECIPE_TOPOLOGIES.includes(body?.topology))
    errors.push(`topology must be one of: ${RECIPE_TOPOLOGIES.join(", ")}`);
  const nodeIds = Array.isArray(body?.nodeIds) ? body.nodeIds : [];
  if (nodeIds.length === 0) errors.push("at least one node is required");
  if (new Set(nodeIds).size !== nodeIds.length) errors.push("nodeIds must be unique");
  const expectedNodes = body?.topology === "tp3" ? 3 : body?.topology === "tp2" ? 2 : 1;
  if (nodeIds.length !== expectedNodes)
    errors.push(`topology ${body?.topology} requires exactly ${expectedNodes} node(s)`);
  if (knownNodes) {
    for (const n of nodeIds) {
      if (!knownNodes.has(n)) errors.push(`unknown node id: ${n}`);
    }
  }
  if (!isValidPosixPath(body?.modelPath)) errors.push("modelPath must be an absolute POSIX path without .. or shell metacharacters");
  if (!isValidPosixPath(body?.workdir)) errors.push("workdir must be an absolute POSIX path without .. or shell metacharacters");
  if (body?.logDir != null && body.logDir !== "" && !isValidPosixPath(body.logDir))
    errors.push("logDir must be an absolute POSIX path without .. or shell metacharacters");
  if (!isValidPort(body?.apiPort)) errors.push("apiPort must be an integer 1–65535");
  if (body?.healthPath != null && body.healthPath !== "" && !isValidHealthPath(body.healthPath))
    errors.push('healthPath must look like "/v1/models"');
  if (body?.contextLength != null) {
    const c = Number(body.contextLength);
    if (!Number.isInteger(c) || c < 1 || c > 10_000_000) errors.push("contextLength must be 1–10000000");
  }
  if (body?.cpuAffinity != null && body.cpuAffinity !== "" && !isValidCpuAffinity(body.cpuAffinity))
    errors.push('cpuAffinity must be a taskset list like "5-9,15-19"');
  const env = Array.isArray(body?.env) ? body.env : [];
  if (env.length > 64) errors.push("too many env vars (max 64)");
  const seenEnv = new Set();
  for (const e of env) {
    if (!isValidEnvName(e?.name)) {
      errors.push(`invalid env var name: ${String(e?.name).slice(0, 64)}`);
      continue;
    }
    if (seenEnv.has(e.name)) errors.push(`duplicate env var: ${e.name}`);
    seenEnv.add(e.name);
    if (!isValidEnvValue(e?.value == null ? "" : String(e.value)))
      errors.push(`invalid env var value for ${e.name}`);
  }
  if (body?.launcher != null && body.launcher !== "") {
    if (!isValidNoteText(body.launcher)) errors.push("launcher must be plain text ≤4096 chars");
    // Launcher is stored metadata this phase; forbid the worst tokens early.
    if (/(`|\$\(|rm\s+-rf|mkfs|dd\s+if=|:\(\)\s*\{)/.test(body.launcher))
      errors.push("launcher contains forbidden shell constructs");
  }
  if (body?.notes != null && !isValidNoteText(body.notes)) errors.push("notes must be plain text ≤4096 chars");
  return { ok: errors.length === 0, errors };
}

/** Validate a model write. Returns { ok, errors: string[] }. */
export function validateModelWrite(body) {
  const errors = [];
  if (!isValidSlug(body?.id)) errors.push("model id must be a lowercase slug (a-z0-9._-)");
  if (!isValidNoteText(body?.name || "") || !body?.name?.trim())
    errors.push("model name is required (≤4096 chars)");
  if (body?.family != null && !isValidNoteText(String(body.family)))
    errors.push("family must be plain text");
  if (body?.notes != null && !isValidNoteText(body.notes)) errors.push("notes must be plain text ≤4096 chars");
  return { ok: errors.length === 0, errors };
}
