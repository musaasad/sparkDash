/**
 * Runtime label map sourced ONCE from the WS-3 registry (`GET /api/runtimes`).
 *
 * Config-first: adding a provider runtime must need no FE edit, so every label
 * surface resolves against this registry map and falls back to the raw id only
 * for an unknown key. A module-level cache guarantees a single fetch.
 */
import { useEffect, useState } from "react";
import { fetchRuntimes } from "../../api/client";

export type RuntimeLabelMap = Record<string, string>;
export interface RuntimeOption {
  id: string;
  label: string;
}

let cached: RuntimeLabelMap | null = null;
let inflight: Promise<RuntimeLabelMap> | null = null;

/** Fetch registry labels once; resolve to the cached map thereafter. */
export function loadRuntimeLabels(): Promise<RuntimeLabelMap> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = (async () => {
      try {
        const res = await fetchRuntimes();
        cached = Object.fromEntries((res?.runtimes ?? []).map((x) => [x.id, x.label]));
      } catch {
        cached = {};
      }
      return cached;
    })();
  }
  return inflight;
}

/** React hook: the runtime label map (empty until the single fetch settles). */
export function useRuntimeLabels(): RuntimeLabelMap {
  const [map, setMap] = useState<RuntimeLabelMap>(cached ?? {});
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

/** React hook: registry runtime options for pickers. */
export function useRuntimeOptions(): RuntimeOption[] {
  const map = useRuntimeLabels();
  return Object.entries(map).map(([id, label]) => ({ id, label }));
}
