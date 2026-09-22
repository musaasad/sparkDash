import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useConsoleSources } from "../../hooks/useConsole";
import { getDeployment, useDeployments } from "../../hooks/domainStore";
import { EmptyState } from "../ui/Status";
import { TabStrip } from "../ui/DataTable";
import type { ConsoleLine, ConsoleTelemetryRow } from "../../api/types";
import {
  ALL_WINDOW,
  EMPTY_QUERY,
  INITIAL_FOLLOW,
  SEVERITIES,
  WINDOW_CHIPS,
  bucketize,
  buildSources,
  countBySeverity,
  describeRange,
  extractReqId,
  fieldTable,
  filterRows,
  hasActiveQuery,
  highlightTokens,
  indexRawLines,
  isOutlier,
  metricChips,
  outlierThresholds,
  parseQuery,
  percentile,
  rangeForWindow,
  reduceFollow,
  sourceForRecipe,
  toConsoleRow,
  toCopyText,
  toJsonl,
  severityOf,
  streamState,
  type ConsoleRow,
  type ParsedQuery,
  type Severity,
  type TimeWindow,
  type WindowChip,
} from "./liveConsoleModel";

const absTime = (ts: number | null): string => (ts === null ? "—" : new Date(ts).toISOString().slice(11, 23));
const absFull = (ts: number | null): string => (ts === null ? "—" : new Date(ts).toISOString());

interface LiveConsoleProps {
  recipeId: string;
  logDir: string | null;
  /** Deep-link reqId: pre-seeds the query with `reqId:N`. */
  initialReqId?: number;
}

/**
 * Operator Live Console over the read-only log stream.
 *
 * Design-brief mandates implemented: field-aware query toolbar, per-deployment
 * source tabs, explicit Live toggle, scroll-up auto-pause with a sticky resume
 * button, disconnect banner with Reconnect, severity facets with live counts,
 * events-per-minute scrubber, fixed-order metric chips, Parsed↔Raw drawer,
 * outlier tinting, copy + JSONL export and a never-dead empty state.
 *
 * Filters are pure client-side: changing them never restarts the SSH tail.
 */
export function LiveConsole({ recipeId, logDir, initialReqId }: LiveConsoleProps) {
  const deployments = useDeployments();
  const sources = useMemo(() => buildSources(deployments, recipeId), [deployments, recipeId]);
  const [activeLabel, setActiveLabel] = useState(() => sourceForRecipe(sources, recipeId));

  useEffect(() => {
    if (!sources.some((s) => s.label === activeLabel)) setActiveLabel(sourceForRecipe(sources, recipeId));
  }, [sources, activeLabel, recipeId]);

  const active = sources.find((s) => s.label === activeLabel) ?? sources[0];
  const activeRecipes = useMemo(() => active?.recipeIds ?? (recipeId ? [recipeId] : []), [active, recipeId]);

  const { lines, telemetry, connected, reason, disconnectedRecipeId, resubscribe } = useConsoleSources(activeRecipes);
  const stream = streamState(logDir, connected);

  const [queryInput, setQueryInput] = useState(() => (initialReqId != null ? `reqId:${initialReqId}` : ""));
  const [windowChip, setWindowChip] = useState<WindowChip>("15m");
  const [narrow, setNarrow] = useState<TimeWindow | null>(null);
  const [facets, setFacets] = useState<Set<Severity>>(() => new Set());
  const [liveOn, setLiveOn] = useState(true);
  const [follow, dispatch] = useReducer(reduceFollow, INITIAL_FOLLOW);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [drawerMode, setDrawerMode] = useState<"parsed" | "raw">("parsed");
  const [propSearch, setPropSearch] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (initialReqId != null) setQueryInput(`reqId:${initialReqId}`);
  }, [initialReqId]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastLen = useRef(0);

  const baseWindow = useMemo(() => rangeForWindow(windowChip, now), [windowChip, now]);
  const window_ = narrow ?? baseWindow;

  const rows: ConsoleRow[] = useMemo(() => {
    const raw = indexRawLines(lines);
    return telemetry.map(({ recipeId: rid, row }) => {
      const dep = getDeployment(rid);
      return toConsoleRow(rid, dep?.modelId ?? "", dep?.nodeIds ?? [], row, raw.get(`${rid}:${row.reqId}`) ?? "");
    });
  }, [lines, telemetry]);

  const query: ParsedQuery = useMemo(() => {
    const q = parseQuery(queryInput);
    return { ...q, severity: facets };
  }, [queryInput, facets]);

  // Counts exclude the facet filter itself so chips show live totals.
  const preFacet = useMemo(() => filterRows(rows, { ...query, severity: EMPTY_FACETS }, window_), [rows, query, window_]);
  const counts = useMemo(() => countBySeverity(preFacet), [preFacet]);
  const filtered = useMemo(() => filterRows(rows, query, window_), [rows, query, window_]);
  const thresholds = useMemo(() => outlierThresholds(filtered), [filtered]);
  const buckets = useMemo(() => bucketize(preFacet, window_, now), [preFacet, window_, now]);

  // Follow tail: any length change is an append tick.
  useEffect(() => {
    if (filtered.length === lastLen.current) return;
    lastLen.current = filtered.length;
    dispatch({ type: "append", at: Date.now() });
  }, [filtered.length]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && follow.following) el.scrollTop = el.scrollHeight;
  }, [follow.following, filtered.length]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (!bottom) dispatch({ type: "scroll", atBottom: false });
    else if (liveOn) dispatch({ type: "scroll", atBottom: true });
  }, [liveOn]);

  const flash = useCallback((what: string) => {
    setCopied(what);
    setTimeout(() => setCopied(null), 1200);
  }, []);

  const copy = useCallback(
    (text: string, what: string) => {
      navigator.clipboard?.writeText(text).catch(() => {});
      flash(what);
    },
    [flash]
  );

  const exportJsonl = useCallback(() => {
    const blob = new Blob([toJsonl(filtered)], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sparkdash-console-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filtered]);

  const toggleFacet = (s: Severity) =>
    setFacets((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const clearFilters = () => {
    setQueryInput("");
    setFacets(new Set());
    setNarrow(null);
    setWindowChip("all");
  };

  const openInActivity = (reqId: number) => {
    window.history.pushState(null, "", `/activity?reqId=${reqId}`);
    window.dispatchEvent(new Event("popstate"));
  };

  const visible = filtered.slice(0, 400);
  const startMarker = window_.from !== null && rows.some((r) => r.ts !== null && r.ts < window_.from!);
  const endMarker = window_.to !== null && rows.some((r) => r.ts !== null && r.ts > window_.to!);

  return (
    <div className="cp-lc">
      {/* Persistent query toolbar ─────────────────────────────── */}
      <div className="cp-lc-toolbar" role="search">
        <TabStrip
          tabs={sources.map((s) => s.label)}
          active={activeLabel}
          onSelect={setActiveLabel}
          ariaLabel="Sources"
          panelId="lc-sources"
          className="cp-lc-sources"
          tabClassName="cp-lc-src"
          titleOf={(label) => sources.find((s) => s.label === label)?.nodeIds.join(", ") || label}
        />

        <input
          className="cp-input cp-lc-search mono"
          value={queryInput}
          onChange={(e) => setQueryInput(e.target.value)}
          placeholder="reqId:123  model:deepseek  node:dgx-1  free text…"
          aria-label="Filter console rows"
          spellCheck={false}
        />

        <div className="cp-lc-window" role="group" aria-label="Time window">
          {WINDOW_CHIPS.map((c) => (
            <button
              key={c}
              type="button"
              className={`cp-lc-chip ${c === windowChip && !narrow ? "is-active" : ""}`}
              onClick={() => {
                setWindowChip(c);
                setNarrow(null);
              }}
            >
              {c === "all" ? "All" : c}
            </button>
          ))}
        </div>

        <button
          type="button"
          className={`cp-lc-live ${liveOn ? "is-on" : ""}`}
          aria-pressed={liveOn}
          onClick={() => {
            setLiveOn((v) => {
              const next = !v;
              if (next) dispatch({ type: "resume" });
              else dispatch({ type: "pause" });
              return next;
            });
          }}
        >
          <span className={`cp-dot ${liveOn ? "running" : "stopped"}`} />
          Live {liveOn ? "on" : "off"}
        </button>
      </div>

      {/* Range restated + stream state ────────────────────────── */}
      <div className="cp-lc-meta">
        <span className="cp-lc-range mono" title={absFull(window_.from) + " → " + absFull(window_.to)}>
          window {describeRange(window_)}
        </span>
        <span className="cp-lc-srcpath mono" title={active?.nodeIds.join(", ") || undefined}>
          {active?.nodeIds.join("+") || recipeId}
        </span>
        {logDir ? <span className="cp-chip mono" title={logDir}>{logDir}</span> : null}
        <span className="cp-lc-count">
          {filtered.length} rows · p90 ttft {percentile(filtered.map((r) => r.row.ttftSeconds ?? NaN), 90)?.toFixed(2) ?? "—"}s
        </span>
      </div>

      <div className="cp-lc-stream">
        <span className={`cp-lc-followstate ${follow.following ? "is-following" : "is-paused"}`} role="status">
          <span className={`cp-dot ${follow.following ? "running" : "paused"}`} />
          {follow.following ? "Following" : "Paused"}
        </span>
        <span className="muted">last sync {absFull(follow.lastSync)}</span>
        {!liveOn ? <span className="cp-lc-liveoff">Live off</span> : null}
        {follow.following ? null : (
          <button
            type="button"
            className="cp-btn primary"
            style={{ padding: "2px 8px", fontSize: 11 }}
            onClick={() => {
              dispatch({ type: "resume", at: Date.now() });
              setLiveOn(true);
            }}
          >
            ▶ Resume follow{follow.unseen ? ` (${follow.unseen})` : ""}
          </button>
        )}
      </div>

      {stream === "not-configured" ? (
        <div className="cp-lc-banner is-info" role="status">
          <span className="cp-dot" />
          <strong>Not streaming</strong> — no log directory configured for this recipe
        </div>
      ) : stream === "disconnected" ? (
        <div className="cp-lc-banner" role="alert">
          <span className="cp-dot error" />
          <strong>Stream disconnected</strong> — node{" "}
          {disconnectedRecipeId ? getDeployment(disconnectedRecipeId)?.nodeIds.join("+") ?? disconnectedRecipeId : active?.nodeIds[0] ?? recipeId}
          {reason ? `: ${reason}` : ""}
          <button type="button" className="cp-btn" style={{ marginLeft: "auto", padding: "2px 8px", fontSize: 11 }} onClick={resubscribe}>
            Reconnect
          </button>
        </div>
      ) : null}

      {/* Events-per-minute scrubber + severity facets ─────────── */}
      <Histogram buckets={buckets} onPick={(b) => setNarrow({ from: b.start, to: b.end })} />

      <div className="cp-lc-facets" role="group" aria-label="Severity facets">
        {SEVERITIES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={facets.has(s)}
            className={`cp-lc-facet ${s} ${facets.has(s) ? "is-active" : ""}`}
            onClick={() => toggleFacet(s)}
          >
            {s} <span className="cp-lc-facetcount">{counts[s]}</span>
          </button>
        ))}
        <span className="cp-lc-legend">
          amber = p90+ TTFT ≥ {thresholds.ttft?.toFixed(2) ?? "—"}s / decode ≥ {thresholds.decode?.toFixed(1) ?? "—"} t/s
        </span>
        <div className="cp-lc-actions">
          <button type="button" className="cp-btn ghost" onClick={() => copy(toCopyText(filtered), "rows")}>
            Copy visible
          </button>
          <button type="button" className="cp-btn ghost" onClick={exportJsonl}>
            Export JSONL
          </button>
        </div>
      </div>

      {copied ? <span className="cp-lc-copied" role="status">copied {copied}</span> : null}

      {/* Row grid ─────────────────────────────────────────────── */}
      <div className="cp-lc-pos">
        <div className="cp-lc-scroll" id="lc-sources" ref={scrollRef} onScroll={onScroll} role="log" aria-live="off">
          {startMarker ? <div className="cp-lc-marker">▤ start of range</div> : null}

          {filtered.length === 0 ? (
            <div className="cp-lc-empty">
              <EmptyState
                title={hasActiveQuery(query, window_) ? "No rows match the query" : "Waiting for parsed telemetry"}
                subtitle={
                  hasActiveQuery(query, window_)
                    ? "Filters are client-side — the tail keeps streaming."
                    : "Requests will appear here as the model server log is parsed."
                }
                action={
                  <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                    <button type="button" className="cp-btn" onClick={clearFilters}>
                      Clear filters
                    </button>
                    <button type="button" className="cp-btn ghost" onClick={resubscribe}>
                      Refresh query
                    </button>
                  </div>
                }
              />
            </div>
          ) : (
            visible.map((r) => (
              <TelemetryRow
                key={r.key}
                row={r}
                expanded={expanded === r.key}
                outlier={isOutlier(r, thresholds)}
                onToggle={() => {
                  setExpanded((k) => (k === r.key ? null : r.key));
                  setDrawerMode("parsed");
                  setPropSearch("");
                }}
                onCopyReq={() => copy(`#${r.row.reqId}`, "reqId")}
                drawerMode={drawerMode}
                setDrawerMode={setDrawerMode}
                propSearch={propSearch}
                setPropSearch={setPropSearch}
                onCopy={copy}
                onOpenActivity={() => openInActivity(r.row.reqId)}
              />
            ))
          )}

          {endMarker ? <div className="cp-lc-marker">▤ end of range</div> : null}
        </div>

        {!follow.following ? (
          <button
            type="button"
            className="cp-btn primary cp-lc-sticky"
            onClick={() => {
              dispatch({ type: "resume", at: Date.now() });
              setLiveOn(true);
            }}
          >
            Live off — resume follow{follow.unseen ? ` (${follow.unseen} new)` : ""}
          </button>
        ) : null}
      </div>

      <RawPane lines={lines} query={query} window_={window_} connected={stream === "disconnected"} />
    </div>
  );
}

const EMPTY_FACETS = new Set<Severity>();

// ─── Histogram scrubber ──────────────────────────────────────────────────────
function Histogram({ buckets, onPick }: { buckets: ReturnType<typeof bucketize>; onPick: (b: (typeof buckets)[number]) => void }) {
  const max = Math.max(1, ...buckets.map((b) => b.total));
  return (
    <div className="cp-lc-hist" role="group" aria-label="Events per minute scrubber">
      {buckets.map((b, i) => (
        <button
          key={i}
          type="button"
          className="cp-lc-histbar"
          style={{ height: `${Math.max(2, (b.total / max) * 100)}%` }}
          title={`${absTime(b.start)} · ${b.total} events${b.errors ? `, ${b.errors} errors` : ""}`}
          onClick={() => onPick(b)}
        >
          {b.errors ? <span className="cp-lc-histerr" style={{ height: `${Math.max(1, (b.errors / max) * 100)}%` }} /> : null}
        </button>
      ))}
    </div>
  );
}

// ─── Parsed row + drawer ─────────────────────────────────────────────────────
interface TelemetryRowProps {
  row: ConsoleRow;
  expanded: boolean;
  outlier: boolean;
  onToggle: () => void;
  onCopyReq: () => void;
  drawerMode: "parsed" | "raw";
  setDrawerMode: (m: "parsed" | "raw") => void;
  propSearch: string;
  setPropSearch: (v: string) => void;
  onCopy: (text: string, what: string) => void;
  onOpenActivity: () => void;
}

function TelemetryRow({
  row,
  expanded,
  outlier,
  onToggle,
  onCopyReq,
  drawerMode,
  setDrawerMode,
  propSearch,
  setPropSearch,
  onCopy,
  onOpenActivity,
}: TelemetryRowProps) {
  const chips = metricChips(row.row);
  const fields = fieldTable(row.row);
  const needle = propSearch.toLowerCase();
  const shown = needle ? fields.filter((f) => f.label.toLowerCase().includes(needle) || f.value.toLowerCase().includes(needle)) : fields;
  const rawTokens = highlightTokens(row.rawText);

  return (
    <div className={`cp-lc-rowwrap ${outlier ? "is-outlier" : ""}`}>
      <div
        className={`cp-lc-row ${row.level}`}
        onClick={onToggle}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span className={`cp-lc-gutter ${row.level}`} title={row.level} />
        <span className="cp-lc-ts mono" title={absFull(row.ts)}>
          {absTime(row.ts)}
        </span>
        <span className={`cp-lc-level ${row.level}`}>{row.level}</span>
        <button
          type="button"
          className="cp-lc-req mono"
          title={`${row.recipeId} · click to copy`}
          onClick={(e) => {
            e.stopPropagation();
            onCopyReq();
          }}
        >
          #{row.row.reqId}
        </button>
        <span className="cp-lc-model mono" title={row.modelId}>
          {row.modelId || "—"}
        </span>
        <span className="cp-lc-node mono" title={row.nodeIds.join(", ")}>
          {row.nodeIds.join("+") || "—"}
        </span>
        <span className="cp-lc-metrics">
          {chips.map((c) => (
            <span key={c.key} className={`cp-lc-metric mono ${c.present ? "" : "is-absent"}`} title={`${c.label}: ${c.text}`}>
              {c.text}
            </span>
          ))}
        </span>
      </div>

      {expanded ? (
        <div className="cp-lc-drawer" onClick={(e) => e.stopPropagation()}>
          <div className="cp-lc-drawerhead">
            <div className="cp-tabs" style={{ borderBottom: "none", marginBottom: 0 }}>
              <TabStrip
                tabs={["Parsed", "Raw"]}
                active={drawerMode === "parsed" ? "Parsed" : "Raw"}
                onSelect={(t) => setDrawerMode(t.toLowerCase() as "parsed" | "raw")}
                ariaLabel="Row view"
                panelId="lc-drawer"
                className="cp-lc-drawertabs"
              />
            </div>
            {drawerMode === "parsed" ? (
              <input
                className="cp-input"
                style={{ maxWidth: 200, padding: "2px 8px", fontSize: 11 }}
                placeholder="property search…"
                value={propSearch}
                onChange={(e) => setPropSearch(e.target.value)}
                aria-label="Search properties"
              />
            ) : null}
            <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
              <button
                type="button"
                className="cp-btn ghost"
                style={{ padding: "2px 8px", fontSize: 11 }}
                onClick={() => onCopy(row.rawText || JSON.stringify(row.row), "payload")}
              >
                Copy full payload
              </button>
              <button type="button" className="cp-btn ghost" style={{ padding: "2px 8px", fontSize: 11 }} onClick={onOpenActivity}>
                View in Activity ↗
              </button>
            </div>
          </div>

          {drawerMode === "parsed" ? (
            <table className="cp-lc-fields" id="lc-drawer-Parsed">
              <caption className="sr-only">Parsed fields for request {row.row.reqId}</caption>
              <tbody>
                {shown.map((f) => (
                  <tr key={f.key}>
                    <th scope="row">{f.label}</th>
                    <td className="mono">{f.value}</td>
                    <td className="cp-lc-fieldcopy">
                      <button
                        type="button"
                        className="cp-btn ghost"
                        style={{ padding: "0 6px", fontSize: 11 }}
                        onClick={() => onCopy(f.value, f.label)}
                        aria-label={`Copy ${f.label}`}
                      >
                        copy
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <pre className="cp-lc-raw mono" id="lc-drawer-Raw">
              {rawTokens.map((t, i) => (
                <span key={i} className={`hl-${t.kind}`}>
                  {t.text}
                </span>
              ))}
            </pre>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ─── Raw log pane ────────────────────────────────────────────────────────────
function RawPane({
  lines,
  query,
  window_,
  connected,
}: {
  lines: readonly { recipeId: string; line: ConsoleLine }[];
  query: ParsedQuery;
  window_: TimeWindow;
  connected: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rows: ConsoleRow[] = useMemo(
    () =>
      lines.map(({ recipeId: rid, line }) => {
        const dep = getDeployment(rid);
        const ts = line.ts ? Date.parse(line.ts) || null : null;
        const reqId = extractReqId(line.raw);
        return {
          key: `${rid}:raw:${ts}:${line.msg.slice(0, 12)}`,
          recipeId: rid,
          modelId: dep?.modelId ?? "",
          nodeIds: dep?.nodeIds ?? [],
          ts,
          level: severityOf(line.level),
          row: {
            reqId: reqId ?? 0,
            ts: line.ts,
            state: "done" as const,
            promptTokens: null,
            generatedTokens: null,
            cachedPct: null,
            newPromptTokens: null,
            prefillTps: null,
            ttftSeconds: null,
            decodeTps: null,
            totalSeconds: null,
            draftAccepted: null,
            draftAttempted: null,
            draftPct: null,
            toolCalls: 0,
            temperature: null,
          },
          rawText: line.raw,
        };
      }),
    [lines]
  );
  const filtered = useMemo(() => filterRows(rows, query, window_), [rows, query, window_]);

  return (
    <details className="cp-lc-rawpane" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        Raw log lines · {filtered.length} {connected ? "" : "(disconnected)"}
      </summary>
      <div className="cp-console-scroll" role="log" aria-live="off">
        {filtered.slice(-300).map((r, i) => (
          <div key={`${r.key}:${i}`} className={`cp-console-line ${r.level}`}>
            <span className="cp-console-ts">{absTime(r.ts)}</span>
            <span className="cp-console-msg">{r.row.reqId ? `#${r.row.reqId} ` : ""}{r.rawText}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

// keep the exported symbol name stable for any external test that imported it
export type { ConsoleTelemetryRow };
