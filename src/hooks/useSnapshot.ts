import { useEffect, useRef, useState, useCallback } from "react";
import type {
  SparkSnapshot,
  WsSnapshot,
  ConsoleInitMessage,
  ConsoleDataMessage,
  LifecycleMessage,
} from "../api/types";
import { ingestSnapshots } from "./metricsStore";
import {
  seedConsole,
  appendConsole,
  setConsoleConnection,
  upsertDeployment,
} from "./domainStore";
import { OVERVIEW_ID } from "../constants";

const TOKEN = (typeof localStorage !== "undefined" && localStorage.getItem("sparkdashToken")) || "";
const WS_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ""}`;
const RECONNECT_DELAY = 2000;

/** Shared socket for control-plane sends (console subscribe/unsubscribe). */
let activeSocket: WebSocket | null = null;

/** Send a control-plane control message over the live socket (no-op if down). */
export function cpSend(msg: Record<string, unknown>): boolean {
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

/**
 * useSnapshot — connects to the WebSocket and exposes live spark data.
 * Returns { sparks, activeId, setActiveId, activeSpark, connected }.
 */
export function useSnapshot() {
  const [sparks, setSparks] = useState<SparkSnapshot[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastValidSnapshotAt, setLastValidSnapshotAt] = useState<number | null>(null);
  const [snapshotGeneratedAt, setSnapshotGeneratedAt] = useState<number | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [refreshInterval, setRefreshInterval] = useState<number | null>(null);
  const [activeId, setActiveId] = useState<string | null>(OVERVIEW_ID);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** When false, onclose must not schedule reconnect (unmount / intentional close). */
  const shouldReconnect = useRef(true);

  // ─── Connect ─────────────────────────────────────────────
  const connect = useCallback(() => {
    if (!shouldReconnect.current) return;

    const state = wsRef.current?.readyState;
    // Avoid duplicate sockets while OPEN or still CONNECTING
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      // A socket alone is not healthy; wait for one valid snapshot.
      setConnected(false);
      activeSocket = ws;
      console.log("[ws] connected");
    };

    ws.onmessage = (ev) => {
      try {
        const msg: WsSnapshot | ConsoleInitMessage | ConsoleDataMessage | LifecycleMessage =
          JSON.parse(ev.data);
        // Control-plane channels are dispatched before the snapshot check so
        // they never trip the "invalid telemetry payload" error path.
        if (msg.type === "console:init") {
          seedConsole(msg.recipeId, msg.buffered || [], msg.telemetry || [], msg.ok, msg.reason || null);
          return;
        }
        if (msg.type === "console") {
          appendConsole(msg.recipeId, msg.lines || [], msg.telemetry || []);
          return;
        }
        if (msg.type === "lifecycle") {
          upsertDeployment(msg.state);
          return;
        }
        if (msg.type === "snapshot" && Array.isArray(msg.sparks)) {
          const receivedAt = Date.now();
          // Feed the central history store (8b) before notifying React state.
          ingestSnapshots(msg.sparks, msg.generatedAt ?? receivedAt);
          setSparks(msg.sparks);
          setConnected(true);
          setLastValidSnapshotAt(receivedAt);
          setSnapshotGeneratedAt(
            Number.isFinite(msg.generatedAt) ? Number(msg.generatedAt) : null
          );
          setRefreshInterval(
            Number.isFinite(msg.refreshInterval) ? Number(msg.refreshInterval) : null
          );
          setSnapshotError(null);
          // Default to the Overview tab; keep the current selection if it
          // is still valid (Overview is always valid).
          setActiveId((prev) => {
            if (prev === OVERVIEW_ID) return OVERVIEW_ID;
            if (prev && msg.sparks.some((s) => s.id === prev)) return prev;
            return OVERVIEW_ID;
          });
        } else {
          setSnapshotError("The server sent an invalid telemetry payload.");
        }
      } catch {
        setSnapshotError("The server sent malformed telemetry data.");
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      if (!shouldReconnect.current) return;
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  // ─── Lifecycle ───────────────────────────────────────────
  useEffect(() => {
    shouldReconnect.current = true;
    connect();
    return () => {
      shouldReconnect.current = false;
      clearTimeout(reconnectTimer.current);
      const ws = wsRef.current;
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.close();
      }
      wsRef.current = null;
    };
  }, [connect]);

  // ─── Derived state ──────────────────────────────────────
  const activeSpark = sparks.find((s) => s.id === activeId) || null;

  return {
    sparks,
    connected,
    activeId,
    setActiveId,
    activeSpark,
    lastValidSnapshotAt,
    snapshotGeneratedAt,
    snapshotError,
    refreshInterval,
  };
}
