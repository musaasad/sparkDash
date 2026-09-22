import { RuntimeProvider } from "./base.js";

/** vLLM — OpenAI-compatible, served models from /v1/models, Prometheus metrics. */
export class VllmProvider extends RuntimeProvider {
  constructor() {
    super({
      runtimes: ["vllm"],
      label: "vLLM",
      launchable: true,
      processTerms: ["vllm"],
      metricCaps: { vllm: ["kvCacheUsage", "requestsWaiting", "requestsRunning", "ttftSeconds", "preemptionsTotal"] },
    });
  }

  detect(signals) {
    if (!signals) return null;
    if (signals.backendType === "vllm") return "vllm";
    if (/vllm/i.test(String(signals.ownedBy || ""))) return "vllm";
    // An anonymous OpenAI-shaped answer with no owned_by is vLLM-shaped.
    if (signals.serverIsOpenAI && !signals.ownedBy && !signals.backendType) return "vllm";
    return null;
  }

  renderLaunchCommand(recipe) {
    if (recipe?.launch?.command) return recipe.launch.command;
    const modelPath = recipe?.modelPath || recipe?.launch?.workdir;
    if (!modelPath) return null;
    const port = recipe?.endpoint?.port ?? recipe?.apiPort;
    return `vllm serve ${modelPath}${port ? ` --port ${port}` : ""}`;
  }

  /**
   * vLLM genuinely supports tensor-parallel serving to the declared degree when
   * enough nodes exist. PP/DP/EP are not reliably knowable → "unknown".
   */
  supportsTopology({ mode, degree, nodeCount } = {}) {
    if (mode === "single") return "supported";
    if (mode === "tp") {
      const d = Math.max(1, Number(degree) || 1);
      const n = Number(nodeCount) || 0;
      return d <= n ? "supported" : "unsupported";
    }
    return "unknown";
  }
}
