import { useEffect, useMemo, useRef, useState } from "react";
import { useConsole } from "../../hooks/useConsole";
import { DataTable, type Column } from "../ui/DataTable";
import type { ConsoleTelemetryRow } from "../../api/types";

const fmt = (v: number | null, digits = 0): string =>
  v == null || !Number.isFinite(v) ? "—" : v >= 100 ? v.toFixed(0) : v.toFixed(digits);
const secs = (v: number | null): string => (v == null ? "—" : `${v.toFixed(2)}s`);

function levelClass(level: string): string {
  const l = level.toLowerCase();
  if (l === "error" || l === "critical") return "error";
  if (l === "warning" || l === "warn") return "warn";
  if (l === "success") return "success";
  return "";
}

interface LiveConsoleProps {
  recipeId: string;
  logDir: string | null;
}

/**
 * Professional Live Console over the read-only log stream.
 *  - Telemetry View: one row per inference request with the EXL3/MTP metrics.
 *  - Raw Console: the real loguru stream with follow/pause/search + level coding.
 */
export function LiveConsole({ recipeId, logDir }: LiveConsoleProps) {
  const [mode, setMode] = useState<"telemetry" | "raw">("telemetry");
  const { lines, telemetry, connected, reason } = useConsole(recipeId);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div className="cp-tabs" style={{ marginBottom: 0, borderBottom: "none" }}>
          <button type="button" className={`cp-tab ${mode === "telemetry" ? "is-active" : ""}`} onClick={() => setMode("telemetry")}>
            Telemetry
          </button>
          <button type="button" className={`cp-tab ${mode === "raw" ? "is-active" : ""}`} onClick={() => setMode("raw")}>
            Raw Console
          </button>
        </div>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--color-muted)", display: "flex", alignItems: "center", gap: 6 }}>
          <span className={`cp-dot ${connected ? "running" : "error"}`} />
          {connected ? "live" : reason || "connecting…"}
          {logDir ? <span className="cp-chip mono" style={{ marginLeft: 6 }}>{logDir}</span> : null}
        </span>
      </div>

      {mode === "telemetry" ? <TelemetryView rows={telemetry} /> : <RawView lines={lines} />}
    </div>
  );
}

function TelemetryView({ rows }: { rows: readonly ConsoleTelemetryRow[] }) {
  const columns: Column<ConsoleTelemetryRow>[] = [
    { key: "req", header: "Req", mono: true, render: (r) => `#${r.reqId}` },
    { key: "state", header: "State", render: (r) => (r.state === "done" ? <span className="cp-dot running" /> : <span className="cp-dot loading" />) },
    { key: "prompt", header: "Prompt", align: "right", render: (r) => fmt(r.promptTokens) },
    { key: "gen", header: "Gen", align: "right", render: (r) => fmt(r.generatedTokens) },
    {
      key: "cache",
      header: "Cached",
      align: "right",
      render: (r) => (r.cachedPct == null ? "—" : `${r.cachedPct}%`),
    },
    { key: "new", header: "New", align: "right", muted: true, render: (r) => fmt(r.newPromptTokens) },
    { key: "prefill", header: "Prefill", align: "right", render: (r) => (r.prefillTps == null ? "—" : `${fmt(r.prefillTps)} T/s`) },
    { key: "ttft", header: "TTFT", align: "right", render: (r) => secs(r.ttftSeconds) },
    { key: "decode", header: "Decode", align: "right", render: (r) => (r.decodeTps == null ? "—" : `${fmt(r.decodeTps, 1)} T/s`) },
    {
      key: "mtp",
      header: "MTP",
      align: "right",
      render: (r) =>
        r.draftAccepted == null || r.draftAttempted == null ? (
          "—"
        ) : (
          <span title={`${r.draftAccepted}/${r.draftAttempted} draft tokens accepted`}>
            {r.draftPct}%{" "}
            <span className="muted">
              ({r.draftAccepted}/{r.draftAttempted})
            </span>
          </span>
        ),
    },
    { key: "tools", header: "Tools", align: "right", render: (r) => (r.toolCalls ? String(r.toolCalls) : "—") },
    { key: "dur", header: "Duration", align: "right", muted: true, render: (r) => secs(r.totalSeconds) },
  ];
  return (
    <DataTable
      ariaLabel="Inference request telemetry"
      columns={columns}
      rows={rows as ConsoleTelemetryRow[]}
      rowKey={(r) => String(r.reqId)}
      empty={
        <div className="cp-table-empty">
          No requests yet. Traffic will appear here as it is parsed from the model server log.
        </div>
      }
    />
  );
}

function RawView({ lines }: { lines: readonly { ts: string | null; level: string; msg: string; raw: string }[] }) {
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState("");
  const [unseen, setUnseen] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);

  const filtered = useMemo(() => {
    if (!query) return lines;
    const q = query.toLowerCase();
    return lines.filter((l) => l.raw.toLowerCase().includes(q));
  }, [lines, query]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (follow) {
      el.scrollTop = el.scrollHeight;
      setUnseen(0);
    } else {
      setUnseen((u) => u + 1);
    }
  }, [filtered.length, follow]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    atBottom.current = bottom;
    if (!bottom && follow) setFollow(false);
    if (bottom && !follow) setFollow(true);
  };

  return (
    <div className="cp-console">
      <div className="cp-console-toolbar">
        <button type="button" className="cp-btn ghost" style={{ padding: "3px 8px", fontSize: 11 }} onClick={() => setFollow((f) => !f)} aria-pressed={follow}>
          {follow ? "⏸ Pause" : "▶ Follow"}
        </button>
        <input
          className="cp-input"
          style={{ maxWidth: 220, padding: "3px 8px", fontSize: 11 }}
          placeholder="Search / filter…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search log"
        />
        <span style={{ marginLeft: "auto", color: "var(--color-muted)" }}>{filtered.length} lines</span>
        <button
          type="button"
          className="cp-btn ghost"
          style={{ padding: "3px 8px", fontSize: 11 }}
          onClick={() => {
            const text = filtered.map((l) => l.raw).join("\n");
            navigator.clipboard?.writeText(text).catch(() => {});
          }}
        >
          Copy
        </button>
      </div>
      <div className="cp-console-pos">
        <div className="cp-console-scroll" ref={scrollRef} onScroll={onScroll} role="log" aria-live="off">
          {filtered.length === 0 ? (
            <div className="cp-table-empty">{query ? "No matching lines." : "Waiting for log output…"}</div>
          ) : (
            filtered.map((l, i) => (
              <div key={i} className={`cp-console-line ${levelClass(l.level)}`}>
                {l.ts ? <span className="cp-console-ts">{l.ts.slice(11)}</span> : null}
                <span className="cp-console-msg">{l.msg}</span>
              </div>
            ))
          )}
        </div>
        {!follow && unseen > 0 ? (
          <button type="button" className="cp-btn primary cp-newlogs" onClick={() => setFollow(true)}>
            {unseen} new line{unseen === 1 ? "" : "s"} ↓
          </button>
        ) : null}
      </div>
    </div>
  );
}