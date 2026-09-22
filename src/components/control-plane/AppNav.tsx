import type { ReactNode } from "react";
import type { Route, Section } from "../../hooks/router";
import { sectionOf } from "../../hooks/router";

const NAV: { section: Section; label: string }[] = [
  { section: "overview", label: "Overview" },
  { section: "models", label: "Models" },
  { section: "fleet", label: "Fleet" },
  { section: "activity", label: "Activity" },
  { section: "benchmarks", label: "Benchmarks" },
  { section: "settings", label: "Settings" },
];

function BoltIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  );
}

interface AppNavProps {
  route: Route;
  navigate: (route: Route) => void;
  connected: boolean;
  stale: boolean;
  right?: ReactNode;
}

/** Fixed 6-item section nav. Nodes/models are content, never tabs. */
export function AppNav({ route, navigate, connected, stale, right }: AppNavProps) {
  const active = sectionOf(route);
  return (
    <header className="cp-topbar">
      <button
        type="button"
        className="cp-brand"
        onClick={() => navigate({ section: "overview" })}
        style={{ background: "none", border: "none", cursor: "pointer" }}
      >
        <BoltIcon className="text-accent" />
        <span>
          spark<span style={{ color: "var(--color-accent)" }}>Dash</span>
        </span>
        <span className="cp-brand-sub">AI Lab Control Plane</span>
      </button>
      <nav className="cp-nav" aria-label="Primary" style={{ marginLeft: 8 }}>
        {NAV.map((item) => (
          <button
            key={item.section}
            type="button"
            className={`cp-nav-item ${active === item.section ? "is-active" : ""}`}
            aria-current={active === item.section ? "page" : undefined}
            onClick={() => navigate({ section: item.section } as Route)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
        <span
          className={`cp-dot ${connected && !stale ? "running" : stale ? "stopping" : "error"}`}
          title={stale ? "Telemetry stale" : connected ? "Live" : "Disconnected"}
          aria-label={stale ? "Telemetry stale" : connected ? "Live telemetry" : "Disconnected"}
        />
        {right}
      </div>
    </header>
  );
}