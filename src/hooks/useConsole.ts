import { useEffect, useSyncExternalStore } from "react";
import { cpSend } from "./useSnapshot";
import {
  useConsoleLines,
  useConsoleTelemetry,
  getConsoleConnectionStable,
  getConsoleConnectionServer,
  subscribeDomain,
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

  return { lines, telemetry, connected: conn.connected, reason: conn.reason };
}