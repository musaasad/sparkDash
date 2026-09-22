import type { ReactNode, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

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