import { useEffect, useMemo, useState } from "react";
import type { ActivityEvent } from "../../api/types";
import { DataTable, EntityChip, type Column } from "../ui/DataTable";
import { Chip, SkeletonRows } from "../ui/Status";
import { SectionBand } from "../ui/SectionBand";
import { Modal } from "../ui/Modal";
import { ActivityIcon } from "../ui/icons";
import {
  ACTIVITY_WINDOWS,
  ACTIVITY_SOURCES,
  ACTIVITY_LEVEL_LABELS,
  absoluteTs,
  activityDuration,
  activityFacets,
  activityFields,
  activityLevel,
  activityRawLine,
  activitySentence,
  activitySource,
  applyLevels,
  dedupeActivity,
  filterActivity,
  relativeTs,
  type ActivityLevel,
  type ActivitySource,
  type ActivityWindowKey,
  type DedupedActivity,
} from "./activityModel";

interface ActivityProps {
  events: ActivityEvent[];
  /** Optional local clear (server JSONL is never touched — dry-run). */
  onClearActivity?: (newestSeq: number) => void;
  /** Deep link into the Live Console for error rows (carries the reqId). */
  onOpenInConsole?: (event: ActivityEvent) => void;
  /** Deep-link target: auto-expand + highlight the event carrying this reqId. */
  reqId?: number;
  /** Controlled local clear cursor; falls back to internal state when absent. */
  clearedUpTo?: number | null;
  loading?: boolean;
}

function copy(text: string) {
  const p = navigator.clipboard?.writeText?.(text);
  if (p) void p.catch(() => {});
}

/**
 * Unified activity feed — real events only. Persistent toolbar (search, severity
 * facets with live counts, source, range), deduped rows, inline expansion, and
 * an explicit Following/Paused stream state.
 */
export function ActivitySection({ events, onClearActivity, onOpenInConsole, reqId, clearedUpTo, loading = false }: ActivityProps) {
  const [query, setQuery] = useState("");
  const [levels, setLevels] = useState<ActivityLevel[]>([]);
  const [source, setSource] = useState<ActivitySource | "all">("all");
  const [windowKey, setWindowKey] = useState<ActivityWindowKey>("24h");
  const [paused, setPaused] = useState(false);
  const [frozenAt, setFrozenAt] = useState<number | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [confirmClear, setConfirmClear] = useState(false);
  /** Local dry-run clear: hide events up to the newest seq at clear time. */
  const [localCleared, setLocalCleared] = useState<number | null>(null);
  const cleared = clearedUpTo !== undefined ? clearedUpTo : localCleared;

  /** Deep link: expand + highlight the first event carrying the requested reqId. */
  const matchedSeq = useMemo(() => {
    if (reqId == null) return null;
    return events.find((e) => e.meta?.reqId != null && Number(e.meta.reqId) === reqId)?.seq ?? null;
  }, [events, reqId]);

  useEffect(() => {
    if (matchedSeq == null) return;
    setOpen((prev) => new Set(prev).add(String(matchedSeq)));
  }, [matchedSeq]);

  // Following freezes the visible set at pause time; resume releases it.
  const base = useMemo(() => {
    const scopedEvents = cleared == null ? events : events.filter((e) => e.seq > cleared);
    return paused && frozenAt != null ? scopedEvents.filter((e) => Date.parse(e.ts) <= frozenAt) : scopedEvents;
  }, [events, paused, frozenAt, cleared]);

  // Facets count over query/source/window — before severity is applied.
  const scoped = useMemo(() => filterActivity(base, { query, source, window: windowKey }), [base, query, source, windowKey]);
  const facets = useMemo(() => activityFacets(scoped), [scoped]);
  const filtered = useMemo(() => applyLevels(scoped, levels), [scoped, levels]);
  const rows = useMemo(() => dedupeActivity(filtered), [filtered]);

  const lastSync = rows[0] ? relativeTs(rows[0].event.ts) : "—";
  const hasFilters = query.trim() !== "" || levels.length > 0 || source !== "all" || windowKey !== "24h";

  const clearFilters = () => {
    setQuery("");
    setLevels([]);
    setSource("all");
    setWindowKey("24h");
  };

  const toggleLevel = (level: ActivityLevel) =>
    setLevels((prev) => (prev.includes(level) ? prev.filter((l) => l !== level) : [...prev, level]));

  const toggleExpand = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const columns: Column<DedupedActivity>[] = [
    {
      key: "ts",
      header: "When",
      mono: true,
      muted: true,
      width: "86px",
      render: (r) => <span title={absoluteTs(r.event.ts)}>{relativeTs(r.event.ts)}</span>,
    },
    {
      key: "level",
      header: "Level",
      width: "96px",
      render: (r) => (
        <span className="cp-activity-level">
          <span className={`cp-activity-gutter ${r.level}`} aria-hidden="true" />
          <span className={`cp-activity-badge ${r.level}`}>{ACTIVITY_LEVEL_LABELS[r.level]}</span>
        </span>
      ),
    },
    {
      key: "sentence",
      header: "Event",
      render: (r) => (
        <button
          type="button"
          className={`cp-activity-sentence${matchedSeq != null && r.event.seq === matchedSeq ? " is-deep-link" : ""}`}
          onClick={() => toggleExpand(String(r.event.seq))}
        >
          <span className="cp-activity-msg">{activitySentence(r.event)}</span>
          <span className="muted"> · {r.event.attribution?.actor ?? "unknown"}</span>
          {r.count > 1 ? <Chip className="cp-activity-count">×{r.count}</Chip> : null}
        </button>
      ),
    },
    { key: "source", header: "Source", width: "92px", render: (r) => <Chip tone="mono">{r.source}</Chip> },
    {
      key: "duration",
      header: "Duration",
      align: "right",
      width: "78px",
      render: (r) => {
        const d = activityDuration(r.event);
        return d ? <Chip tone="mono">{d}</Chip> : <span className="muted">—</span>;
      },
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="cp-toolbar" role="search">
        <div className="cp-toolbar-search">
          <input
            type="search"
            aria-label="Search activity"
            placeholder="Search actor, subject, message…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="cp-toolbar-filters">
          {facets.map((f) => (
            <button
              key={f.level}
              type="button"
              className={`cp-activity-facet ${f.level}`}
              aria-pressed={levels.includes(f.level)}
              data-active={levels.includes(f.level) ? "true" : undefined}
              onClick={() => toggleLevel(f.level)}
            >
              <span className={`cp-dot ${f.level}`} aria-hidden="true" />
              {f.label} <span className="cp-activity-facetcount">{f.count}</span>
            </button>
          ))}
          <select
            className="cp-select cp-activity-source"
            aria-label="Activity source"
            value={source}
            onChange={(e) => setSource(e.target.value as ActivitySource | "all")}
          >
            <option value="all">All sources</option>
            {ACTIVITY_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="cp-toolbar-primary">
          {hasFilters ? (
            <button type="button" className="cp-btn ghost" onClick={clearFilters}>
              Clear filters
            </button>
          ) : null}
          <span className={`cp-activity-followstate ${paused ? "is-paused" : "is-following"}`}>
            <span className={`cp-dot ${paused ? "warning" : "running"}`} aria-hidden="true" />
            {paused ? "Paused" : "Following"}
          </span>
          <span className="cp-activity-lastsync">synced {lastSync}</span>
          {paused ? (
            <button
              type="button"
              className="cp-btn ghost"
              onClick={() => {
                setPaused(false);
                setFrozenAt(null);
              }}
            >
              Resume follow
            </button>
          ) : (
            <button
              type="button"
              className="cp-btn ghost"
              onClick={() => {
                setFrozenAt(Date.now());
                setPaused(true);
              }}
            >
              Pause
            </button>
          )}
          <button type="button" className="cp-btn ghost" disabled={base.length === 0} onClick={() => setConfirmClear(true)}>
            Clear history
          </button>
        </div>
      </div>

      <Modal
        open={confirmClear}
        title="Clear activity history?"
        consequence={`Hides the ${base.length} locally loaded events. The server JSONL log stays on disk (dry-run clear).`}
        confirmLabel="Clear"
        cancelLabel="Keep"
        tone="danger"
        onConfirm={() => {
          const newestSeq = base.reduce((m, e) => Math.max(m, e.seq), 0);
          if (clearedUpTo !== undefined) onClearActivity?.(newestSeq);
          else setLocalCleared(newestSeq || null);
          setOpen(new Set());
          setConfirmClear(false);
        }}
        onClose={() => setConfirmClear(false)}
      />

      <SectionBand
        icon={<ActivityIcon />}
        title="Activity"
        count={rows.length}
        local={
          <div className="cp-activity-windows">
            {ACTIVITY_WINDOWS.map((w) => (
              <button
                key={w.key}
                type="button"
                className={`cp-activity-window${windowKey === w.key ? " is-active" : ""}`}
                aria-pressed={windowKey === w.key}
                onClick={() => setWindowKey(w.key)}
              >
                {w.label}
              </button>
            ))}
          </div>
        }
      />

      {loading && rows.length === 0 ? (
        <SkeletonRows columns={5} />
      ) : (
        <DataTable
          ariaLabel="Activity feed"
          columns={columns}
          rows={rows}
          rowKey={(r) => String(r.event.seq)}
          empty={
            <span className="cp-table-empty-box">
              {hasFilters
                ? "No events match these filters — widen the range or clear the filters."
                : "No activity yet — node transitions, lifecycle operations and benchmark runs appear here."}
            </span>
          }
          expandedKeys={open}
          renderExpanded={(r) => <ActivityExpansion event={r.event} onOpenInConsole={onOpenInConsole} />}
        />
      )}
    </div>
  );
}

function ActivityExpansion({ event, onOpenInConsole }: { event: ActivityEvent; onOpenInConsole?: (event: ActivityEvent) => void }) {
  const fields = activityFields(event);
  const raw = activityRawLine(event);
  const meta = event.meta ?? {};
  const reqId = meta.reqId != null ? String(meta.reqId) : null;
  const recipeId = meta.recipeId != null ? String(meta.recipeId) : null;
  return (
    <div className="cp-activity-expand">
      <div className="cp-expand-head">
        <span className="mono">{absoluteTs(event.ts)}</span>
        <span className="muted">seq {event.seq}</span>
        {reqId ? <Chip tone="mono">reqId {reqId}</Chip> : null}
        {onOpenInConsole && reqId ? (
          <a
            href="/models"
            className="cp-alert-link"
            onClick={(e) => {
              e.preventDefault();
              onOpenInConsole(event);
            }}
          >
            View in Live Console{recipeId ? ` · ${recipeId}` : ""}
          </a>
        ) : null}
        <button type="button" className="cp-btn ghost" style={{ marginLeft: "auto" }} onClick={() => copy(raw)}>
          Copy raw line
        </button>
      </div>
      <table className="cp-activity-fields">
        <tbody>
          {fields.map((f) => (
            <tr key={f.key}>
              <th scope="row">{f.key}</th>
              <td className="mono">{f.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="mono cp-activity-raw" onClick={() => copy(raw)} title="Click to copy raw JSON">
        {raw}
      </button>
    </div>
  );
}

// Ensure the severity derivation import stays used by the module contract.
export { activityLevel };
