/**
 * Guided-wizard stepper (DESIGN_LANGCHAIN §7): 24px numbered circles, 13px
 * labels, hairline connectors between steps. Current = accent, completed =
 * success check, upcoming = muted hairline circle.
 *
 * Read-only presentation primitive — the owner owns the step index. Steps before
 * the current one are clickable so a user can jump back and fix an earlier
 * answer; forward jumps are the owner's call via `onSelect`.
 */
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
}: {
  steps: StepperStep[];
  /** Zero-based index of the active step. */
  current: number;
  /** Called with an earlier step index when a completed step is clicked. */
  onSelect?: (index: number) => void;
  ariaLabel?: string;
}) {
  return (
    <ol className="cp-steps" aria-label={ariaLabel}>
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
}
