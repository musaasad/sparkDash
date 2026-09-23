import { useEffect, useRef, useState } from "react";
import type { LocalWeightsSeed, WeightsScanMatch, WeightsScanResult } from "../../api/types";
import { scanLocalWeights } from "../../api/client";
import { Field, TextInput, FormSection, FormFooter } from "../ui/form";
import { Chip } from "../ui/Status";
import { ProvenanceBadge } from "./ProvenanceBadge";

interface LocalWeightsFormProps {
  onSeed: (seed: LocalWeightsSeed) => void;
  onBack: () => void;
}

/** Compact, human size — an unknown size reads "—", never a fake 0. */
function sizeDisplay(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Display name from a filename — the real filename, never a fabricated family. */
function displayName(name: string): string {
  return name.replace(/\.(safetensors|gguf|bin|pt|pth|onnx|exl3|awq|gptq|npz)(\.index\.json)?$/i, "").replace(/[-_]+/g, " ").trim() || name;
}

/**
 * "Discover local weights" — a first-class creation path for weights that are
 * ALREADY on disk. Read-only readdir/stat over CONFIGURED directories only;
 * bounded, no filesystem sweep, no file moved or copied.
 *
 * When nothing is configured it says so honestly (never a fake empty success)
 * and points at Advanced. A probe cannot know the family — that stays UNKNOWN.
 */
export function LocalWeightsForm({ onSeed, onBack }: LocalWeightsFormProps) {
  const [result, setResult] = useState<WeightsScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extraDir, setExtraDir] = useState("");
  const [picked, setPicked] = useState<WeightsScanMatch | null>(null);
  const firstRun = useRef(true);

  async function scan(dirs: string[] = []) {
    setBusy(true);
    setError(null);
    try {
      setResult(await scanLocalWeights({ dirs }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Compact first screen: one automatic bounded scan, nothing else dumped.
  useEffect(() => {
    if (!firstRun.current) return;
    firstRun.current = false;
    void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cont() {
    if (!picked) {
      setError("Pick a weight file first.");
      return;
    }
    onSeed({ path: picked.path, name: picked.name, dir: picked.dir, provenance: picked.provenance });
  }

  const matches = result?.matches ?? [];

  return (
    <div className="cp-panel">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Discover local weights</span>
        <Chip tone="accent">read-only · readdir/stat</Chip>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "0 0 4px", maxWidth: 560 }}>
        SparkDash lists weight files in the weight directories YOU configured. It does not sweep the whole filesystem.
      </p>
      <p className="cp-field-hint" style={{ margin: "0 0 12px", maxWidth: 560 }}>
        SparkDash will NOT move, copy, rename or download any weight file — you only register a path.
      </p>

      <FormSection legend="Scan a bounded set of directories" columns={1}>
        <Field label="Add a directory (optional)" htmlFor="lw-dir" hint="Absolute POSIX path; configured directories are always scanned">
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <TextInput id="lw-dir" mono style={{ flex: 1 }} value={extraDir} placeholder="/home/user/models" onChange={(e) => setExtraDir(e.target.value)} />
            <button
              type="button"
              className="cp-btn"
              disabled={busy}
              onClick={() => {
                const d = extraDir.trim();
                if (d) void scan([d]);
              }}
            >
              Add &amp; rescan
            </button>
          </div>
        </Field>
      </FormSection>

      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <button type="button" className="cp-btn primary" onClick={() => void scan()} disabled={busy}>
          {busy ? "Scanning…" : "Rescan configured directories"}
        </button>
        <button type="button" className="cp-btn" onClick={onBack}>
          Back to paths
        </button>
      </div>

      {error ? (
        <div className="cp-panel" style={{ borderColor: "var(--color-danger)", marginBottom: 14 }} role="alert">
          <div className="cp-field-error">{error}</div>
        </div>
      ) : null}

      {result && !result.configured && result.scannedDirs.length === 0 ? (
        <div className="cp-panel" style={{ borderColor: "var(--color-warning)", marginBottom: 14 }} role="status" data-lw-state="unconfigured">
          <div style={{ fontSize: 12, color: "var(--color-warning)" }}>
            No weights directory configured — configure one (Settings → weights dirs) or type a directory above, or use
            Advanced.
          </div>
          <p className="cp-field-hint" style={{ margin: "4px 0 0" }}>
            Add <span className="mono">weightsDirs</span> in settings, or register a model weight path.
          </p>
        </div>
      ) : null}

      {result && (result.configured || result.scannedDirs.length > 0) ? (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
            <span className="cp-field-hint" data-lw-state="scanned">
              {result.scannedDirs.length} director{result.scannedDirs.length === 1 ? "y" : "ies"} scanned ·{" "}
              {matches.length} weight file{matches.length === 1 ? "" : "s"}
              {result.truncated ? <span style={{ color: "var(--color-warning)" }}> · truncated to bounds</span> : null}
            </span>
            {result.missingDirs.length ? (
              <Chip tone="default" title={result.missingDirs.join(", ")}>
                {result.missingDirs.length} dir(s) missing — UNKNOWN
              </Chip>
            ) : null}
          </div>

          {matches.length === 0 ? (
            <div className="cp-panel" style={{ borderColor: "var(--color-warning)", marginBottom: 14 }} role="status" data-lw-state="empty">
              <div style={{ fontSize: 12, color: "var(--color-warning)" }}>
                Configured directories answered but held no weight files (gguf / safetensors / bin / …).
              </div>
            </div>
          ) : (
            <div role="radiogroup" aria-label="Weight file" style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }} data-lw-matches>
              {matches.map((m) => (
                <button
                  key={m.path}
                  type="button"
                  role="radio"
                  aria-checked={picked?.path === m.path}
                  className={`cp-pick ${picked?.path === m.path ? "is-selected" : ""}`}
                  style={{ display: "flex", gap: 10, alignItems: "center", textAlign: "left" }}
                  onClick={() => setPicked(m)}
                >
                  <span className="mono" style={{ flex: 1, fontSize: 12, overflowWrap: "anywhere" }}>{m.name}</span>
                  <span className="muted" style={{ fontSize: 11 }}>{sizeDisplay(m.sizeBytes)}</span>
                  <ProvenanceBadge value={m.provenance} />
                  <span className="cp-field-hint mono" style={{ maxWidth: 260, overflowWrap: "anywhere" }}>{m.dir}</span>
                </button>
              ))}
            </div>
          )}
        </>
      ) : null}

      {picked ? (
        <div className="cp-panel" style={{ borderColor: "var(--color-accent)", marginBottom: 14 }}>
          <div style={{ fontSize: 12 }}>
            Will register model <span className="mono">{displayName(picked.name)}</span> with weight path{" "}
            <span className="mono">{picked.path}</span>.
          </div>
          <p className="cp-field-hint" style={{ margin: "4px 0 0" }}>
            Family stays UNKNOWN — a filename is not proof. You confirm it in the next step.
          </p>
        </div>
      ) : null}

      <FormFooter onCancel={onBack} cancelLabel="Cancel">
        <button type="button" className="cp-btn primary" onClick={cont} disabled={!picked}>
          Continue to setup
        </button>
      </FormFooter>
    </div>
  );
}
