import { useState, type ReactNode, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

/**
 * Control-plane form kit — the reusable answer to the 684-line EditSparkDialog
 * monolith. Sections, inline errors, Advanced disclosure, sticky footer. Used by
 * the Recipe editor and Settings.
 */

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  style,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  htmlFor?: string;
  children: ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div className="cp-field" style={style}>
      <label className="cp-field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <span className="cp-field-error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="cp-field-hint">{hint}</span>
      ) : null}
    </div>
  );
}

export function TextInput({
  invalid,
  mono,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; mono?: boolean }) {
  return (
    <input
      className={`cp-input ${mono ? "mono" : ""}`}
      aria-invalid={invalid ? "true" : undefined}
      {...props}
    />
  );
}

export function Select({
  invalid,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select className="cp-select" aria-invalid={invalid ? "true" : undefined} {...props}>
      {children}
    </select>
  );
}

export function TextArea({
  invalid,
  mono,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean; mono?: boolean }) {
  return (
    <textarea
      className={`cp-textarea ${mono ? "mono" : ""}`}
      aria-invalid={invalid ? "true" : undefined}
      {...props}
    />
  );
}

export function FormSection({
  legend,
  children,
  columns = 2,
}: {
  legend: string;
  children: ReactNode;
  columns?: 1 | 2;
}) {
  return (
    <fieldset style={{ border: "none", padding: 0, margin: "0 0 18px" }}>
      <legend className="cp-section-legend">{legend}</legend>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gap: "12px 16px",
        }}
      >
        {children}
      </div>
    </fieldset>
  );
}

export function AdvancedDisclosure({ children, label = "Advanced configuration" }: { children: ReactNode; label?: string }) {
  return (
    <details className="cp-advanced" style={{ marginTop: 8 }}>
      <summary>{label}</summary>
      <div style={{ marginTop: 12 }}>{children}</div>
    </details>
  );
}

export function FormFooter({
  children,
  onCancel,
  cancelLabel = "Cancel",
}: {
  children: ReactNode;
  onCancel?: () => void;
  cancelLabel?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 8,
        paddingTop: 14,
        marginTop: 4,
        borderTop: "1px solid var(--color-border)",
      }}
    >
      {onCancel ? (
        <button type="button" className="cp-btn ghost" onClick={onCancel}>
          {cancelLabel}
        </button>
      ) : null}
      {children}
    </div>
  );
}

// ─── Settings helpers: dirty state, validation, setting rows ───

/**
 * Section-scoped dirty tracking. `update` merges a patch and marks dirty;
 * `reset` adopts a freshly loaded value and clears dirty. Save buttons gate on
 * `dirty`; the owner resets after a successful save.
 */
export function useDirtyState<T>(initial: T) {
  const [value, setValue] = useState<T>(initial);
  const [dirty, setDirty] = useState(false);
  const update = (patch: Partial<T>) => {
    setValue((prev) => (prev !== null && typeof prev === "object" ? ({ ...prev, ...patch } as T) : prev));
    setDirty(true);
  };
  const reset = (next: T) => {
    setValue(next);
    setDirty(false);
  };
  return { value, setValue, update, dirty, reset };
}

/** Inline validators — return the error string or null. */
export function validatePort(value: number): string | null {
  if (!Number.isFinite(value)) return "Enter a port number.";
  if (!Number.isInteger(value)) return "Use a whole number.";
  if (value < 1 || value > 65535) return "Port must be 1–65535.";
  return null;
}

export function validateIntRange(value: number, min: number, max: number, unit = ""): string | null {
  if (!Number.isFinite(value)) return "Enter a number.";
  if (!Number.isInteger(value)) return "Use a whole number.";
  if (value < min || value > max) return `Must be ${min}–${max}${unit ? ` ${unit}` : ""}.`;
  return null;
}

export function validateRequired(value: string, label = "value"): string | null {
  return value.trim() ? null : `${label} is required.`;
}

/** Type-the-resource-name confirmation gate for Danger Zone actions. */
export function useTypeToConfirm(expected: string) {
  const [value, setValue] = useState("");
  return {
    value,
    setValue,
    ok: value.trim() === expected,
    reset: () => setValue(""),
  };
}

/**
 * Bold label + one helper sentence + control, inline constraint/error adjacent
 * to the field (never toast-only).
 */
export function SettingRow({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="cp-setting-row">
      <div className="cp-setting-text">
        <label className="cp-setting-label" htmlFor={htmlFor}>
          {label}
        </label>
        {hint ? <span className="cp-field-hint">{hint}</span> : null}
        {error ? (
          <span className="cp-field-error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
      <div className="cp-setting-control">{children}</div>
    </div>
  );
}

/**
 * Mutually exclusive radio card: Recommended pill + one-line tradeoff. Radio
 * semantics via the radiogroup role so keyboard/AT users get the grouping.
 */
export function RadioCard({
  name,
  label,
  helper,
  selected,
  recommended,
  onSelect,
}: {
  name: string;
  label: string;
  helper: string;
  selected: boolean;
  recommended?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={`cp-radio-card${selected ? " is-selected" : ""}`}
      onClick={onSelect}
      data-name={name}
    >
      <span className="cp-radio-head">
        <span className="cp-radio-label">{label}</span>
        {recommended ? <span className="cp-recommended">Recommended</span> : null}
      </span>
      <span className="cp-radio-helper">{helper}</span>
    </button>
  );
}