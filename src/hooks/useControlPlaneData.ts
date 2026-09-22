import { useCallback, useEffect, useState } from "react";
import {
  fetchModels,
  fetchRecipes,
  fetchDeployments,
  fetchActivity,
} from "../api/client";
import { setDeployments } from "./domainStore";
import type { ModelEntry, RecipePublic, ActivityEvent } from "../api/types";

/**
 * Loads the control-plane domain (models, recipes, deployments, activity) and
 * keeps it fresh. Deployment states are mirrored into the domain store so the
 * WS lifecycle messages and the initial REST load share one source of truth.
 */
export function useControlPlaneData(refreshMs = 8000) {
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [recipes, setRecipes] = useState<RecipePublic[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [m, r, d, a] = await Promise.all([
        fetchModels(true).catch(() => ({ models: [] as ModelEntry[] })),
        fetchRecipes(true).catch(() => ({ recipes: [] as RecipePublic[] })),
        fetchDeployments().catch(() => ({ deployments: [], dryRun: true })),
        fetchActivity(80).catch(() => ({ events: [] as ActivityEvent[] })),
      ]);
      setModels(m.models);
      setRecipes(r.recipes);
      setDeployments(d.deployments);
      setActivity(a.events);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), refreshMs);
    return () => clearInterval(timer);
  }, [reload, refreshMs]);

  return { models, recipes, activity, loaded, error, reload };
}