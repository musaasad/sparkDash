import { describe, it, expect, vi } from "vitest";
import {
  seedConsole,
  appendConsole,
  getConsoleLines,
  getConsoleTelemetry,
  getConsoleConnectionStable,
  setConsoleConnection,
  upsertDeployment,
  getDeployments,
  getDeployment,
  subscribeDomain,
} from "./domainStore";
import type { ConsoleLine, ConsoleTelemetryRow, DeploymentStatus } from "../api/types";

const line = (msg: string): ConsoleLine => ({ ts: "2026-09-21T20:00:00.000", level: "INFO", msg, raw: msg });
const row = (reqId: number, over: Partial<ConsoleTelemetryRow> = {}): ConsoleTelemetryRow => ({
  reqId,
  ts: null,
  state: "inflight",
  promptTokens: 100,
  generatedTokens: null,
  cachedPct: null,
  newPromptTokens: null,
  prefillTps: null,
  ttftSeconds: null,
  decodeTps: null,
  totalSeconds: null,
  draftAccepted: null,
  draftAttempted: null,
  draftPct: null,
  toolCalls: 0,
  temperature: null,
  ...over,
});

describe("domainStore console buffers", () => {
  it("seeds and appends with reference-stable views", () => {
    seedConsole("r1", [line("a")], [row(1)], true, null);
    const v1 = getConsoleLines("r1");
    expect(v1).toHaveLength(1);
    // unchanged → same reference (useSyncExternalStore contract)
    expect(getConsoleLines("r1")).toBe(v1);

    appendConsole("r1", [line("b")], []);
    const v2 = getConsoleLines("r1");
    expect(v2).toHaveLength(2);
    expect(v2).not.toBe(v1);
  });

  it("merges telemetry by request id and orders newest first", () => {
    seedConsole("r2", [], [row(1), row(2)], true, null);
    appendConsole("r2", [], [row(2, { state: "done", generatedTokens: 50 })]);
    const rows = getConsoleTelemetry("r2");
    expect(rows.map((r) => r.reqId)).toEqual([2, 1]);
    expect(rows[0].state).toBe("done");
    expect(rows[0].generatedTokens).toBe(50);
  });

  it("caps telemetry at 500 rows", () => {
    const rows = Array.from({ length: 520 }, (_, i) => row(i + 1));
    seedConsole("r3", [], rows, true, null);
    expect(getConsoleTelemetry("r3").length).toBe(500);
  });

  it("versions the connection view without mutating identity unnecessarily", () => {
    seedConsole("r4", [], [], true, null);
    const c1 = getConsoleConnectionStable("r4");
    expect(getConsoleConnectionStable("r4")).toBe(c1);
    setConsoleConnection("r4", false, "tail exited");
    const c2 = getConsoleConnectionStable("r4");
    expect(c2).not.toBe(c1);
    expect(c2).toEqual({ connected: false, reason: "tail exited" });
  });

  it("notifies subscribers on append", () => {
    seedConsole("r5", [], [], true, null);
    const fn = vi.fn();
    const unsub = subscribeDomain(fn);
    appendConsole("r5", [line("x")], []);
    expect(fn).toHaveBeenCalled();
    unsub();
    fn.mockClear();
    appendConsole("r5", [line("y")], []);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("domainStore deployment mirror", () => {
  it("upserts and lists sorted by recipe id", () => {
    const d = (recipeId: string, state: DeploymentStatus["state"]): DeploymentStatus => ({
      recipeId, modelId: "m", nodeIds: [], apiPort: 1, managedBy: "sparkdash", dryRun: true, state,
      desired: state === "running" ? "running" : "stopped",
      observed: state === "running" ? "running" : "not-detected",
      discovered: false,
      display: state === "error" ? "degraded" : (state as DeploymentStatus["display"]),
      lastOp: null, lastError: null, startedAt: null, updatedAt: 0,
    });
    upsertDeployment(d("b", "running"));
    upsertDeployment(d("a", "stopped"));
    expect(getDeployments().map((x) => x.recipeId)).toEqual(["a", "b"]);
    expect(getDeployment("a")?.state).toBe("stopped");
  });
});