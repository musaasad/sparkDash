import { useCallback, useEffect, useSyncExternalStore } from "react";
import { cpSend } from "./useSnapshot";
import type { ConsoleLine, ConsoleTelemetryRow, DeploymentStatus } from "../api/types";

/** Subscribe/unsubscribe control frames for a console recipe. */
function cpSendConsole(recipeId: string, on: boolean): void {
  cpSend({ type: on ? "console:subscribe" : "console:unsubscribe", recipeId });
}

/**
 * Control-plane client store — mirrors the metricsStore contract
 * (useSyncExternalStore + reference-stable slices) for the three new live
 * domains that must NOT ride the 1 s snapshot:
 *
 *  - console lines + telemetry rows per recipe (high-rate, capped),
 *  - deployment lifecycle states (server-derived; the client mirrors, never
 *    owns the state machine),
 *  - a coarse "has control-plane data yet" flag for skeleton states.
 *
 * Console appends are coalesced: the buffered arrays mutate in place and only
 * `appendSeq` bumps on a flush, so a burst of log lines causes at most one
 * re-render per consumer per flush tick.
 */

const MAX_LINES = 2000;

interface ConsoleSlice {
  lines: ConsoleLine[];
  telemetry: Map<number, ConsoleTelemetryRow>;
  order: number[]; // req ids, oldest→newest
  appendSeq: number;
  connected: boolean;
  reason: string | null;
}

const consoleSlices = new Map<string, ConsoleSlice>();
const deploymentMap = new Map<string, DeploymentStatus>();
const consoleViewSeq = new Map<string, number>(); // per-subscriber cached seq
const listeners = new Set<() => void>();
let cpReady = false;

function notify() {
  for (const l of listeners) l();
}

export function subscribeDomain(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function slice(recipeId: string): ConsoleSlice {
  let s = consoleSlices.get(recipeId);
  if (!s) {
    s = { lines: [], telemetry: new Map(), order: [], appendSeq: 0, connected: false, reason: null };
    consoleSlices.set(recipeId, s);
  }
  return s;
}

/** Seed a console from a console:init message (buffered history). */
export function seedConsole(
  recipeId: string,
  lines: ConsoleLine[],
  telemetry: ConsoleTelemetryRow[],
  ok: boolean,
  reason: string | null
): void {
  const s = slice(recipeId);
  s.lines = lines.slice(-MAX_LINES);
  s.telemetry.clear();
  s.order = [];
  for (const r of telemetry) {
    s.telemetry.set(r.reqId, r);
    s.order.push(r.reqId);
  }
  while (s.order.length > 500) s.telemetry.delete(s.order.shift() as number);
  s.connected = ok;
  s.reason = reason;
  s.appendSeq++;
  cpReady = true;
  notify();
}

/** Append a batch of console lines + finalized telemetry rows (coalesced). */
export function appendConsole(
  recipeId: string,
  lines: ConsoleLine[],
  telemetry: ConsoleTelemetryRow[]
): void {
  const s = slice(recipeId);
  if (lines.length) {
    s.lines.push(...lines);
    if (s.lines.length > MAX_LINES) s.lines.splice(0, s.lines.length - MAX_LINES);
  }
  for (const row of telemetry) {
    if (!s.telemetry.has(row.reqId)) s.order.push(row.reqId);
    s.telemetry.set(row.reqId, row);
    while (s.order.length > 500) s.telemetry.delete(s.order.shift() as number);
  }
  if (lines.length || telemetry.length) s.appendSeq++;
  notify();
}

export function setConsoleConnection(recipeId: string, connected: boolean, reason: string | null): void {
  const s = slice(recipeId);
  if (s.connected !== connected || s.reason !== reason) {
    s.connected = connected;
    s.reason = reason;
    s.appendSeq++; // version the stable connection view too
    notify();
  }
}

/** Reference-stable line array for a recipe (stable until appendSeq changes). */
export function getConsoleLines(recipeId: string): readonly ConsoleLine[] {
  const s = consoleSlices.get(recipeId);
  const cachedSeq = consoleViewSeq.get(recipeId);
  if (!s) return EMPTY_LINES;
  if (cachedSeq !== s.appendSeq) {
    consoleViewSeq.set(recipeId, s.appendSeq);
    lastLines.set(recipeId, s.lines.slice());
  }
  return lastLines.get(recipeId) as readonly ConsoleLine[];
}
const lastLines = new Map<string, readonly ConsoleLine[]>();
const EMPTY_LINES: readonly ConsoleLine[] = Object.freeze([] as ConsoleLine[]);

export function getConsoleTelemetry(recipeId: string): readonly ConsoleTelemetryRow[] {
  const s = consoleSlices.get(recipeId);
  if (!s) return EMPTY_TELEMETRY;
  const cachedSeq = consoleViewSeq.get(`${recipeId}:t`);
  if (cachedSeq !== s.appendSeq) {
    consoleViewSeq.set(`${recipeId}:t`, s.appendSeq);
    lastTelemetry.set(
      recipeId,
      s.order
        .slice()
        .reverse()
        .map((id) => s.telemetry.get(id))
        .filter((r): r is ConsoleTelemetryRow => Boolean(r))
    );
  }
  return lastTelemetry.get(recipeId) as readonly ConsoleTelemetryRow[];
}
const lastTelemetry = new Map<string, readonly ConsoleTelemetryRow[]>();
const EMPTY_TELEMETRY: readonly ConsoleTelemetryRow[] = Object.freeze([] as ConsoleTelemetryRow[]);

export function getConsoleConnection(recipeId: string): { connected: boolean; reason: string | null } {
  const s = consoleSlices.get(recipeId);
  return { connected: s?.connected ?? false, reason: s?.reason ?? null };
}

// Reference-stable connection view (required by useSyncExternalStore).
const connViews = new Map<string, { connected: boolean; reason: string | null }>();
const connSeen = new Map<string, number>();

export function getConsoleConnectionStable(recipeId: string): {
  connected: boolean;
  reason: string | null;
} {
  const s = consoleSlices.get(recipeId);
  const seq = s?.appendSeq ?? 0;
  const connected = s?.connected ?? false;
  const reason = s?.reason ?? null;
  const prev = connViews.get(recipeId);
  if (prev && connSeen.get(recipeId) === seq && prev.connected === connected && prev.reason === reason) {
    return prev;
  }
  const view = { connected, reason };
  connViews.set(recipeId, view);
  connSeen.set(recipeId, seq);
  return view;
}
const NO_CONN = Object.freeze({ connected: false, reason: null });
export function getConsoleConnectionServer(): { connected: boolean; reason: string | null } {
  return NO_CONN;
}

// ─── Deployment lifecycle mirror ──────────────────────────
let deploymentsCached: readonly DeploymentStatus[] | null = null;

function refreshDeploymentsCache() {
  deploymentsCached = [...deploymentMap.values()].sort((a, b) => a.recipeId.localeCompare(b.recipeId));
}

export function upsertDeployment(state: DeploymentStatus): void {
  deploymentMap.set(state.recipeId, state);
  refreshDeploymentsCache();
  notify();
}

export function setDeployments(list: readonly DeploymentStatus[]): void {
  deploymentMap.clear();
  for (const d of list) deploymentMap.set(d.recipeId, d);
  refreshDeploymentsCache();
  notify();
}

export function getDeployments(): readonly DeploymentStatus[] {
  if (deploymentsCached === null) refreshDeploymentsCache();
  return deploymentsCached as readonly DeploymentStatus[];
}

export function getDeployment(recipeId: string): DeploymentStatus | undefined {
  return deploymentMap.get(recipeId);
}

export function isCpReady(): boolean {
  return cpReady;
}

// ─── React hooks ──────────────────────────────────────────
export function useConsoleLines(recipeId: string): readonly ConsoleLine[] {
  return useSyncExternalStore(subscribeDomain, () => getConsoleLines(recipeId), () => EMPTY_LINES);
}

export function useConsoleTelemetry(recipeId: string): readonly ConsoleTelemetryRow[] {
  return useSyncExternalStore(
    subscribeDomain,
    () => getConsoleTelemetry(recipeId),
    () => EMPTY_TELEMETRY
  );
}

export function useDeployments(): readonly DeploymentStatus[] {
  return useSyncExternalStore(getNoopSubscribeForDeployments, getDeployments, () => EMPTY_DEPLOYMENTS);
}
const EMPTY_DEPLOYMENTS: readonly DeploymentStatus[] = Object.freeze([] as DeploymentStatus[]);
// Same listener set as console; a dedicated fn keeps the identity stable.
function getNoopSubscribeForDeployments(listener: () => void) {
  return subscribeDomain(listener);
}

export function useDeployment(recipeId: string): DeploymentStatus | undefined {
  return useSyncExternalStore(
    subscribeDomain,
    () => getDeployment(recipeId),
    () => undefined
  );
}

// ─── Multi-source console views (per-deployment tabs / "All") ───────────────
// The Live Console reads several recipes at once. These helpers hand back a
// single coalesced, reference-stable array with the owning recipeId attached,
// so callers can attribute rows to a node/model without re-slicing stores.

export interface SourcedLine {
  recipeId: string;
  line: ConsoleLine;
}

export interface SourcedTelemetryRow {
  recipeId: string;
  row: ConsoleTelemetryRow;
}

function idsKey(ids: readonly string[]): string {
  return [...ids].slice().sort().join("|");
}

function combinedSeq(ids: readonly string[]): string {
  return ids.map((id) => consoleSlices.get(id)?.appendSeq ?? 0).join(".");
}

const combinedLines = new Map<string, { seq: string; rows: readonly SourcedLine[] }>();
const combinedTelemetry = new Map<string, { seq: string; rows: readonly SourcedTelemetryRow[] }>();

export function getConsoleCombinedLines(ids: readonly string[]): readonly SourcedLine[] {
  if (!ids.length) return EMPTY_SOURCED_LINES;
  const key = idsKey(ids);
  const seq = combinedSeq(ids);
  const prev = combinedLines.get(key);
  if (prev && prev.seq === seq) return prev.rows;
  const rows: SourcedLine[] = [];
  for (const id of ids) {
    for (const line of getConsoleLines(id)) rows.push({ recipeId: id, line });
  }
  rows.sort((a, b) => (a.line.ts ?? "").localeCompare(b.line.ts ?? ""));
  const view = { seq, rows };
  combinedLines.set(key, view);
  return view.rows;
}
const EMPTY_SOURCED_LINES: readonly SourcedLine[] = Object.freeze([] as SourcedLine[]);

export function getConsoleCombinedTelemetry(ids: readonly string[]): readonly SourcedTelemetryRow[] {
  if (!ids.length) return EMPTY_SOURCED_TELEMETRY;
  const key = idsKey(ids);
  const seq = combinedSeq(ids);
  const prev = combinedTelemetry.get(key);
  if (prev && prev.seq === seq) return prev.rows;
  const rows: SourcedTelemetryRow[] = [];
  for (const id of ids) {
    for (const row of getConsoleTelemetry(id)) rows.push({ recipeId: id, row });
  }
  rows.sort((a, b) => (b.row.ts ?? "").localeCompare(a.row.ts ?? "") || b.row.reqId - a.row.reqId);
  const view = { seq, rows };
  combinedTelemetry.set(key, view);
  return view.rows;
}
const EMPTY_SOURCED_TELEMETRY: readonly SourcedTelemetryRow[] = Object.freeze([] as SourcedTelemetryRow[]);

/** First disconnected source among `ids` (feeds the reconnect banner). */
const COMBINED_DOWN = Object.freeze({ recipeId: null as string | null, reason: null as string | null });
export function getFirstDisconnected(ids: readonly string[]): {
  recipeId: string | null;
  reason: string | null;
} {
  for (const id of ids) {
    const s = consoleSlices.get(id);
    if (s && !s.connected) return { recipeId: id, reason: s.reason };
  }
  return COMBINED_DOWN;
}

/**
 * Subscribe to several console recipes at once. Sends subscribe frames for the
 * union and unsubscribe frames for those that dropped out — the server tail is
 * never restarted for filter-only changes.
 */
export function useConsoleMulti(recipeIds: readonly string[]): {
  lines: readonly SourcedLine[];
  telemetry: readonly SourcedTelemetryRow[];
  connected: boolean;
  reason: string | null;
  disconnectedRecipeId: string | null;
  resubscribe: () => void;
} {
  const ids = recipeIds;
  const lines = useSyncExternalStore(subscribeDomain, () => getConsoleCombinedLines(ids), () => EMPTY_SOURCED_LINES);
  const telemetry = useSyncExternalStore(
    subscribeDomain,
    () => getConsoleCombinedTelemetry(ids),
    () => EMPTY_SOURCED_TELEMETRY
  );
  const conn = useSyncExternalStore(
    subscribeDomain,
    () => getFirstDisconnectedStable(ids),
    () => COMBINED_DOWN
  );

  useEffect(() => {
    const sent = [...ids];
    for (const id of sent) cpSendConsole(id, true);
    return () => {
      for (const id of sent) cpSendConsole(id, false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey(ids)]);

  const resubscribe = useCallback(() => {
    for (const id of ids) cpSendConsole(id, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey(ids)]);

  return {
    lines,
    telemetry,
    connected: conn.recipeId === null,
    reason: conn.reason,
    disconnectedRecipeId: conn.recipeId,
    resubscribe,
  };
}

const downSeen = new Map<string, string>();
function getFirstDisconnectedStable(ids: readonly string[]) {
  const key = idsKey(ids);
  const seq = combinedSeq(ids);
  const prev = downViews.get(key);
  if (prev && downSeen.get(key) === seq) return prev;
  const view = getFirstDisconnected(ids);
  downViews.set(key, view);
  downSeen.set(key, seq);
  return view;
}
const downViews = new Map<string, { recipeId: string | null; reason: string | null }>();