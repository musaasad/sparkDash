/**
 * RuntimeProvider — foundation for the provider abstraction (WS-3).
 *
 * A provider encapsulates the runtime-SPECIFIC behaviour that used to be
 * scattered as `switch (runtime)` across controlPlane.js / LlmProbe.js /
 * validate.js / LiveConsole.js:
 *
 *   detect(signals)          classify a backend from probe signals → runtime key | null
 *   healthClassify(outcome)  probe outcome → observed vocabulary (WS-1 semantics)
 *   modelsPath()             read-only path that lists served model ids
 *   servedModelIds(body)     extract served model ids from a probe body
 *   renderLaunchCommand(rec) DRY-RUN command string only (never executes)
 *   parseLogLine(raw)        runtime-shaped log line → {ts,level,msg,raw}
 *   parseTelemetryLine(msg)  runtime-shaped telemetry payload → event | null
 *
 * Everything is pure/synchronous. The registry (registry.js) keys providers by
 * runtime type; call sites ask the registry, never the runtime string.
 *
 * SAFETY: providers only DESCRIBE. No process control, no writes, no network of
 * their own — the discovery service owns the single read-only HTTP GET.
 */
import { classifyProbe } from "../../deployments/deploymentStatus.js";

/** Collapse a Hugging Face hub cache path to a short org/Name served id. */
export function normalizeServedId(id) {
  if (id == null) return null;
  const s = String(id).trim();
  if (!s) return null;
  const hub = s.match(/(?:^|\/)models--([^/]+?)(?:\/snapshots\/[^/]+)?\/?$/);
  if (hub) return hub[1].replace(/--/g, "/");
  const mid = s.match(/models--([^/]+)\/snapshots\//);
  if (mid) return mid[1].replace(/--/g, "/");
  return s;
}

/** Extract model ids from an OpenAI-shaped `/v1/models` body. */
export function extractOpenAIModelIds(body) {
  const data = Array.isArray(body?.data) ? body.data : [];
  return data.map((m) => normalizeServedId(m?.id)).filter(Boolean);
}

export class RuntimeProvider {
  /**
   * @param {{runtimes: string[], label?: string, launchable?: boolean}} opts
   *   `runtimes` = every runtime key this provider serves (first = canonical).
   */
  constructor({ runtimes, label = null, launchable = true }) {
    this.runtimes = runtimes;
    this.runtime = runtimes[0];
    this.label = label ?? this.runtime;
    this.launchable = launchable;
  }

  /** @param {{backendType?:string|null, ownedBy?:string|null, serverIsOpenAI?:boolean|null, port?:number|null}} signals */
  detect(_signals) {
    return null;
  }

  /** WS-1 semantics: 401/403 auth-gated = process up. Never "stopped". */
  healthClassify(outcome) {
    return classifyProbe(outcome);
  }

  modelsPath() {
    return "/v1/models";
  }

  servedModelIds(body) {
    return extractOpenAIModelIds(body);
  }

  /** Dry-run launch string derived from a recipe. Never executed here. */
  renderLaunchCommand(_recipe) {
    return null;
  }

  /** Generic log line shape; runtime-specific providers override. */
  parseLogLine(raw) {
    return { ts: null, level: "raw", msg: raw, raw };
  }

  parseTelemetryLine(_msg) {
    return null;
  }
}
