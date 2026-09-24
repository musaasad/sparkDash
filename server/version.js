// Build/version visibility. Answers "which sparkDash is this machine actually
// showing?" without digging through the host.
//
// In a production image the Dockerfile bakes GIT_COMMIT / BUILD_DATE / APP_MODE
// as build-time env (see Dockerfile ARG/ENV). When running from source (dev,
// `node server/index.js`) those are absent, so we fall back to a best-effort
// live `git rev-parse` and report development mode. Never throws.
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STARTED_AT_MS = Date.now();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function liveGitCommit() {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Snapshot of what this process is. `imageBuild` is true only when the commit
 * was baked at image-build time (production), which distinguishes a real
 * production build from a source checkout that happens to set NODE_ENV.
 */
export function inspectVersion() {
  const baked = Boolean(process.env.GIT_COMMIT);
  const commit = (process.env.GIT_COMMIT || liveGitCommit() || "").trim() || null;
  const nodeEnv = process.env.NODE_ENV || "development";
  return {
    app: "sparkDash",
    commit,
    shortCommit: commit ? commit.slice(0, 7) : null,
    builtAt: process.env.BUILD_DATE || null,
    startedAt: new Date(STARTED_AT_MS).toISOString(),
    uptimeSeconds: Math.round((Date.now() - STARTED_AT_MS) / 1000),
    nodeEnv,
    mode: baked ? "production" : nodeEnv === "production" ? "production-source" : "development",
    imageBuild: baked,
    node: process.version,
  };
}