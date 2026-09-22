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
  | { section: "model"; modelId: string; tab?: string }
  | { section: "fleet" }
  | { section: "node"; nodeId: string }
  | { section: "activity" }
  | { section: "benchmarks" }
  | { section: "settings" };

const SECTIONS: Section[] = ["overview", "models", "fleet", "activity", "benchmarks", "settings"];

export function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return { section: "overview" };
  const [head, second, third] = parts;
  // Legacy alias: /spark/:id → a fleet node detail.
  if (head === "spark" && second) return { section: "node", nodeId: decodeURIComponent(second) };
  if (head === "models") {
    if (second) return { section: "model", modelId: decodeURIComponent(second), tab: third };
    return { section: "models" };
  }
  if (head === "fleet") {
    if (second) return { section: "node", nodeId: decodeURIComponent(second) };
    return { section: "fleet" };
  }
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
      return `/models/${encodeURIComponent(route.modelId)}${route.tab ? `/${route.tab}` : ""}`;
    case "fleet":
      return "/fleet";
    case "node":
      return `/fleet/${encodeURIComponent(route.nodeId)}`;
    case "activity":
      return "/activity";
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
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    const handler = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  const navigate = useCallback((next: Route) => {
    const path = routeToPath(next);
    if (path !== window.location.pathname) {
      window.history.pushState(null, "", path);
    }
    setRoute(next);
  }, []);

  return { route, navigate };
}