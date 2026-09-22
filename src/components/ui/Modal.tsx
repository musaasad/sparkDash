import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "./icons";

/**
 * Centered 440px confirm/mutation modal: title, one consequence sentence,
 * optional from→to diagram, accent info banner, footer ghost Cancel + solid
 * verb-named primary. Destructive variants swap the primary to error bg.
 */
export function Modal({
  open,
  title,
  consequence,
  diagram,
  info,
  confirmLabel,
  cancelLabel = "Cancel",
  discardLabel,
  onDiscard,
  tone = "primary",
  busy = false,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  /** One sentence: what this will do. */
  consequence: string;
  /** Optional from → to state diagram. */
  diagram?: ReactNode;
  /** Accent-tint propagation banner. */
  info?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Optional third action: throw away unsaved changes. */
  discardLabel?: string;
  onDiscard?: () => void;
  tone?: "primary" | "danger";
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    confirmRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="cp-modal-overlay" onClick={onClose}>
      <div
        className="cp-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cp-modal-head">
          <h2 className="cp-modal-title">{title}</h2>
          <button type="button" className="cp-btn ghost icon" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <p className="cp-modal-consequence">{consequence}</p>
        {diagram ? <div className="cp-modal-diagram">{diagram}</div> : null}
        {info ? <div className="cp-modal-info">{info}</div> : null}
        {children ? <div className="cp-modal-body">{children}</div> : null}
        <div className="cp-modal-foot">
          <button type="button" className="cp-btn ghost" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </button>
          {onDiscard ? (
            <button type="button" className="cp-btn ghost" onClick={onDiscard} disabled={busy}>
              {discardLabel ?? "Discard"}
            </button>
          ) : null}
          <button
            ref={confirmRef}
            type="button"
            className={`cp-btn ${tone === "danger" ? "danger-solid" : "primary"}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
