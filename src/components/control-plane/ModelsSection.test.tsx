import { describe, expect, it } from "vitest";
import { act } from "react";
import { ModelsSection } from "./ModelsSection";
import type { ModelEntry, RecipePublic, DeploymentStatus, SparkSnapshot, ActivityEvent } from "../../api/types";
import { render, cleanupRenders } from "../../testing/render";

function model(over: Partial<ModelEntry> = {}): ModelEntry {
  return { id: "m1", name: "Qwen Flash", family: "Qwen", notes: "", archived: false, createdAt: 0, updatedAt: 0, ...over };
}

function recipe(over: Partial<RecipePublic> = {}): RecipePublic {
  return {
    id: "r1", modelId: "m1", name: "Recipe One", runtime: "vllm", topology: "tp2", nodeIds: ["n1", "n2"],
    modelPath: "/models/qwen", workdir: "/w", logDir: "/logs", apiPort: 8889, healthPath: "/health",
    contextLength: 60000, cpuAffinity: null, launcher: null, metadata: {}, notes: "", env: [],
    archived: false, createdAt: 0, updatedAt: 0, ...over,
  };
}

function dep(over: Partial<DeploymentStatus> = {}): DeploymentStatus {
  return {
    recipeId: "r1", modelId: "m1", nodeIds: ["n1", "n2"], apiPort: 8889, managedBy: "sparkdash", dryRun: true,
    state: "running", desired: "running", observed: "running", discovered: false, display: "running",
    lastOp: null, lastError: null, startedAt: Date.now() - 600_000, updatedAt: Date.now() - 120_000, ...over,
  };
}

function spark(id: string, name: string): SparkSnapshot {
  return {
    id, name, online: true, uptime: 100, disabledDevices: [], disabledInterfaces: [], llmPort: 8888, llmPorts: [8888],
    hardware: { device: "x", cpuModel: "x", cpuCores: 8, totalMemoryGB: 128, gpuChip: "GB10", cudaDriver: null, storageModel: null },
    metrics: { gpu: null, cpu: null, ram: null, storage: [], network: null, unifiedMemory: null, llm: [], comfy: null, tailscale: null },
  } as SparkSnapshot;
}

const activity: ActivityEvent[] = Array.from({ length: 12 }, (_, i) => ({
  seq: i, ts: new Date(Date.now() - i * 1000).toISOString(), kind: "lifecycle", subject: "r1",
  summary: `log line ${i}`, attribution: null, meta: null,
}));

describe("ModelsSection row grammar", () => {
  it("renders pill → mono id → age+provenance → node chips → View logs", () => {
    cleanupRenders();
    const { container } = render(
      <ModelsSection
        models={[model()]}
        recipes={[recipe()]}
        deployments={[dep()]}
        sparks={[spark("n1", "Spark A"), spark("n2", "Spark B")]}
        activity={activity}
        navigate={() => {}}
        onSaved={() => {}}
      />
    );
    const row = container.querySelector(".cp-deploy-row");
    expect(row).not.toBeNull();
    expect(row!.querySelector(".cp-pill")?.textContent).toContain("Running");
    expect(row!.querySelector(".cp-deploy-id")?.textContent).toContain("r1");
    expect(row!.querySelector(".cp-deploy-meta")?.textContent).toContain("managed");
    expect(row!.textContent).toContain("Spark A");
    expect(row!.textContent).toContain("View logs");
  });

  it("expands an error row to ~10 mono log lines with one remediation link", () => {
    cleanupRenders();
    const { container } = render(
      <ModelsSection
        models={[model()]}
        recipes={[recipe()]}
        deployments={[dep({ display: "degraded", lastError: "probe failed" })]}
        sparks={[spark("n1", "Spark A")]}
        activity={activity}
        navigate={() => {}}
        onSaved={() => {}}
      />
    );
    const toggle = container.querySelector<HTMLButtonElement>(".cp-kebab");
    expect(toggle).not.toBeNull();
    act(() => toggle!.click());
    // Re-render happened in-place; expansion row carries log lines + link.
    const lines = container.querySelectorAll(".cp-log-line");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(container.querySelector(".cp-expand-body")?.textContent).toContain("Live Console");
  });

  it("counted tabs filter the deployment list", () => {
    cleanupRenders();
    const { container } = render(
      <ModelsSection
        models={[model()]}
        recipes={[recipe()]}
        deployments={[dep(), dep({ recipeId: "r2", display: "stopped" })]}
        sparks={[spark("n1", "Spark A")]}
        activity={activity}
        navigate={() => {}}
        onSaved={() => {}}
      />
    );
    expect(container.querySelectorAll(".cp-deploy-row")).toHaveLength(2);
    const stoppedTab = [...container.querySelectorAll<HTMLButtonElement>(".cp-counted-tab")].find((b) => b.textContent?.includes("Stopped"));
    act(() => stoppedTab!.click());
    expect(container.querySelectorAll(".cp-deploy-row")).toHaveLength(1);
  });
});
