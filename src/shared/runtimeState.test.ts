/**
 * P0: canonical runtime-state module contract. Hermetic, pure.
 */
import { describe, it, expect } from "vitest";
import {
  RUNTIME_STATE,
  TELEMETRY_QUALITY,
  probeOutcome,
  telemetryQuality,
  deriveRuntimeState,
  llmMonitoringEnabled,
  deriveComputeOnline,
  isReachableFromProbe,
} from "./runtimeState.js";

describe("canonical runtimeState vocabulary", () => {
  it("exposes the full canonical state + quality vocabulary", () => {
    expect(RUNTIME_STATE.SERVING).toBe("serving");
    expect(RUNTIME_STATE.OFFLINE).toBe("offline");
    expect(RUNTIME_STATE.UNKNOWN).toBe("unknown");
    expect(TELEMETRY_QUALITY.STALE).toBe("stale");
    expect(TELEMETRY_QUALITY.PARTIAL).toBe("partial");
  });

  it("PARTIAL when some optional metrics are present, some missing", () => {
    expect(telemetryQuality({ available: true, generationTps: 1 })).toBe("partial");
  });

  it("STALE when the snapshot age exceeds the threshold", () => {
    expect(telemetryQuality({ available: true }, { telemetryAgeMs: 99_999, staleMs: 1_000 })).toBe("stale");
  });

  it("ABSENT when telemetry is unavailable", () => {
    expect(telemetryQuality(null)).toBe("absent");
    expect(telemetryQuality({ available: false })).toBe("absent");
  });

  it("probeOutcome marks a keyed 401 reachable, not a hard transport failure", () => {
    const out = probeOutcome({ status: 401, hasKey: false });
    expect(out.reachable).toBe(true);
    expect(out.keyedWithoutKey).toBe(true);
    expect(out.hardTransport).toBe(false);
    expect(out.authError).toMatch(/api key required/i);
    expect(isReachableFromProbe({ status: 403 })).toBe(true);
  });

  it("derives OFFLINE only from explicit absence", () => {
    expect(deriveRuntimeState({ display: "stopped" })).toBe("offline");
    expect(deriveRuntimeState({ observed: "not-detected" })).toBe("offline");
  });

  it("never OFFLINE for a reachable endpoint with missing optional telemetry", () => {
    const state = deriveRuntimeState({
      display: "running",
      managedBy: "external",
      observed: "auth-gated",
      telemetry: { available: false, error: "API key required (401)" },
      reachable: true,
      keyedWithoutKey: true,
    });
    expect(state).not.toBe("offline");
    expect(state).toBe("reachable");
  });

  it("SERVING requires observed active generation", () => {
    expect(deriveRuntimeState({ display: "running", telemetry: { available: true, requestsRunning: 1, modelId: "m" }, reachable: true })).toBe("serving");
    expect(deriveRuntimeState({ display: "running", telemetry: { available: true, generationTps: 12, modelId: "m" }, reachable: true })).toBe("serving");
  });

  it("loaded + no work reads READY (never served) or IDLE (served)", () => {
    const base = { display: "running", reachable: true };
    expect(deriveRuntimeState({ ...base, telemetry: { available: true, modelId: "m", slotsTotal: 2 } })).toBe("ready");
    expect(deriveRuntimeState({ ...base, telemetry: { available: true, modelId: "m", slotsTotal: 2, totalOutputTokens: 50 } })).toBe("idle");
  });

  it("stale snapshots never claim SERVING", () => {
    const state = deriveRuntimeState({
      display: "running",
      reachable: true,
      telemetryAgeMs: 60_000,
      staleMs: 30_000,
      telemetry: { available: true, requestsRunning: 3, modelId: "m", totalOutputTokens: 9 },
    });
    expect(state).toBe("idle");
  });

  it("F1: not-detected is OFFLINE only when NOT reachable", () => {
    // Unreachable + no endpoint evidence ⇒ OFFLINE (unchanged).
    expect(deriveRuntimeState({ observed: "not-detected", reachable: false })).toBe("offline");
    expect(deriveRuntimeState({ observed: "not-detected" })).toBe("offline");
    // Reachable but telemetry simply unobserved ⇒ READY/UNKNOWN, NEVER offline.
    const reachable = deriveRuntimeState({ observed: "not-detected", reachable: true, telemetry: null });
    expect(reachable).not.toBe("offline");
    expect(["ready", "unknown"]).toContain(reachable);
    expect(reachable).toBe("ready");
  });

  it("F2: observed active generation is SERVING even when available=false", () => {
    expect(
      deriveRuntimeState({
        observed: "running",
        reachable: false,
        telemetry: { available: false, generationTps: 42 },
      })
    ).toBe("serving");
    expect(
      deriveRuntimeState({
        observed: "not-detected",
        reachable: true,
        telemetry: { available: false, requestsRunning: 1 },
      })
    ).toBe("serving");
  });

  it("F3: telemetry older than the threshold degrades to STALE (not current SERVING)", () => {
    const state = deriveRuntimeState({
      display: "running",
      reachable: true,
      telemetryAgeMs: 60_000,
      staleMs: 30_000,
      telemetry: { available: true, generationTps: 42, modelId: "m", totalOutputTokens: 9 },
    });
    expect(state).not.toBe("serving");
    expect(["ready", "reachable", "degraded", "unknown", "idle"]).toContain(state);
    expect(state).toBe("idle");
  });

  it("compute online vocabulary", () => {
    expect(deriveComputeOnline({ online: true })).toBe("online");
    expect(deriveComputeOnline({ online: false })).toBe("offline");
    expect(deriveComputeOnline({})).toBe("unknown");
  });

  it("llmMonitoring opt-in for workers", () => {
    expect(llmMonitoringEnabled({ role: "worker" })).toBe(false);
    expect(llmMonitoringEnabled({ role: "worker", llmMonitoring: true })).toBe(true);
    expect(llmMonitoringEnabled({ role: "head", llmMonitoring: false })).toBe(false);
  });
});
