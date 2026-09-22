import { useCallback, useEffect, useState } from "react";

/**
 * Typed section router for the control plane. Deliberately NOT react-router —
 * the app already owns pushState/popstate and the surface is small. One
 * discriminated union, one serializer, alias-aware so legacy /spark/:id URLs
 * keep resolving. Showcase stays a separate full-screen route (useAppRoute).
 */

export type Section = "overview" | "models" | "fleet" | "activity" | "benchmarks" | "settings";

export type Route =
  | { section: "overview" }
  | { section: "models" }
  | { section: "model"; modelId: string; tab?: string; reqId?: number }
  | { section: "fleet" }
  | { section: "node"; nodeId: string }
  | { section: "activity"; reqId?: number }
  | { section: "benchmarks" }
  | { section: "settings" };

const SECTIONS: Section[] = ["overview", "models", "fleet", "activity", "benchmarks", "settings"];

/** Parse an optional `?reqId=N` deep-link param (ignored when non-numeric). */
function reqIdFromSearch(search: string): number | undefined {
  const raw = new URLSearchParams(search).get("reqId");
  if (raw == null || raw === "") return undefined;
  const n = Number(raw.replace(/^#/, ""));
  return Number.isFinite(n) ? n : undefined;
}

export function parseRoute(pathname: string, search = ""): Route {
  const parts = pathname.split("/").filter(Boolean);
  const reqId = reqIdFromSearch(search);
  if (parts.length === 0) return { section: "overview" };
  const [head, second, third] = parts;
  // Legacy alias: /spark/:id → a fleet node detail.
  if (head === "spark" && second) return { section: "node", nodeId: decodeURIComponent(second) };
  if (head === "models") {
    if (second) return { section: "model", modelId: decodeURIComponent(second), tab: third, reqId };
    return { section: "models" };
  }
  if (head === "fleet") {
    if (second) return { section: "node", nodeId: decodeURIComponent(second) };
    return { section: "fleet" };
  }
  if (head === "activity") return reqId != null ? { section: "activity", reqId } : { section: "activity" };
  if ((SECTIONS as string[]).includes(head)) return { section: head as Section };
  return { section: "overview" };
}

export function routeToPath(route: Route): string {
  switch (route.section) {
    case "overview":
      return "/";
    case "models":
      return "/models";
    case "model":
      return `/models/${encodeURIComponent(route.modelId)}${route.tab ? `/${route.tab}` : ""}${route.reqId != null ? `?reqId=${route.reqId}` : ""}`;
    case "fleet":
      return "/fleet";
    case "node":
      return `/fleet/${encodeURIComponent(route.nodeId)}`;
    case "activity":
      return route.reqId != null ? `/activity?reqId=${route.reqId}` : "/activity";
    case "benchmarks":
      return "/benchmarks";
    case "settings":
      return "/settings";
  }
}

export function sectionOf(route: Route): Section {
  if (route.section === "model") return "models";
  if (route.section === "node") return "fleet";
  return route.section;
}

export function useControlPlaneRoute(): {
  route: Route;
  navigate: (route: Route) => void;
} {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname, window.location.search));

  useEffect(() => {
    const handler = () => setRoute(parseRoute(window.location.pathname, window.location.search));
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  const navigate = useCallback((next: Route) => {
    // routeToPath carries the query in its returned string, so compare the
    // full URL to keep deep links (reqId) and plain section nav both correct.
    const path = routeToPath(next);
    if (path !== `${window.location.pathname}${window.location.search}`) {
      window.history.pushState(null, "", path);
    }
    setRoute(next);
  }, []);

  return { route, navigate };
}