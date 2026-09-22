/**
 * Runtime registry sourced ONCE from the WS-3 registry (`GET /api/runtimes`).
 *
 * Config-first: adding a provider runtime must need no FE edit, so every label
 * surface resolves against this registry map and falls back to the raw id only
 * for an unknown key. The cockpit ALSO reads each runtime's declared `metrics[]`
 * from the same single fetch, so it shows only the secondary instruments a
 * runtime actually exposes. A module-level cache guarantees one request.
 */
import { useEffect, useState } from "react";
import { fetchRuntimes } from "../../api/client";
import type { RuntimeProviderInfo } from "../../api/types";

export type RuntimeLabelMap = Record<string, string>;
export type RuntimeMetricsMap = Record<string, string[]>;
export interface RuntimeOption {
  id: string;
  label: string;
}

let cached: RuntimeProviderInfo[] | null = null;
let inflight: Promise<RuntimeProviderInfo[]> | null = null;

/** Fetch the registry once; resolve to the cached list thereafter. */
export function loadRuntimes(): Promise<RuntimeProviderInfo[]> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = (async () => {
      try {
        const res = await fetchRuntimes();
        cached = res?.runtimes ?? [];
      } catch {
        cached = [];
      }
      return cached;
    })();
  }
  return inflight;
}

/** Fetch registry labels once; resolve to the cached map thereafter. */
export function loadRuntimeLabels(): Promise<RuntimeLabelMap> {
  return loadRuntimes().then((list) => Object.fromEntries(list.map((x) => [x.id, x.label])));
}

/** Fetch the declared-metrics map once; resolve to the cached map thereafter. */
export function loadRuntimeMetrics(): Promise<RuntimeMetricsMap> {
  return loadRuntimes().then((list) => Object.fromEntries(list.map((x) => [x.id, x.metrics ?? []])));
}

/** React hook: the runtime label map (empty until the single fetch settles). */
export function useRuntimeLabels(): RuntimeLabelMap {
  const [map, setMap] = useState<RuntimeLabelMap>(() =>
    cached ? Object.fromEntries(cached.map((x) => [x.id, x.label])) : {}
  );
  useEffect(() => {
    let live = true;
    void loadRuntimeLabels().then((m) => {
      if (live) setMap(m);
    });
    return () => {
      live = false;
    };
  }, []);
  return map;
}

/** React hook: declared `metrics[]` per runtime (empty until fetch settles). */
export function useRuntimeMetrics(): RuntimeMetricsMap {
  const [map, setMap] = useState<RuntimeMetricsMap>(() =>
    cached ? Object.fromEntries(cached.map((x) => [x.id, x.metrics ?? []])) : {}
  );
  useEffect(() => {
    let live = true;
    void loadRuntimeMetrics().then((m) => {
      if (live) setMap(m);
    });
    return () => {
      live = false;
    };
  }, []);
  return map;
}

/** React hook: registry runtime options for pickers. */
export function useRuntimeOptions(): RuntimeOption[] {
  const map = useRuntimeLabels();
  return Object.entries(map).map(([id, label]) => ({ id, label }));
}
