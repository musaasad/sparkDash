import { useState } from "react";
import type { ReactNode } from "react";
import type { Route, Section } from "../../hooks/router";
import { sectionOf } from "../../hooks/router";
import {
  ActivityIcon,
  BoltIcon,
  BotIcon,
  ChevronDownIcon,
  GearIcon,
  GridIcon,
  NetworkIcon,
  PanelIcon,
  SearchIcon,
} from "../ui/icons";

const NAV_GROUPS: { section: Section; label: string; Icon: (p: { className?: string }) => ReactNode }[][] = [
  [{ section: "overview", label: "Overview", Icon: GridIcon }],
  [{ section: "models", label: "Models", Icon: BotIcon }],
  [{ section: "fleet", label: "Fleet", Icon: NetworkIcon }],
  [
    { section: "activity", label: "Activity", Icon: ActivityIcon },
    { section: "benchmarks", label: "Benchmarks", Icon: BoltIcon },
  ],
];

interface AppNavProps {
  route: Route;
  navigate: (route: Route) => void;
  connected: boolean;
  stale: boolean;
  /** Optional live counts, rendered as right-aligned muted numerals. */
  counts?: Partial<Record<Section, number>>;
  /** Extra rail utilities (e.g. theme switch) shown above the workspace card. */
  right?: ReactNode;
  workspaceName?: string;
  operatorId?: string;
  onSearch?: () => void;
}

/**
 * Fixed 230px control-plane rail. Groups are hairline-separated with no group
 * titles; Settings is pinned outside the scroll area. Active state is a
 * full-width amber `selected` tint with a 600 label and accent icon — never a
 * left-border indicator. Counts are muted numerals, never pills.
 */
export function AppNav({
  route,
  navigate,
  connected,
  stale,
  counts,
  right,
  workspaceName = "Mia'a AI Lab",
  operatorId = "operator",
  onSearch,
}: AppNavProps) {
  const [collapsed, setCollapsed] = useState(false);
  const active = sectionOf(route);

  const renderItem = (section: Section, label: string, Icon: (p: { className?: string }) => ReactNode) => {
    const isActive = active === section;
    const count = counts?.[section];
    return (
      <button
        key={section}
        type="button"
        className={`cp-nav-item ${isActive ? "is-active" : ""}`}
        aria-current={isActive ? "page" : undefined}
        onClick={() => navigate({ section } as Route)}
        title={collapsed ? label : undefined}
      >
        <Icon />
        <span className="cp-nav-label">{label}</span>
        {count != null ? <span className="cp-nav-count">{count}</span> : null}
      </button>
    );
  };

  return (
    <aside className={`cp-rail ${collapsed ? "is-collapsed" : ""}`} aria-label="Primary">
      <div className="cp-rail-head">
        <button
          type="button"
          className="cp-brand"
          onClick={() => navigate({ section: "overview" })}
          aria-label="sparkDash — go to Overview"
        >
          <BoltIcon />
          <span>
            spark<span style={{ color: "var(--color-accent)" }}>Dash</span>
          </span>
        </button>
        <button type="button" className="cp-ws-chevron" title="Switch workspace">
          {workspaceName}
          <ChevronDownIcon />
        </button>
        <button
          type="button"
          className="cp-rail-collapse"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          title={collapsed ? "Expand" : "Collapse"}
        >
          <PanelIcon />
        </button>
      </div>

      <button type="button" className="cp-rail-search" onClick={onSearch} aria-label="Search">
        <SearchIcon />
        <span className="cp-nav-label">Search</span>
        <span className="cp-rail-keycap">⌘K</span>
      </button>

      <nav className="cp-rail-scroll">
        {NAV_GROUPS.map((group, i) => (
          <div className="cp-nav-group" key={i}>
            {group.map((item) => renderItem(item.section, item.label, item.Icon))}
          </div>
        ))}
      </nav>

      {/* Settings is pinned above the footer, outside the scroll area. */}
      <div className="cp-rail-foot">
        {renderItem("settings", "Settings", GearIcon)}
        {right ? <div className="cp-rail-status">{right}</div> : null}
        <div className="cp-rail-ws">
          <span className="cp-rail-avatar" aria-hidden="true">
            {workspaceName.slice(0, 2).toUpperCase()}
          </span>
          <span style={{ minWidth: 0 }}>
            <span className="cp-rail-ws-name" style={{ display: "block" }}>
              {workspaceName}
            </span>
            <span className="cp-rail-ws-op" style={{ display: "block" }}>
              {operatorId}
            </span>
          </span>
          <span
            className={`cp-dot ${connected && !stale ? "running" : stale ? "stopping" : "offline"}`}
            title={stale ? "Telemetry stale" : connected ? "Live" : "Disconnected"}
            aria-label={stale ? "Telemetry stale" : connected ? "Live telemetry" : "Disconnected"}
          />
        </div>
      </div>
    </aside>
  );
}
