import { memo } from "react";
import type { RuntimeState } from "./fleetModel";
import { observedRange } from "./useTelemetryHistory";
import { stateLabel, stateTone } from "./cockpitModel";

export interface ThroughputGaugeProps {
  /** Current generation tok/s, null when the probe carries none. */
  value: number | null;
  /** Recent samples for this deployment (oldest → newest). */
  history: readonly number[];
  state: RuntimeState;
  /** Pixel diameter. */
  size?: number;
  ariaLabel?: string;
  className?: string;
}

const START_DEG = 150;
const SWEEP_DEG = 240;
const TICKS = 5;

/** Round up to a 1/2/5 × 10^n "nice" ceiling so the arc has a real range. */
export function niceCeil(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const n = v / base;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * base;
}

/**
 * Arc scaling: the fraction is value / recent-observed-ceiling, NOT value/100.
 * `null` when the buffer has fewer than 2 samples — the caller renders a
 * minimal neutral arc instead of a forged range.
 */
export function gaugeFraction(value: number | null, history: readonly number[]): { fraction: number; ceiling: number } | null {
  const range = observedRange(history);
  if (!range) return null;
  const ceiling = niceCeil(Math.max(range.peak, value ?? 0));
  const fraction = Math.min(1, Math.max(0, (value ?? 0) / ceiling));
  return { fraction, ceiling };
}

/** Recent trend from the last two samples: 1 up, -1 down, 0 flat. */
export function gaugeTrend(history: readonly number[]): number {
  const vals = history.filter((n) => Number.isFinite(n));
  if (vals.length < 2) return 0;
  const a = vals[vals.length - 2];
  const b = vals[vals.length - 1];
  if (b > a) return 1;
  if (b < a) return -1;
  return 0;
}

const polar = (cx: number, cy: number, r: number, deg: number) => {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
};

const arcPath = (cx: number, cy: number, r: number, fromDeg: number, toDeg: number) => {
  const a = polar(cx, cy, r, fromDeg);
  const b = polar(cx, cy, r, toDeg);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
};

function sparkPath(vals: readonly number[], w: number, h: number, gap: number): string {
  const n = vals.length;
  if (n < 2) return "";
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i: number) => (i / (n - 1)) * (w - gap * 2) + gap;
  const y = (v: number) => h - gap - ((v - min) / span) * (h - gap * 2);
  return vals.map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
}

export const ThroughputGauge = memo(function ThroughputGauge({
  value,
  history,
  state,
  size = 168,
  ariaLabel,
  className = "",
}: ThroughputGaugeProps) {
  const tone = stateTone(state);
  const scaled = gaugeFraction(value, history);
  const fraction = scaled ? scaled.fraction : 0.26;
  const range = observedRange(history);
  const trend = gaugeTrend(history);
  const showNumber = typeof value === "number" && value > 0;
  // No active throughput (idle/ready/unknown) => calm instrument, never a blob.
  const calm = !showNumber;
  const spark = history.slice(-24);

  const cx = 20;
  const cy = 20;
  const r = 14.5;
  const pct = fraction * 100;

  return (
    <div
      className={`cp-gauge tone-${tone}${scaled ? " is-scaled" : " is-neutral"}${calm ? " is-calm" : ""}${tone === "live" && !calm ? " is-active" : ""} ${className}`.trim()}
      style={{ width: size, height: size }}
      role="img"
      aria-label={ariaLabel ?? `${stateLabel(state)}${showNumber ? `, ${Math.round(value!)} tok/s` : ""}`}
    >
      <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden="true">
        {/* restrained track */}
        <path className="cp-gauge-track" d={arcPath(cx, cy, r, START_DEG, START_DEG + SWEEP_DEG)} pathLength={100} fill="none" />
        {/* value arc — animates smoothly, never snaps; omitted when calm */}
        {calm ? null : (
          <path
            className="cp-gauge-fill"
            d={arcPath(cx, cy, r, START_DEG, START_DEG + SWEEP_DEG)}
            pathLength={100}
            fill="none"
            strokeDasharray={`${pct.toFixed(2)} 100`}
          />
        )}
        {/* ticks only when the range is real and the gauge is active */}
        {scaled && !calm
          ? Array.from({ length: TICKS }, (_, i) => {
              const deg = START_DEG + (SWEEP_DEG * i) / (TICKS - 1);
              const o = polar(cx, cy, r + 1.6, deg);
              const inn = polar(cx, cy, r - 1.6, deg);
              return (
                <line
                  key={i}
                  className="cp-gauge-tick"
                  x1={inn.x.toFixed(2)}
                  y1={inn.y.toFixed(2)}
                  x2={o.x.toFixed(2)}
                  y2={o.y.toFixed(2)}
                />
              );
            })
          : null}
        {/* micro sparkline inside the arc foot */}
        {scaled && !calm && spark.length >= 2 ? (
          <path className="cp-gauge-spark" d={sparkPath(spark, 28, 6, 1)} transform="translate(6, 31)" fill="none" />
        ) : null}
        {/* value marker — the needle sits exactly ON the arc angle for `value` */}
        {scaled && !calm ? (
          (() => {
            const p = polar(cx, cy, r, START_DEG + (SWEEP_DEG * pct) / 100);
            return <circle className="cp-gauge-needle" cx={p.x.toFixed(2)} cy={p.y.toFixed(2)} r={1.5} />;
          })()
        ) : null}
      </svg>

      <div className="cp-gauge-center">
        {showNumber ? (
          <>
            <span className="cp-gauge-value">{Math.round(value!)}</span>
            <span className="cp-gauge-unit">TOK/S</span>
          </>
        ) : null}
        {/* state word always present — role/state stay visually distinct from load */}
        <span className="cp-gauge-state">{stateLabel(state)}</span>
        {trend !== 0 && !calm ? (
          <span className={`cp-gauge-trend ${trend > 0 ? "is-up" : "is-down"}`} aria-hidden="true">
            {trend > 0 ? "▲" : "▼"}
          </span>
        ) : null}
      </div>

      {range && !calm ? (
        <div className="cp-gauge-range mono">
          AVG {Math.round(range.avg)} · PEAK {Math.round(range.peak)}
        </div>
      ) : null}
    </div>
  );
});
