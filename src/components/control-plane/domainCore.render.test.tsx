/**
 * WS-1 proof (2): invented model/recipe names render generically from entities —
 * no hard-coded model/runtime/port knowledge in the component.
 */
import { describe, expect, it } from "vitest";
import { ModelsSection } from "./ModelsSection";
import type { ModelEntry, RecipePublic, DeploymentStatus, SparkSnapshot } from "../../api/types";
import { render, cleanupRenders } from "../../testing/render";

const MODELS: ModelEntry[] = [
  {
    id: "glm-53-flash",
    name: "GLM-5.3 Flash",
    family: "GLM",
    weightPaths: { default: "/models/glm53-29" },
    tags: ["invented"],
    notes: "",
    archived: false,
    createdAt: 0,
    updatedAt: 0,
  },
];

const RECIPES: RecipePublic[] = [
  {
    id: "glm53-sglang-pp3",
    modelId: "glm-53-flash",
    name: "SGLang PP3",
    runtime: "sglang",
    topology: "pp3",
    topologyBlock: { mode: "pp", parallelism: 3, minNodes: 3, maxNodes: 3 },
    nodeIds: ["node-7", "node-8", "node-9"],
    modelPath: "/models/glm53-29",
    workdir: "/opt/sglang",
    logDir: "/opt/sglang/logs",
    apiPort: 8891,
    healthPath: "/v1/models",
    contextLength: 128000,
    cpuAffinity: null,
    launcher: null,
    metadata: {},
    notes: "",
    env: [],
    lifecycleState: "proven",
    provenance: { provenAt: 1, note: "verified" },
    archived: false,
    createdAt: 0,
    updatedAt: 0,
  },
];

const DEPLOYMENTS: DeploymentStatus[] = [
  {
    deploymentId: "dep-glm53-sglang-pp3",
    recipeId: "glm53-sglang-pp3",
    modelId: "glm-53-flash",
    nodeIds: ["node-7", "node-8", "node-9"],
    apiPort: 8891,
    managedBy: "external",
    dryRun: true,
    state: "running",
    desired: "running",
    observed: "running",
    discovered: false,
    display: "running",
    lastOp: null,
    lastError: null,
    startedAt: null,
    updatedAt: 0,
  },
];

function spark(id: string): SparkSnapshot {
  return {
    id,
    name: id.replace("node-", "Node "),
    online: true,
    uptime: 1,
    disabledDevices: [],
    disabledInterfaces: [],
    llmPort: 8891,
    llmPorts: [8891],
    hardware: { device: "x", cpuModel: "x", cpuCores: 1, totalMemoryGB: 1, gpuChip: "x", cudaDriver: null, storageModel: null },
    metrics: { gpu: null, cpu: null, ram: null, storage: [], network: null, unifiedMemory: null, llm: [], comfy: null, tailscale: null },
  } as SparkSnapshot;
}

describe("generic invented-entity rendering", () => {
  it("renders invented model + recipe + pp3 node cluster + lifecycle badge", () => {
    cleanupRenders();
    const { container } = render(
      <ModelsSection
        models={MODELS}
        recipes={RECIPES}
        deployments={DEPLOYMENTS}
        sparks={[spark("node-7"), spark("node-8"), spark("node-9")]}
        navigate={() => {}}
        onSaved={() => {}}
      />
    );

    const row = container.querySelector(".cp-deploy-row");
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("GLM-5.3 Flash");
    expect(row!.textContent).toContain("glm53-sglang-pp3");
    expect(row!.textContent).toContain("Proven");
    expect(row!.textContent).toContain("PP3 · 3 nodes");
    expect(row!.textContent).toContain("Node 7");
    expect(row!.textContent).toContain(":8891");
    // Friendly runtime label comes from the entity, not a literal.
    const runtimeOption = [...container.querySelectorAll("option")].find((o) => o.textContent === "SGLang");
    expect(runtimeOption).not.toBeUndefined();
    // Model catalog shows the invented weight path, not a hard-coded one.
    expect(container.textContent).toContain("/models/glm53-29");
  });
});
