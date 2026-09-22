/**
 * Guided Add Compute — pure model.
 *
 * Config-FIRST: no field is ever fabricated. A value is only auto-populated
 * when discovery actually observed it (or it came from an existing configured
 * node); everything else stays UNKNOWN and is confirmable/manual.
 *
 * Keeping the logic pure makes step gating, slugging and validation testable
 * without a DOM or a network.
 */
import type {
  ComputeDiscoveryResult,
  ComputeFieldMap,
  ComputeProvenance,
  ComputeValidateIssue,
  ComputeValidateResult,
  FabricLinkConfig,
  SparkConfig,
  SparkSnapshot,
} from "../../api/types";

export interface ComputeDraft {
  /** Human name (step 2). */
  name: string;
  /** Slug/id, auto-derived but editable (step 2). */
  id: string;
  kind: "spark" | "host";
  isLocal: boolean;
  lanIp: string;
  cx7Ip: string | null;
  fabric: string | null;
  sshUser: string;
  sshAuth: "key" | "pass";
  sshPassword: string;
  /** Reference into the secrets store — value never echoed. */
  credRef: string | null;
  llmPorts: number[];
  /** Discovered capability values, only as far as they were observed. */
  hostname: string | null;
  gpuChip: string | null;
  gpuMemoryGB: number | null;
  cpuCores: number | null;
  memoryGB: number | null;
  arch: string | null;
  /** Configured physical fabric edges to peers (step 5) — UNKNOWN allowed. */
  fabricLinks: FabricLinkConfig[];
  /** Whether the last read-only probe reached the host; null = not probed. */
  discoveryReachable: boolean | null;
  /** field key -> provenance. Unset key means unknown. */
  provenance: Record<string, ComputeProvenance>;
}

export type ComputeStepKey =
  | "connect"
  | "identity"
  | "capabilities"
  | "network"
  | "fabric"
  | "validate"
  | "review"
  | "save";

export interface ComputeStep {
  key: ComputeStepKey;
  title: string;
  hint: string;
}

/** 8-step guided flow. Numbered so the stepper reads as a path, not a form. */
export const COMPUTE_STEPS: ComputeStep[] = [
  { key: "connect", title: "Discover / connect", hint: "One host or a known node — read-only probe" },
  { key: "identity", title: "Identity", hint: "Name, node id, slug — uniqueness checked" },
  { key: "capabilities", title: "Capabilities", hint: "GPU, memory, cores — discovered or manual" },
  { key: "network", title: "Network", hint: "Address and LLM ports" },
  { key: "fabric", title: "Fabric", hint: "Configured peer links — UNKNOWN allowed" },
  { key: "validate", title: "Validate", hint: "INVALID blocks, NOT-VERIFIED is confirmable" },
  { key: "review", title: "Review", hint: "Everything with provenance" },
  { key: "save", title: "Save", hint: "CONFIG only — no remote action" },
];

export const STEP_LABEL: Record<ComputeStepKey, string> = COMPUTE_STEPS.reduce(
  (acc, s, i) => ({ ...acc, [s.key]: `Step ${i + 1} · ${s.title}` }),
  {} as Record<ComputeStepKey, string>
);

export function emptyDraft(): ComputeDraft {
  return {
    name: "",
    id: "",
    kind: "spark",
    isLocal: false,
    lanIp: "",
    cx7Ip: null,
    fabric: null,
    sshUser: "",
    sshAuth: "key",
    sshPassword: "",
    credRef: null,
    llmPorts: [8888],
    hostname: null,
    gpuChip: null,
    gpuMemoryGB: null,
    cpuCores: null,
    memoryGB: null,
    arch: null,
    fabricLinks: [],
    discoveryReachable: null,
    provenance: {},
  };
}

/** Safe slug: lowercase, non-alphanumerics → "-", trimmed, capped. */
export function slugify(input: string): string {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** Append a numeric suffix until the slug is free. Never returns an empty id. */
export function uniqueSlug(base: string, taken: readonly string[]): string {
  const seed = slugify(base) || "compute";
  const set = new Set(taken);
  if (!set.has(seed)) return seed;
  for (let i = 2; i < 100; i++) {
    const candidate = `${seed}-${i}`.slice(0, 64);
    if (!set.has(candidate)) return candidate;
  }
  return `${seed}-${Date.now()}`.slice(0, 64);
}

/** Draft an id from a free-text name + host, without colliding with the fleet. */
export function deriveId(name: string, host: string, taken: readonly string[]): string {
  return uniqueSlug(name.trim() || host.trim() || "compute", taken);
}

function set(draft: ComputeDraft, key: keyof ComputeDraft, value: unknown, provenance: ComputeProvenance): ComputeDraft {
  return {
    ...draft,
    [key]: value,
    provenance: { ...draft.provenance, [String(key)]: provenance },
  } as ComputeDraft;
}

/**
 * Prefill the draft from a read-only discovery result. ONLY observed/configured
 * values land; a null discovery value is left UNKNOWN rather than defaulted.
 */
export function applyDiscovery(draft: ComputeDraft, discovery: ComputeDiscoveryResult): ComputeDraft {
  let next: ComputeDraft = { ...draft, provenance: { ...draft.provenance } };
  const f = discovery.fields;

  const adopt = (key: keyof ComputeDraft, fieldValue: { value: unknown; provenance: ComputeProvenance } | undefined) => {
    if (!fieldValue || fieldValue.value == null) return;
    next = set(next, key, fieldValue.value, fieldValue.provenance);
  };

  adopt("hostname", f.hostname as ComputeFieldMap["hostname"]);
  adopt("gpuChip", f.gpuChip as ComputeFieldMap["gpuChip"]);
  adopt("gpuMemoryGB", f.gpuMemoryGB as ComputeFieldMap["gpuMemoryGB"]);
  adopt("cpuCores", f.cpuCores as ComputeFieldMap["cpuCores"]);
  adopt("memoryGB", f.memoryGB as ComputeFieldMap["memoryGB"]);
  adopt("arch", f.arch as ComputeFieldMap["arch"]);
  adopt("cx7Ip", f.cx7Ip as ComputeFieldMap["cx7Ip"]);
  adopt("fabric", f.fabric as ComputeFieldMap["fabric"]);

  if (f.nodeKind?.value === "host" || f.nodeKind?.value === "spark") {
    next = set(next, "kind", f.nodeKind.value, "configured");
  }
  if (discovery.host && !next.lanIp) {
    next = set(next, "lanIp", discovery.host, discovery.hostProvenance === "configured" ? "configured" : "manual");
  }
  if (!next.name && f.hostname?.value) next = set(next, "name", f.hostname.value, "discovered");
  if (!next.id) next = set(next, "id", slugify(next.name || discovery.host), "inferred");
  next.discoveryReachable = discovery.reachable;

  const reachablePort = discovery.endpoints.find((e) => e.reachable)?.port;
  if (reachablePort && !next.llmPorts.includes(reachablePort)) {
    next = set(next, "llmPorts", [...next.llmPorts, reachablePort], "discovered");
  }
  return next;
}

/** Mark a field as operator-typed (MANUAL), overwriting any prior provenance. */
export function markManual(draft: ComputeDraft, key: keyof ComputeDraft): ComputeDraft {
  return { ...draft, provenance: { ...draft.provenance, [String(key)]: "manual" } };
}

/** Peer nodes available to link into the physical fabric (never self). */
export function fabricPeerOptions(nodes: readonly { id: string; name?: string }[], selfId: string) {
  return nodes.filter((n) => n.id && n.id !== selfId);
}

/** The effective remote target host. */
export function draftHost(draft: ComputeDraft): string {
  return draft.lanIp.trim();
}

/**
 * Local, synchronous mirror of the server's rule split:
 *  - `blocking` = INVALID issues (must resolve before SAVE)
 *  - `advisory` = NOT-VERIFIED issues (confirmable, do not block)
 * Kept intentionally narrow; the server remains authoritative on SAVE.
 */
export function validateLocal(
  draft: ComputeDraft,
  existing: readonly { id: string; lanIp?: string; ssh?: { host?: string } }[]
): { blocking: ComputeValidateIssue[]; advisory: ComputeValidateIssue[] } {
  const blocking: ComputeValidateIssue[] = [];
  const advisory: ComputeValidateIssue[] = [];
  const push = (
    arr: ComputeValidateIssue[],
    code: string,
    field: string,
    severity: "invalid" | "unverified",
    message: string
  ) => arr.push({ code, field, severity, message });

  if (!draft.id.trim()) push(blocking, "id-missing", "id", "invalid", "Node id is required.");
  else if (!/^[a-zA-Z0-9._-]{1,64}$/.test(draft.id.trim()))
    push(blocking, "id-malformed", "id", "invalid", "Id allows a-z A-Z 0-9 . _ - (1–64).");
  else if (existing.some((n) => n.id === draft.id.trim()))
    push(blocking, "id-duplicate", "id", "invalid", `Node id “${draft.id}” already exists.`);

  if (!draft.name.trim()) push(blocking, "name-missing", "name", "invalid", "Display name is required.");

  const host = draftHost(draft);
  if (!host && !draft.isLocal) push(blocking, "host-missing", "lanIp", "invalid", "A hostname or IP is required.");
  else if (host && existing.some((n) => n.lanIp === host || n.ssh?.host === host))
    push(blocking, "host-duplicate", "lanIp", "invalid", `Host “${host}” is already used by another node.`);
  if (host && !/^[a-zA-Z0-9.\-_]+$/.test(host)) push(blocking, "host-invalid", "lanIp", "invalid", "Host has invalid characters.");

  if (!draft.isLocal) {
    if (!draft.sshUser.trim()) push(blocking, "ssh-user-missing", "sshUser", "invalid", "SSH user is required for a remote node.");
    if (draft.sshAuth === "pass" && !draft.sshPassword && !draft.credRef)
      push(blocking, "ssh-password-missing", "sshPassword", "invalid", "Password auth selected but no password/cred ref supplied.");
  }

  if (draft.llmPorts.length === 0) push(advisory, "ports-empty", "llmPorts", "unverified", "No LLM port declared — endpoints stay UNKNOWN.");
  if (!draft.gpuChip && !draft.isLocal) push(advisory, "gpu-unknown", "gpuChip", "unverified", "No GPU discovered — capabilities stay UNKNOWN.");

  for (const link of draft.fabricLinks) {
    if (link.to === draft.id) push(blocking, "fabric-self", "fabricLinks", "invalid", "A node cannot link to itself.");
  }
  return { blocking, advisory };
}

/** Normalize positive integer-ish input, dropping junk. */
export function parsePorts(input: string, fallback = 8888): number[] {
  const ports = String(input || "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
  const unique = [...new Set(ports)];
  return unique.length ? unique : [fallback];
}

/** Build the config-only save payload from a draft (no remote action). */
export function draftToConfig(draft: ComputeDraft): SparkConfig {
  const host = draftHost(draft);
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    kind: draft.kind,
    lanIp: host,
    cx7Ip: draft.cx7Ip,
    fabric: draft.fabric,
    fabricLinks: draft.fabricLinks.length ? draft.fabricLinks : null,
    isLocal: draft.isLocal,
    llmPorts: draft.llmPorts,
    ssh: {
      host,
      user: draft.sshUser.trim() || "root",
      auth: draft.sshAuth,
      ...(draft.sshPassword ? { password: draft.sshPassword } : {}),
    },
  };
}

/** SparkSnapshot -> minimal node shape for uniqueness/peer selection. */
export function snapshotNode(s: Pick<SparkSnapshot, "id" | "name" | "lanIp">) {
  return { id: s.id, name: s.name, lanIp: s.lanIp, ssh: { host: s.lanIp } };
}

/** Merge server validation with the local mirror (server wins on overlaps). */
export function mergeValidation(
  local: { blocking: ComputeValidateIssue[]; advisory: ComputeValidateIssue[] },
  server: ComputeValidateResult | null
): { blocking: ComputeValidateIssue[]; advisory: ComputeValidateIssue[]; serverUnverified: number } {
  if (!server) return { ...local, serverUnverified: 0 };
  const byCode = new Map(local.blocking.map((i) => [i.code, i]));
  for (const i of server.issues) if (i.severity === "invalid") byCode.set(i.code, i);
  const advCodes = new Map(local.advisory.map((i) => [i.code, i]));
  for (const i of server.issues) if (i.severity === "unverified") advCodes.set(i.code, i);
  return { blocking: [...byCode.values()], advisory: [...advCodes.values()], serverUnverified: server.unverifiedCount };
}
