/**
 * Rolling telemetry history — a small per-deployment ring buffer (last ~60
 * samples) fed from the WS-driven telemetry updates. It gives the gauge a real
 * recent operating RANGE instead of a fake 0–100, and derives request recency
 * from the cumulative `totalOutputTokens` change signal.
 *
 * The reducer is pure so the window/recency logic is unit-testable.
 */
import { useEffect, useRef, useState } from "react";
import type { DeploymentView } from "./fleetModel";

export const HISTORY_CAP = 60;

export interface TelemetryHistoryEntry {
  /** Recent generationTps samples, oldest → newest. */
  samples: number[];
  /** ms timestamp of the last observed output-token increase, else null. */
  lastRequestAt: number | null;
  /** Last cumulative output-token counter per deployment key (change detector). */
  lastTokens: number | null;
}

export type TelemetryHistory = Record<string, TelemetryHistoryEntry>;

/** Pure: fold one telemetry snapshot into the ring buffer. */
export function recordTelemetry(prev: TelemetryHistory, views: readonly DeploymentView[], now: number): TelemetryHistory {
  const next: TelemetryHistory = {};
  for (const v of views) {
    const key = v.key;
    const prior = prev[key];
    const entry: TelemetryHistoryEntry = prior
      ? { samples: prior.samples, lastRequestAt: prior.lastRequestAt, lastTokens: prior.lastTokens }
      : { samples: [], lastRequestAt: null, lastTokens: null };

    const tps = v.telemetry?.generationTps;
    if (typeof tps === "number" && Number.isFinite(tps)) {
      entry.samples = [...entry.samples, tps].slice(-HISTORY_CAP);
    }

    const tokens = v.telemetry?.totalOutputTokens;
    if (typeof tokens === "number" && Number.isFinite(tokens)) {
      if (entry.lastTokens != null && tokens > entry.lastTokens) entry.lastRequestAt = now;
      entry.lastTokens = tokens;
    }
    next[key] = entry;
  }
  return next;
}

/** Recent operating range for a key (>=2 samples), else null — no fake range. */
export function observedRange(samples: readonly number[]): { min: number; max: number; peak: number; avg: number } | null {
  const vals = samples.filter((n) => Number.isFinite(n));
  if (vals.length < 2) return null;
  const peak = Math.max(...vals);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { min: Math.min(...vals), max: peak, peak, avg };
}

/**
 * Stable signature of the telemetry signals. The parent may hand a fresh `[]`
 * default array on every render, so keying the effect on array identity would
 * loop forever; the signature only changes when a real sample arrives.
 */
export function telemetrySignature(views: readonly DeploymentView[]): string {
  return views
    .map((v) => `${v.key}:${v.telemetry?.generationTps ?? ""}:${v.telemetry?.totalOutputTokens ?? ""}`)
    .join("|");
}

/** React hook: live ring buffer keyed by deployment key. */
export function useTelemetryHistory(views: readonly DeploymentView[]): TelemetryHistory {
  const [history, setHistory] = useState<TelemetryHistory>({});
  const latest = useRef(views);
  latest.current = views;
  const sig = telemetrySignature(views);
  useEffect(() => {
    setHistory((prev) => recordTelemetry(prev, latest.current, Date.now()));
  }, [sig]);
  return history;
}
