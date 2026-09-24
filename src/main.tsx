import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// One-time token bootstrap for authenticated LAN access. A trusted device opens
// http://<host>:5555/?token=<TOKEN> once; we persist it to localStorage — the
// SAME place the existing bearer auth reads it (src/api/client.ts, useSnapshot)
// — then strip it from the URL so it does not linger in the address bar/history.
// This is not a second auth system; it only seeds the existing bearer token.
try {
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const tk = params.get("token");
    if (tk) {
      localStorage.setItem("sparkdashToken", tk);
      params.delete("token");
      const q = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${q ? `?${q}` : ""}${window.location.hash}`);
    }
  }
} catch {
  /* localStorage/URL unavailable — fall back to manual token entry */
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);