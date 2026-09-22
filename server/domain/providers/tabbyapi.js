import { RuntimeProvider } from "./base.js";

/**
 * TabbyAPI / EXL3 — OpenAI-compatible EXL3 server. Its logs are loguru-shaped
 * and carry request-lifecycle telemetry, so the log/telemetry shaping lives
 * HERE and the collector (LiveConsole) stays generic.
 */
export class TabbyApiProvider extends RuntimeProvider {
  constructor() {
    super({
      runtimes: ["tabbyapi-exl3"],
      label: "TabbyAPI",
      launchable: true,
      processTerms: ["tabbyapi"],
      metricCaps: { "tabbyapi-exl3": ["mtpAcceptanceRate", "prefixCacheHitRate", "ttftSeconds", "prefillTps"] },
    });
  }

  detect(signals) {
    if (!signals) return null;
    if (signals.backendType === "exl3") return "tabbyapi-exl3";
    if (/exl3|tabby/i.test(String(signals.ownedBy || ""))) return "tabbyapi-exl3";
    return null;
  }

  renderLaunchCommand(recipe) {
    if (recipe?.launch?.command) return recipe.launch.command;
    const modelPath = recipe?.modelPath || recipe?.launch?.workdir;
    if (!modelPath) return null;
    return `python main.py --model ${modelPath}`;
  }

  /** Parse one loguru line: `2026-09-21 20:36:55.347 | INFO | message`. */
  parseLogLine(raw) {
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\.(\d{3})\s*\|\s*(\w+)\s*\|\s*(.*)$/.exec(raw);
    if (!m) return { ts: null, level: "raw", msg: raw, raw };
    return { ts: `${m[1]}T${m[2]}.${m[3]}`, level: m[4].toUpperCase(), msg: m[5], raw };
  }

  parseTelemetryLine(msg) {
    return parseTabbyTelemetry(msg);
  }
}

const num = (s) => Number(String(s).replace(/,/g, ""));

const RE_START = /^#(\d+)\s+[^:]+:\s+([\d,]+)\s+prompt tokens(?:.*?temperature:\s*([\d.]+))?/;
const RE_TOOL = /^#(\d+)\s+[^:]+:\s+parsed\s+(\d+)\s+tool calls?\s*(?:\((\w+)\))?/;
const RE_COMPLETE =
  /^#(\d+)\s+[^:]+:\s+([\d,]+)\s+tokens generated at\s+([\d.]+)\s*T\/s\s*·\s*prompt\s+([\d,]+)\s+tokens,\s*(\d+)%\s+cached,\s*([\d,]+)\s+new in\s+([\d.]+)\s*s\s*\((\d+)\s*T\/s\)\s*·\s*first token\s+([\d.]+)\s*s,\s*total\s+([\d.]+)\s*s(?:\s*·\s*draft\s+(\d+)\/(\d+)\s+accepted\s+\((\d+)%\))?/;

/** Parse one TabbyAPI request-lifecycle message, or null when unrelated. */
export function parseTabbyTelemetry(msg) {
  let m = RE_COMPLETE.exec(msg);
  if (m) {
    return {
      phase: "complete",
      reqId: Number(m[1]),
      generatedTokens: num(m[2]),
      decodeTps: Number(m[3]),
      promptTokens: num(m[4]),
      cachedPct: Number(m[5]),
      newPromptTokens: num(m[6]),
      prefillSeconds: Number(m[7]),
      prefillTps: Number(m[8]),
      ttftSeconds: Number(m[9]),
      totalSeconds: Number(m[10]),
      draftAccepted: m[11] != null ? Number(m[11]) : null,
      draftAttempted: m[12] != null ? Number(m[12]) : null,
      draftPct: m[13] != null ? Number(m[13]) : null,
    };
  }
  m = RE_START.exec(msg);
  if (m) {
    return {
      phase: "start",
      reqId: Number(m[1]),
      promptTokens: num(m[2]),
      temperature: m[3] != null ? Number(m[3]) : null,
    };
  }
  m = RE_TOOL.exec(msg);
  if (m) {
    return { phase: "tool", reqId: Number(m[1]), toolCalls: Number(m[2]), toolFormat: m[3] || null };
  }
  return null;
}
