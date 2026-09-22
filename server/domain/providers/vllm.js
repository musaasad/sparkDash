import { RuntimeProvider } from "./base.js";

/** vLLM — OpenAI-compatible, served models from /v1/models, Prometheus metrics. */
export class VllmProvider extends RuntimeProvider {
  constructor() {
    super({ runtimes: ["vllm"], label: "vLLM", launchable: true });
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
}
