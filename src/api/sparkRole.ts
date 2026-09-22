import type { SparkRole } from "./types";
import { llmMonitoringEnabled as canonicalLlmMonitoringEnabled } from "../shared/runtimeState.js";

/** Resolve cluster role from config/snapshot fields (supports legacy workerNode-only). */
export function resolveSparkRole(spark: {
  role?: SparkRole | string | null;
  workerNode?: boolean | null;
}): SparkRole {
  if (spark.role === "head" || spark.role === "worker" || spark.role === "standalone") {
    return spark.role;
  }
  return spark.workerNode ? "worker" : "standalone";
}

export function isWorkerSpark(spark: {
  role?: SparkRole | string | null;
  workerNode?: boolean | null;
}): boolean {
  return resolveSparkRole(spark) === "worker";
}

/**
 * Whether this Spark should probe/show the local LLM API.
 * Canonical rule (shared module): Workers default OFF but honour an EXPLICIT
 * llmMonitoring opt-in so a worker-hosted endpoint is never silently unobserved.
 * Head always. Standalone defaults on.
 */
export function isLlmMonitoringEnabled(spark: {
  role?: SparkRole | string | null;
  workerNode?: boolean | null;
  llmMonitoring?: boolean | null;
}): boolean {
  return canonicalLlmMonitoringEnabled(spark);
}
