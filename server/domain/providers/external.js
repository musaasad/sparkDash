import { RuntimeProvider, normalizeServedId } from "./base.js";

/**
 * ExternalProvider — catch-all for runtimes SparkDash does not model and for
 * llama.cpp/ds4/q27. Observe-only: no launch command (the operator launched it),
 * served ids may come from llama.cpp's array-shaped `/slots`.
 *
 * This is the "externally launched runtimes are first-class" fallback: it never
 * claims a process SparkDash can manage, only describes what answers.
 */
export class ExternalProvider extends RuntimeProvider {
  constructor() {
    super({
      runtimes: ["custom", "llama.cpp"],
      label: "External",
      launchable: false,
      processTerms: ["llama"],
      // llama.cpp native /slots carries slot occupancy; custom exposes nothing extra.
      metricCaps: { "llama.cpp": ["slotsActive", "slotsTotal", "contextLength"] },
    });
  }

  detect(signals) {
    if (!signals) return "custom";
    if (signals.backendType === "llama.cpp") return "llama.cpp";
    if (/llama\.?cpp/i.test(String(signals.ownedBy || ""))) return "llama.cpp";
    // llama.cpp native /slots answers with an array, not OpenAI data[].
    if (Array.isArray(signals.shape) && signals.shape.length > 0) return "llama.cpp";
    return "custom"; // unconditional catch-all
  }

  /** llama.cpp differs: `/slots` is the native served-model surface. */
  modelsPath(signals) {
    return signals?.backendType === "llama.cpp" ? "/slots" : "/v1/models";
  }

  servedModelIds(body) {
    if (Array.isArray(body)) {
      return body.map((s) => normalizeServedId(s?.id ?? s?.model)).filter(Boolean);
    }
    const data = Array.isArray(body?.data) ? body.data : [];
    return data.map((m) => normalizeServedId(m?.id)).filter(Boolean);
  }

  renderLaunchCommand() {
    return null; // external — SparkDash did not launch it
  }

  // External runtimes are unmodelled: an empty topology map ⇒ every mode UNKNOWN.
}
