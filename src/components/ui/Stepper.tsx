/**
 * Guided-wizard stepper (DESIGN_LANGCHAIN §7): 24px numbered circles, 13px
 * labels, hairline connectors between steps. Current = accent, completed =
 * success check, upcoming = muted hairline circle.
 *
 * Two variants:
 *  - `full`    — numbered circle + inline label per step (wide surfaces).
 *  - `compact` — numbered rail with short inline labels hidden at modal width,
 *                a prominent current-step title plus a "Step n of N" indicator,
 *                and the full step list available on demand. No text collision.
 *
 * Read-only presentation primitive — the owner owns the step index. Steps before
 * the current one are clickable so a user can jump back and fix an earlier
 * answer; forward jumps are the owner's call via `onSelect`.
 */
import { useState } from "react";
import { CheckIcon } from "./icons";

export interface StepperStep {
  id: string;
  label: string;
}

export function Stepper({
  steps,
  current,
  onSelect,
  ariaLabel = "Wizard steps",
  variant = "full",
}: {
  steps: StepperStep[];
  /** Zero-based index of the active step. */
  current: number;
  /** Called with an earlier step index when a completed step is clicked. */
  onSelect?: (index: number) => void;
  ariaLabel?: string;
  /** `compact` fits narrow modals: short rail + prominent current title. */
  variant?: "full" | "compact";
}) {
  const [showAll, setShowAll] = useState(false);
  const total = steps.length;
  const compact = variant === "compact";
  const currentStep = steps[current] ?? steps[0];

  const rail = (
    <ol className={`cp-steps${compact ? " is-compact" : ""}`} aria-label={ariaLabel}>
      {steps.map((s, i) => {
        const state = i === current ? "is-active" : i < current ? "is-done" : "";
        const clickable = Boolean(onSelect) && i < current;
        return (
          <li key={s.id} className="cp-step-line-wrap">
            {i > 0 ? <span className="cp-step-line" aria-hidden="true" /> : null}
            <button
              type="button"
              className={`cp-step ${state}`}
              aria-current={i === current ? "step" : undefined}
              aria-label={compact ? `${s.label} — step ${i + 1} of ${total}` : undefined}
              title={compact ? s.label : undefined}
              disabled={!clickable}
              onClick={clickable ? () => onSelect?.(i) : undefined}
            >
              <span className="cp-step-num" aria-hidden="true">
                {i < current ? <CheckIcon size={14} /> : i + 1}
              </span>
              <span className="cp-step-label">{s.label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );

  if (!compact) return rail;

  return (
    <div className="cp-stepper">
      <div className="cp-stepper-head">
        <span className="cp-stepper-title">{currentStep?.label}</span>
        <span className="cp-stepper-count mono" aria-hidden="true">
          Step {current + 1} of {total}
        </span>
        <button
          type="button"
          className="cp-link cp-stepper-all"
          aria-expanded={showAll}
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? "Hide steps" : "All steps"}
        </button>
      </div>
      {rail}
      {/* Full step list — kept in the DOM, revealed on demand. */}
      <ol className={`cp-stepper-list${showAll ? " is-open" : ""}`} aria-label={showAll ? ariaLabel : undefined} aria-hidden={!showAll}>
        {steps.map((s, i) => {
          const clickable = Boolean(onSelect) && i < current;
          return (
            <li key={s.id}>
              <button
                type="button"
                className={`cp-stepper-list-item${i === current ? " is-active" : ""}`}
                disabled={!clickable}
                aria-current={i === current ? "step" : undefined}
                onClick={clickable ? () => onSelect?.(i) : undefined}
              >
                <span className="mono">{i + 1}.</span> {s.label}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
