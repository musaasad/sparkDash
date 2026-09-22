import { useCallback, useEffect, useSyncExternalStore } from "react";
import { cpSend } from "./useSnapshot";
import {
  useConsoleLines,
  useConsoleTelemetry,
  getConsoleConnectionStable,
  getConsoleConnectionServer,
  subscribeDomain,
  useConsoleMulti,
  type SourcedLine,
  type SourcedTelemetryRow,
} from "./domainStore";
import type { ConsoleLine, ConsoleTelemetryRow } from "../api/types";

/**
 * Subscribe to a recipe's Live Console over the shared WebSocket. The server
 * owns the SSH tail; this hook only sends subscribe/unsubscribe control frames
 * and reads the coalesced buffers from the domain store.
 */
export function useConsole(recipeId: string | null): {
  lines: readonly ConsoleLine[];
  telemetry: readonly ConsoleTelemetryRow[];
  connected: boolean;
  reason: string | null;
  resubscribe: () => void;
} {
  useEffect(() => {
    if (!recipeId) return;
    cpSend({ type: "console:subscribe", recipeId });
    return () => {
      if (recipeId) cpSend({ type: "console:unsubscribe", recipeId });
    };
  }, [recipeId]);

  const lines = useConsoleLines(recipeId ?? "");
  const telemetry = useConsoleTelemetry(recipeId ?? "");
  const conn = useSyncExternalStore(
    subscribeDomain,
    () => (recipeId ? getConsoleConnectionStable(recipeId) : getConsoleConnectionServer()),
    getConsoleConnectionServer
  );

  const resubscribe = useCallback(() => {
    if (recipeId) cpSend({ type: "console:subscribe", recipeId });
  }, [recipeId]);

  return { lines, telemetry, connected: conn.connected, reason: conn.reason, resubscribe };
}

/**
 * Multi-source variant — one row stream across several deployment recipes
 * (the Live Console's per-deployment / "All" source tabs). Rows carry their
 * owning recipeId so the caller can attribute node + model.
 */
export function useConsoleSources(recipeIds: readonly string[]): {
  lines: readonly SourcedLine[];
  telemetry: readonly SourcedTelemetryRow[];
  connected: boolean;
  reason: string | null;
  disconnectedRecipeId: string | null;
  resubscribe: () => void;
} {
  return useConsoleMulti(recipeIds);
}