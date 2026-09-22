import { RuntimeProvider } from "./base.js";

/** SGLang — OpenAI-compatible; native server_info/model_info endpoints. */
export class SglangProvider extends RuntimeProvider {
  constructor() {
    super({
      runtimes: ["sglang"],
      label: "SGLang",
      launchable: true,
      processTerms: ["sglang"],
      metricCaps: { sglang: ["prefixCacheHitRate", "requestsRunning", "requestsWaiting"] },
      // SGLang genuinely supports TP to the declared degree when enough nodes exist.
      topology: { single: "supported", tp: "by-node-count" },
    });
  }

  detect(signals) {
    if (!signals) return null;
    if (signals.backendType === "sglang") return "sglang";
    if (/sglang/i.test(String(signals.ownedBy || ""))) return "sglang";
    return null;
  }

  renderLaunchCommand(recipe) {
    if (recipe?.launch?.command) return recipe.launch.command;
    const modelPath = recipe?.modelPath || recipe?.launch?.workdir;
    if (!modelPath) return null;
    const port = recipe?.endpoint?.port ?? recipe?.apiPort;
    return `python -m sglang.launch_server --model-path ${modelPath}${port ? ` --port ${port}` : ""}`;
  }

}
