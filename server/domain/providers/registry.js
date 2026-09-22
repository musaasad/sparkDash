/**
 * Provider registry — the single place call sites ask instead of switching on
 * a runtime string.
 *
 *   providerFor(runtime)              → RuntimeProvider (never null; external fallback)
 *   detectRuntime(signals)            → runtime key | "custom"
 *   healthClassify(runtime, outcome)  → observed vocabulary
 *   servedModelIds(runtime, body)     → served model ids
 *   renderLaunchCommand(recipe)       → DRY-RUN command string | null
 *   parseLogLine / parseTelemetryLine → runtime-shaped log handling
 *
 * RUNTIME_TYPES is the canonical runtime enum (validate.js derives from it), so
 * adding a runtime is a provider module — not a scattered edit.
 */
import { VllmProvider } from "./vllm.js";
import { SglangProvider } from "./sglang.js";
import { TabbyApiProvider } from "./tabbyapi.js";
import { ExternalProvider } from "./external.js";

const vllm = new VllmProvider();
const sglang = new SglangProvider();
const tabby = new TabbyApiProvider();
const external = new ExternalProvider();

/** Detection order: specific runtimes first, catch-all last. */
const DETECTORS = [tabby, sglang, vllm, external];
const ALL = [tabby, sglang, vllm, external];

const byRuntime = new Map();
for (const p of ALL) for (const r of p.runtimes) byRuntime.set(r, p);

/** Canonical runtime keys, in stable order (validate.js derives its enum). */
export const RUNTIME_TYPES = Object.freeze([
  "tabbyapi-exl3",
  "vllm",
  "sglang",
  "llama.cpp",
  "custom",
]);

/** Provider serving a runtime key. External is the unconditional fallback. */
export function providerFor(runtime) {
  return byRuntime.get(runtime) || external;
}

/**
 * Classify a runtime from probe signals. Always returns a runtime key.
 * @param {{backendType?:string|null, ownedBy?:string|null, serverIsOpenAI?:boolean|null, shape?:unknown, port?:number|null}} signals
 */
export function detectRuntime(signals) {
  for (const p of DETECTORS) {
    const hit = p.detect(signals || {});
    if (hit) return hit;
  }
  return "custom";
}

export function healthClassify(runtime, outcome) {
  return providerFor(runtime).healthClassify(outcome);
}

export function modelsPath(runtime, signals) {
  return providerFor(runtime).modelsPath(signals);
}

/**
 * READ-ONLY process evidence command: one pgrep over every provider's terms.
 * Single source for discovery.js + controlPlane.js (no duplicated literal).
 */
export function processEvidenceCmd() {
  const terms = [...new Set(ALL.flatMap((p) => p.processTerms).filter(Boolean))];
  return `pgrep -f '${terms.join("|")}' >/dev/null 2>&1 && echo up || echo down`;
}

/**
 * Candidate read-only probe paths: OpenAI `/v1/models` first, then every
 * provider's non-default modelsPath (e.g. llama.cpp `/slots`). De-duplicated.
 */
export function probePaths() {
  const paths = ["/v1/models"];
  for (const p of ALL) {
    const mp = p.modelsPath({});
    if (mp && !paths.includes(mp)) paths.push(mp);
  }
  return paths;
}

export function servedModelIds(runtime, body) {
  return providerFor(runtime).servedModelIds(body);
}

export function renderLaunchCommand(recipe) {
  return providerFor(recipe?.engine?.runtime ?? recipe?.runtime).renderLaunchCommand(recipe);
}

export function parseLogLine(runtime, raw) {
  return providerFor(runtime).parseLogLine(raw);
}

export function parseTelemetryLine(runtime, msg) {
  return providerFor(runtime).parseTelemetryLine(msg);
}

export function providerLabel(runtime) {
  return providerFor(runtime).label;
}

/**
 * Normalized metric keys a runtime meaningfully exposes, for the /api/runtimes
 * catalog. Empty (never null) means only the universal core instruments.
 */
export function metricsFor(runtime) {
  return providerFor(runtime).metrics(runtime);
}

/**
 * Provider-declared topology capability for a mode/degree on a node count.
 * @param {string} runtime
 * @param {{mode?: string|null, degree?: number|null, nodeCount?: number|null}} spec
 * @returns {"supported"|"unsupported"|"unknown"}
 */
export function supportsTopology(runtime, spec) {
  return providerFor(runtime).supportsTopology(spec);
}

/**
 * Declarative topology capability DATA for a runtime (mode → "supported" |
 * "unsupported" | "by-node-count"). An absent mode means UNKNOWN. The FE reads
 * this from `/api/runtimes` so strategy tiers are provider data, never a
 * model-name check and never an FE hard-code.
 * @param {string} runtime
 * @returns {Readonly<Record<string, string>>}
 */
export function topologyDescriptor(runtime) {
  return providerFor(runtime).topology;
}
