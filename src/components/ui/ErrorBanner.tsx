import { InfoIcon } from "./icons";

interface ErrorBannerProps {
  message: string | null;
  onDismiss: () => void;
  /** Optional inline retry — shell/nav stay interactive behind the banner. */
  onRetry?: () => void;
}

export function ErrorBanner({ message, onDismiss, onRetry }: ErrorBannerProps) {
  if (!message) return null;
  return (
    <div className="cp-error-banner" role="alert">
      <InfoIcon />
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry ? (
        <button type="button" className="cp-btn ghost" onClick={onRetry}>
          Retry
        </button>
      ) : null}
      <button type="button" className="cp-btn ghost" onClick={onDismiss} aria-label="Dismiss error">
        Dismiss
      </button>
    </div>
  );
}
