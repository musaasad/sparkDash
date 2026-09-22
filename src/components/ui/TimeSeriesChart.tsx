import { useMemo, useRef, useState } from "react";
import type { TimedSample } from "../../hooks/ringBuffer";

export interface Series {
  label: string;
  color: string;
  data: readonly TimedSample[];
  /** Format the hover value. */
  format?: (v: number) => string;
}

const VIEW_W = 640;
const VIEW_H = 180;
const PAD_L = 34;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 20;

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtAgo(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

/**
 * Generalized operational time-series chart (SVG, no dependency). Fixed
 * right-anchored time window, y-axis max label, x-axis time ticks, gap-aware
 * segments, and a nearest-sample hover tooltip. One component replaces the
 * ad-hoc SVG charts; LlmTrendChart stays for its bespoke tok/s semantics.
 */
export function TimeSeriesChart({
  series,
  windowMs,
  height = VIEW_H,
  emptyLabel = "No samples yet",
}: {
  series: Series[];
  windowMs: number;
  height?: number;
  emptyLabel?: string;
}) {
  const [hoverX, setHoverX] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const endAt = useMemo(() => {
    let max = 0;
    for (const s of series) for (const p of s.data) if (p.at > max) max = p.at;
    return max;
  }, [series]);
  const startAt = endAt - windowMs;

  const yMax = useMemo(() => {
    let m = 1;
    for (const s of series)
      for (const p of s.data) if (p.at >= startAt && p.value > m) m = p.value;
    return m;
  }, [series, startAt]);

  const xFor = (at: number) => PAD_L + ((at - startAt) / windowMs) * (VIEW_W - PAD_L - PAD_R);
  const yFor = (v: number) => VIEW_H - PAD_B - (Math.min(v, yMax) / yMax) * (VIEW_H - PAD_T - PAD_B);

  const segmentsFor = (data: readonly TimedSample[]): string[] => {
    const win = data.filter((p) => p.at >= startAt);
    if (win.length < 2) return [];
    const segs: string[][] = [[]];
    win.forEach((p, i) => {
      if (i > 0 && p.at - win[i - 1].at > windowMs / 40) segs.push([]);
      segs[segs.length - 1].push(`${xFor(p.at).toFixed(1)},${yFor(p.value).toFixed(1)}`);
    });
    return segs.filter((s) => s.length > 1).map((s) => s.join(" "));
  };

  const xTicks = useMemo(() => {
    const ticks: { at: number; x: number }[] = [];
    for (let i = 0; i <= 4; i++) {
      const at = startAt + (windowMs * i) / 4;
      ticks.push({ at, x: xFor(at) });
    }
    return ticks;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startAt, windowMs]);

  const hover = useMemo(() => {
    if (hoverX == null) return null;
    const at = startAt + ((hoverX - PAD_L) / (VIEW_W - PAD_L - PAD_R)) * windowMs;
    const points = series.map((s) => {
      let best: TimedSample | null = null;
      let bestD = Infinity;
      for (const p of s.data) {
        const d = Math.abs(p.at - at);
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      return { series: s, sample: best };
    });
    return { at, points: points.filter((p) => p.sample && p.sample.at >= startAt) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoverX, series, startAt, windowMs]);

  const hasData = series.some((s) => s.data.some((p) => p.at >= startAt));

  return (
    <div style={{ position: "relative" }}>
      {!hasData ? (
        <div className="cp-chart-empty" style={{ height }}>{emptyLabel}</div>
      ) : (
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          className="block w-full"
          style={{ height }}
          role="img"
          aria-label={`Time series over the last ${fmtAgo(windowMs)}`}
          onMouseMove={(e) => {
            const rect = svgRef.current?.getBoundingClientRect();
            if (!rect) return;
            const x = ((e.clientX - rect.left) / rect.width) * VIEW_W;
            setHoverX(Math.max(PAD_L, Math.min(VIEW_W - PAD_R, x)));
          }}
          onMouseLeave={() => setHoverX(null)}
        >
          {/* y grid + max label */}
          {[0, 0.5, 1].map((f) => {
            const y = VIEW_H - PAD_B - f * (VIEW_H - PAD_T - PAD_B);
            return (
              <g key={f}>
                <line x1={PAD_L} y1={y} x2={VIEW_W - PAD_R} y2={y} stroke="var(--color-grid)" strokeWidth={1} />
                <text x={PAD_L - 4} y={y + 3} textAnchor="end" fontSize={8} fill="var(--color-muted)">
                  {yMax * f >= 100 ? Math.round(yMax * f) : (yMax * f).toFixed(1)}
                </text>
              </g>
            );
          })}
          {/* x ticks */}
          {xTicks.map((t, i) => (
            <text key={i} x={t.x} y={VIEW_H - 6} textAnchor="middle" fontSize={8} fill="var(--color-muted)">
              {fmtTime(t.at)}
            </text>
          ))}
          {/* series */}
          {series.map((s) =>
            segmentsFor(s.data).map((pts, i) => (
              <polyline
                key={`${s.label}-${i}`}
                points={pts}
                fill="none"
                stroke={s.color}
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))
          )}
          {hover ? (
            <line x1={xFor(hover.at)} y1={PAD_T} x2={xFor(hover.at)} y2={VIEW_H - PAD_B} stroke="var(--color-border-strong)" strokeWidth={1} strokeDasharray="3 2" />
          ) : null}
        </svg>
      )}
      {hover && hover.points.length ? (
        <div
          style={{
            position: "absolute",
            top: 6,
            left: `${Math.min(75, Math.max(2, ((hoverX ?? 0) / VIEW_W) * 100))}%`,
            background: "var(--color-surface-elevated)",
            border: "1px solid var(--color-border)",
            borderRadius: 6,
            padding: "5px 8px",
            fontSize: 11,
            pointerEvents: "none",
            boxShadow: "var(--shadow-card)",
          }}
        >
          <div style={{ color: "var(--color-muted)", marginBottom: 2 }}>{fmtTime(hover.at)}</div>
          {hover.points.map((p) => (
            <div key={p.series.label} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: p.series.color }} />
              <span style={{ color: "var(--color-muted)" }}>{p.series.label}</span>
              <span className="font-tabular" style={{ color: "var(--color-text-strong)" }}>
                {p.series.format ? p.series.format(p.sample!.value) : p.sample!.value.toFixed(1)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Range selector used alongside charts. */
export function RangePicker({
  value,
  onChange,
  options = [
    { ms: 15 * 60_000, label: "15m" },
    { ms: 30 * 60_000, label: "30m" },
    { ms: 60 * 60_000, label: "1h" },
    { ms: 6 * 60 * 60_000, label: "6h" },
  ],
}: {
  value: number;
  onChange: (ms: number) => void;
  options?: { ms: number; label: string }[];
}) {
  return (
    <div style={{ display: "inline-flex", gap: 2 }}>
      {options.map((o) => (
        <button
          key={o.ms}
          type="button"
          className={`cp-range${value === o.ms ? " is-active" : ""}`}
          style={{ padding: "3px 8px", fontSize: 11, background: value === o.ms ? "var(--color-surface-hover)" : undefined }}
          aria-pressed={value === o.ms}
          onClick={() => onChange(o.ms)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}