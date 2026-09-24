import { useEffect, useState } from "react";

type VersionInfo = {
  shortCommit?: string | null;
  mode?: string;
  builtAt?: string | null;
};

/**
 * Tiny, unobtrusive build/version marker for the sidebar footer. Answers
 * "which sparkDash is this machine showing?" (commit + mode) without cluttering
 * the main UI. Self-fetches /api/version once; hidden when unavailable or
 * unauthenticated (a fresh device that has not stored a token yet).
 */
export function BuildBadge() {
  const [v, setV] = useState<VersionInfo | null>(null);

  useEffect(() => {
    let alive = true;
    const token =
      (typeof localStorage !== "undefined" && localStorage.getItem("sparkdashToken")) || "";
    fetch("/api/version", { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d && typeof d === "object") setV(d as VersionInfo);
      })
      .catch(() => {
        /* not reachable / not authed yet — stay hidden */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!v || !v.shortCommit) return null;
  const mode =
    v.mode === "production" ? "prod" : v.mode === "development" ? "dev" : v.mode || "";
  const title = `sparkDash ${v.shortCommit} · ${v.mode || "unknown"}${
    v.builtAt ? ` · built ${v.builtAt}` : ""
  }`;
  return (
    <span className="cp-rail-build" title={title}>
      build {v.shortCommit}
      {mode ? ` · ${mode}` : ""}
    </span>
  );
}