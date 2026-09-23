// ─── Spark config (matches server/sparks.json) ────────────
/**
 * READ-ONLY configured physical fabric neighbour. Config data only — a
 * discovered (observed) link is a separate provenance and is never written here.
 */
export interface FabricLinkConfig {
  /** Peer node id on the same physical fabric. */
  to: string;
  /** Known physical link speed in Mbps, else null. */
  speedMbps?: number | null;
  /** Physical medium: ConnectX-7 or a named fabric. */
  medium?: "cx7" | "fabric";
}

export interface SparkConfig {
  id: string;
  name: string;
  /**
   * Unit type:
   * - spark: NVIDIA DGX Spark (default) — DGX Spark specs shown in the header.
   * - host: any Linux box with an NVIDIA GPU (still monitored via nvidia-smi,
   *   just not a Spark). Real hardware is auto-detected once online.
   */
  kind?: "spark" | "host";
  lanIp: string;
  cx7Ip?: string | null;
  /** Optional named physical fabric this unit is wired into (link discovery hint). */
  fabric?: string | null;
  /** READ-ONLY configured physical fabric neighbours (never derived). */
  fabricLinks?: FabricLinkConfig[] | null;
  /**
   * Optional Wake-on-LAN MAC override. When empty, the server uses
   * `detectedMacAddress` from the enP7s7 interface.
   */
  macAddress?: string | null;
  /** Last MAC read from enP7s7 while the Spark was online (read-only). */
  detectedMacAddress?: string | null;
  isLocal: boolean;
  ssh: {
    host: string;
    user: string;
    auth: "key" | "pass";
    /** Request-only: never returned by GET/list */
    password?: string;
    /** Response-only: true when a password is held in server memory */
    hasPassword?: boolean;
  };
  disabledDevices?: string[];
  /** Interface names hidden from the Network panel main view */
  disabledInterfaces?: string[];
  /** HTTP port for the LLM server on this Spark (legacy single-port, prefer llmPorts) */
  llmPort?: number;
  /** HTTP ports for LLM servers on this Spark (default [8888]) */
  llmPorts?: number[];
  /**
   * Ports that have an encrypted LLM API key stored server-side.
   * The key itself is never returned by the API.
   */
  llmApiKeyPorts?: number[];
  /**
   * Cluster role for overview + worker behavior.
   * - head / standalone: local LLM API probed
   * - worker: no local API (LLM card hidden, ports not probed)
   */
  role?: SparkRole;
  /**
   * Legacy/derived: true when role is worker. Prefer `role`.
   * Kept so existing probe/card checks keep working.
   */
  workerNode?: boolean;
  /**
   * Optional label for a worker node (cluster / model name), shown on the overview card.
   * Only meaningful when role is worker.
   */
  workerLabel?: string | null;
  /**
   * Optional id of the head Spark this worker belongs to.
   * Only meaningful when role is worker.
   */
  workerHeadId?: string | null;
  /**
   * Standalone only: probe local LLM and show the LLM card (default true).
   * Forced true for head, forced false for worker.
   */
  llmMonitoring?: boolean;
  /**
   * Probe local ComfyUI and show the ComfyUI card (default false; all roles).
   */
  comfyMonitoring?: boolean;
  /** ComfyUI HTTP port (default 8188). */
  comfyPort?: number;
  /**
   * Opt-in: Hermes Agent CLI (nousresearch/hermes-agent) is installed on this
   * machine. When enabled, sparkDash checks for Hermes updates and can run
   * `hermes update` for you via SSH.
   */
  hermesMonitoring?: boolean;
  /**
   * Report tailnet presence via `tailscale status --json` (default false; all roles).
   */
  tailscaleMonitoring?: boolean;
  /** When true, storage is only updated on manual refresh, not auto-polled. */
  storagePollDisabled?: boolean;
}

export type SparkRole = "head" | "worker" | "standalone";

// ─── Hermes Agent status ───────────────────────────────
/** Opt-in Hermes Agent update monitoring state, pushed in every snapshot. */
export interface HermesStatus {
  /** Opt-in setting from Edit Spark (hermes installed on this machine). */
  monitoring: boolean;
  /** Whether the `hermes` binary was found on the target. null before first check. */
  installed: boolean | null;
  /** Installed version string when detected (e.g. "0.20.0"). */
  version: string | null;
  /** true when `hermes update --check` reports commits behind origin/main. */
  updateAvailable: boolean | null;
  /** Number of commits behind origin/main when reported. */
  behindCommits: number | null;
  /** Last check time (ms epoch). */
  checkedAt: number | null;
  /** One-shot update job state. */
  status: "idle" | "running" | "success" | "error";
  startedAt: number | null;
  finishedAt: number | null;
  /** Short human-readable message when the last check/update failed. */
  error: string | null;
}

/** Latest public Hermes Agent release (changelog for the update dialog). */
export interface HermesRelease {
  /** GitHub release tag, e.g. "v2026.7.7.2". */
  tagName: string;
  /** Human release name, e.g. "Hermes Agent v0.18.1 (v2026.7.7.2)". */
  name: string;
  version: string;
  /** Semantic version of the release (e.g. "0.20.0") for bump detection. */
  semver: string | null;
  publishedAt: string | null;
  htmlUrl: string;
  /** Markdown release body. */
  body: string;
}

/** One pending commit an update would bring (from git HEAD..origin/main). */
export interface HermesPendingCommit {
  sha: string;
  title: string;
}

/** One Spark's outcome from a batch `update-all` call. */
export interface HermesBatchUpdateResult {
  id: string;
  name: string;
  ok: boolean;
  started: boolean;
  skipped?: boolean;
  reason?: string;
}

export interface HermesBatchUpdateResponse {
  success: boolean;
  results: HermesBatchUpdateResult[];
}

/** Per-Spark update preview used by the confirmation dialog. */
export interface HermesUpdatesResponse {
  success: boolean;
  /** Which content the dialog should lead with. */
  view: "commits" | "release";
  /** Latest tagged release (may be null on GitHub API failure). */
  release: HermesRelease | null;
  releaseError: string | null;
  /** Installed hermes version on this Spark (e.g. "0.20.0"), when known. */
  installedVersion: string | null;
  /** Pending commits from git (may be null if the repo can't be read). */
  pending: { count: number; headSha: string | null; commits: HermesPendingCommit[] } | null;
}

// ─── Hardware info ───────────────────────────────────────
export interface HardwareInfo {
  device: string;
  cpuModel: string | null;
  cpuCores: number | null;
  totalMemoryGB: number | null;
  gpuChip: string | null;
  cudaDriver: string | null;
  storageModel: string | null;
}

// ─── GPU metrics ─────────────────────────────────────────
export interface GpuThrottle {
  /** HW or SW thermal slowdown engaged. */
  thermal: boolean;
  /** HW slowdown (may include thermal or power brake). */
  hwSlowdown: boolean;
  /** SW power-cap scaling limiting clocks. */
  powerCap: boolean;
  /** Any limiting reason above. */
  active: boolean;
  reason: "ok" | "thermal" | "power" | "hw" | "unknown";
  smClockMHz: number | null;
  smClockMaxMHz: number | null;
  /** Current SM clock as % of max (0–100). null when clocks unavailable. */
  smClockPct: number | null;
  /** Human-readable active reasons (tooltip). */
  detail: string;
}

export interface GpuMetrics {
  temperature: number;
  usage: number;
  power: {
    draw: number;
    limit: number;
    /** Estimated total system power draw (GPU + CPU + CX7/peripherals). */
    systemDraw?: number;
  };
  vram: {
    used: number;
    total: number;
    percentage: number;
    /** MemAvailable in MB — the real free memory in the shared pool. */
    available: number;
  };
  /** Top GPU processes by VRAM usage (sorted descending, max 5). */
  processes?: Array<{ pid: number; name: string; vramMB: number }>;
  /** NVIDIA clock throttle / thermal slowdown state from nvidia-smi. */
  throttle?: GpuThrottle | null;
  /** Kernel NVRM NV_ERR_NO_MEMORY count since boot (cached ~60s). */
  nvErrNoMemory?: number;
}

// ─── CPU metrics ─────────────────────────────────────────
export interface CpuMetrics {
  usage: number;
  temperature: number;
  draw: number;
  tdp: number;
}

// ─── RAM metrics ─────────────────────────────────────────
export interface RamMetrics {
  used: number;
  total: number;
  percentage: number;
}

// ─── Storage metrics ─────────────────────────────────────
export interface StorageMetrics {
  device: string;
  label: string;
  used: number;
  total: number;
  available: number;
  percentage: number;
  readSpeed: number;
  writeSpeed: number;
  /** Present when device is in disabledDevices; still returned for Settings UI */
  disabled?: boolean;
}

// ─── Network metrics ─────────────────────────────────────
export interface NetworkInterface {
  name: string;
  rxSpeed: number;
  txSpeed: number;
  /** IPv4 address, e.g. "192.168.1.143". null when unset. */
  ip: string | null;
  /** Interface operstate: "up" | "down" | "unknown" */
  operstate: string;
  /** Present when interface is in disabledInterfaces; still returned for Settings UI */
  disabled?: boolean;
}

export interface NetworkMetrics {
  primaryInterface: string | null;
  linkSpeedMbps: number | null;
  interfaces: NetworkInterface[];
  /** MAC of enP7s7 when present (same value persisted as detectedMacAddress). */
  wolMac?: string | null;
}

// ─── Unified memory metrics ──────────────────────────────
export interface UnifiedMemoryMetrics {
  total: number;
  gpuUsed: number;
  cpuUsed: number;
  used: number;
  available: number;
  percentage: number;
  oomRisk: "low" | "medium" | "high";
  bandwidth: {
    current: number;
    peak: number;
  };
}

// ─── LLM metrics ─────────────────────────────────────────
export interface LlmMetrics {
  available: boolean;
  backend: "vllm" | "llama.cpp" | "sglang" | "ds4" | "exl3" | "q27" | null;
  modelId: string | null;
  modelPath: string | null;
  contextLength: number | null;
  /** GPU memory utilization for the LLM engine (0–1), e.g. 0.9. Only from vLLM internal info. */
  gpuMemoryUtilization: number | null;
  slotsActive: number;
  slotsTotal: number;
  generationTps: number;
  prefillTps: number;
  /** Live cached-prefill tok/s when the backend splits kinds (ds4, llama.cpp, sglang). */
  cachedPrefillTps?: number | null;
  /** Live uncached/computed prefill tok/s when split is available. */
  uncachedPrefillTps?: number | null;
  /** Cumulative total output (generation) tokens as reported by the LLM server */
  totalOutputTokens: number;
  /** vLLM KV cache usage fraction (0–1). null when backend !== vllm or unreachable. */
  kvCacheUsage?: number | null;
  /** vLLM running request count. null when unavailable. */
  requestsRunning?: number | null;
  /** vLLM waiting request count. null when unavailable. */
  requestsWaiting?: number | null;
  /** vLLM time-to-first-token p95 in seconds. null when unavailable. */
  ttftP95Seconds?: number | null;
  /** Live recent-window mean TTFT (seconds) from vLLM histogram sum/count deltas. null when unavailable. */
  ttftSeconds?: number | null;
  /** vLLM cumulative preemption count. null when unavailable. */
  preemptionsTotal?: number | null;
  /** vLLM prefix-cache hit rate (hits/queries, 0–1). null when unavailable. */
  prefixCacheHitRate?: number | null;
  /** vLLM end-to-end request latency p95 in seconds. null when unavailable. */
  e2eP95Seconds?: number | null;
  /** vLLM inter-token latency p95 in seconds. null when unavailable. */
  itlP95Seconds?: number | null;
  /** vLLM speculative/MTP acceptance rate (accepted/drafted, 0–1). null when unavailable. */
  mtpAcceptanceRate?: number | null;
  /**
   * Observational exposure hint from unauthenticated probe reachability +
   * configured target host scope. null when auth status is unknown.
   * Does not claim process bind address.
   */
  posture?: LlmPosture | null;
  error: string | null;
}

/** One UTC day of busy tok/s rollups (null avg = no busy samples). */
export interface LlmDailyDay {
  date: string;
  decodeMax: number;
  decodeAvg: number | null;
  prefillMax: number;
  prefillAvg: number | null;
  cachedPrefillMax: number | null;
  cachedPrefillAvg: number | null;
  uncachedPrefillMax: number | null;
  uncachedPrefillAvg: number | null;
}

export interface LlmDailyResponse {
  sparkId: string;
  port: number;
  days: LlmDailyDay[];
}

/** Security posture badge payload from LlmProbe. */
export interface LlmPosture {
  /** ok = green, warn = amber, danger = red */
  level: "ok" | "warn" | "danger";
  auth: "open" | "protected" | "keyed";
  scope: "local" | "lan" | "public" | "unknown";
  /** Short badge text */
  label: string;
  /** Tooltip / title detail */
  detail: string;
}

// ─── ComfyUI metrics ─────────────────────────────────────
/** Active or queued ComfyUI job (parsed from /queue prompt graph). */
export interface ComfyJob {
  id: string;
  status: "running" | "pending";
  /** Workflow title when present in extra_pnginfo. */
  title: string | null;
  /** Model weight files referenced by loader nodes. */
  models: string[];
  nodeCount: number;
  steps: number | null;
  width: number | null;
  height: number | null;
  batchSize: number | null;
  sampler: string | null;
  /** Queue entry create time (ms epoch when available). */
  createTime: number | null;
}

/** Live or estimated progress for the active Comfy job. */
export interface ComfyProgress {
  promptId: string | null;
  nodeId: string | null;
  nodeLabel: string | null;
  value: number;
  max: number;
  percent: number | null;
  updatedAt: number;
  /** ws = Comfy WebSocket frames; estimate = elapsed/avg heuristic */
  source?: "ws" | "estimate";
}

export interface ComfyLastJob {
  id: string;
  status: "completed" | "failed" | "cancelled" | string;
  title: string | null;
  durationMs: number | null;
  endedAt: number | null;
}

export interface ComfyModelsInstalled {
  checkpoints: string[];
  loras: string[];
}

export interface ComfyMetrics {
  available: boolean;
  port: number;
  version: string | null;
  pytorchVersion: string | null;
  /** Primary device type from /system_stats (e.g. cpu, cuda) — not VRAM. */
  deviceType?: string | null;
  queueRunning: number;
  queuePending: number;
  /** Currently executing job, if any. */
  activeJob?: ComfyJob | null;
  /** Next pending jobs (capped server-side). */
  pendingJobs?: ComfyJob[];
  progress?: ComfyProgress | null;
  lastJob?: ComfyLastJob | null;
  modelsInstalled?: ComfyModelsInstalled | null;
  /** Estimated ms until queue idle (running remainder + pending × avg). */
  queueEtaMs?: number | null;
  /** Browser-openable ComfyUI base URL (probe host + port). */
  openUrl?: string | null;
  error: string | null;
}

export interface TailscaleMetrics {
  /** True when `tailscale status --json` was read and had a Self entry. */
  available: boolean;
  /**
   * The node's OWN view of whether it is talking to the coordination server.
   * null when tailscale did not report it.
   */
  online: boolean | null;
  /** tailscaled's own state: Running | Stopped | NeedsLogin | NoState. */
  backendState: string | null;
  hostName: string | null;
  dnsName: string | null;
  tailscaleIp: string | null;
  /** DERP relay region, or null when the node has a direct path. */
  relay: string | null;
  /** ISO timestamp; null when key expiry is disabled for this node. */
  keyExpiry: string | null;
  keyExpired: boolean;
  version: string | null;
  /** Tailscale's own health warnings — these explain a false `online`. */
  health: string[];
  error: string | null;
}

// ─── Full metrics snapshot ────────────────────────────────
export interface SparkMetrics {
  gpu: GpuMetrics | null;
  cpu: CpuMetrics | null;
  ram: RamMetrics | null;
  storage: StorageMetrics[];
  network: NetworkMetrics | null;
  unifiedMemory: UnifiedMemoryMetrics | null;
  /** Array of LLM metrics, one per configured port. Empty array when no ports. */
  llm: LlmMetrics[];
  /** ComfyUI probe result when monitoring is enabled; null when off or not yet polled. */
  comfy?: ComfyMetrics | null;
  /** Tailnet probe result when monitoring is enabled; null when off or not yet polled. */
  tailscale?: TailscaleMetrics | null;
}

// ─── Spark snapshot (server pushes this) ──────────────────
export interface SparkSnapshot {
  id: string;
  name: string;
  /** Unit type: spark (DGX Spark) or host (dedicated GPU Linux box). */
  kind?: "spark" | "host";
  online: boolean;
  /** Uptime in seconds, or null when offline */
  uptime: number | null;
  /** LAN IP for browser deep-links (e.g. Open ComfyUI). */
  lanIp?: string;
  /** ConnectX-7 fabric IP when configured (physical-fabric link discovery). */
  cx7Ip?: string | null;
  /** Optional named physical fabric this unit is wired into. */
  fabric?: string | null;
  /** READ-ONLY configured physical fabric neighbours (CONFIGURED provenance). */
  fabricLinks?: FabricLinkConfig[] | null;
  isLocal?: boolean;
  disabledDevices: string[];
  disabledInterfaces: string[];
  storagePollDisabled?: boolean;
  /** Cluster role (head / worker / standalone) */
  role?: SparkRole;
  /** Distributed LLM worker — LLM card inactive / not shown (role === worker) */
  workerNode?: boolean;
  /** Optional cluster/model label when role is worker */
  workerLabel?: string | null;
  /**
   * Derived worker label: live mirror of the head's served model id.
   * Display-only (never written to config). A non-empty manual workerLabel
   * takes priority over this in the UI.
   */
  workerDerivedLabel?: string | null;
  /** Optional head Spark id when role is worker */
  workerHeadId?: string | null;
  /** Standalone: whether LLM is probed (head always true, worker always false) */
  llmMonitoring?: boolean;
  /** LLM server port (first port, for backward compat) */
  llmPort: number;
  /** All LLM server ports configured for this Spark */
  llmPorts: number[];
  /** Ports with a stored LLM API key (key itself never exposed) */
  llmApiKeyPorts?: number[];
  /** Whether ComfyUI is probed (opt-in; all roles) */
  comfyMonitoring?: boolean;
  /** ComfyUI HTTP port (default 8188) */
  comfyPort?: number;
  /** Whether tailnet presence is probed (opt-in; all roles) */
  tailscaleMonitoring?: boolean;
  /** Hermes Agent update monitoring state (present in every snapshot). */
  hermes?: HermesStatus;
  hardware: HardwareInfo;
  metrics: SparkMetrics;
}

// ─── WebSocket envelope ───────────────────────────────────
export interface WsSnapshot {
  type: "snapshot";
  /** Server generation time; optional while clients and servers roll independently. */
  generatedAt?: number;
  sparks: SparkSnapshot[];
  refreshInterval: number;
}

export interface FleetEnergy {
  estimated: boolean;
  membershipChanged: boolean;
  restartRequired: boolean;
  trackedNodeIds: string[];
  currentNodeIds: string[];
  freshNodeCount: number;
  currentWatts30s: number | null;
  energy24hKwh: number | null;
  energy31dKwh: number | null;
  whPerOutputToken24h: number | null;
  outputTokens24h: number;
  coverage24hMs: number;
  coverage31dMs: number;
  nodeCoverage24hMs: Record<string, number>;
  nodeCoverage31dMs: Record<string, number>;
  hourlyWatts24h: Array<number | null>;
}

// ─── API responses ────────────────────────────────────────
export interface Settings {
  pollIntervalMs: number;
  defaultLlmPort: number;
  autoHideOffline: boolean;
  /** Hide worker-role Sparks from Overview cards and the tab bar. */
  hideWorkers: boolean;
  temperatureUnit: "celsius" | "fahrenheit";
  /** Persist prompts / HTTP traces / GPU samples on decode benchmark runs. */
  benchDebugTraces: boolean;
  /** Layout density — compact (default) or comfortable. */
  density: "comfortable" | "compact";
  /** Overview Fleet Energy card. Off by default. */
  showFleetEnergy: boolean;
  /** Overview active fleet exceptions strip. Off by default. */
  showFleetExceptions: boolean;
  /** Overview search field + status filter. Off by default. */
  showOverviewSearch: boolean;
  /** Benchmark dialogs offer "Copy image" — a PNG share card of the results. */
  benchShareImage: boolean;
}

export interface SparksListResponse {
  sparks: SparkConfig[];
}

export interface SparkTestResponse {
  id: string;
  capabilities: Array<{
    id: "host" | "llm" | "comfy" | "hermes" | "tailnet";
    label: string;
    status: "pass" | "fail" | "skipped";
    required: boolean;
    message: string;
    recovery: string | null;
  }>;
  ssh: { ok: boolean; message: string };
  llm: { ok: boolean; message: string; skipped?: boolean };
  comfy?: { ok: boolean; message: string; skipped?: boolean };
  ok: boolean;
}

export interface ApiError {
  error: string;
}

// ─── LLM decode benchmark ────────────────────────────────
/** Output-shape label for decode bench prompts (not guided decoding). */
export type DecodeBenchPromptType = "structured" | "prose" | "code" | "json";

/** On-demand remote LLM endpoint for decode/prefill benches. */
export interface LlmBenchTarget {
  host: string;
  port: number;
  tls: boolean;
}

export interface DecodeBenchConfig {
  port: number;
  modelId: string | null;
  concurrencies: number[];
  maxTokens: number;
  /** Output-shape label only — not guided decoding / JSON schema. */
  promptType?: DecodeBenchPromptType;
  /** On-demand remote host (Tailscale HTTPS, etc.). */
  host?: string;
  tls?: boolean;
  /** Control-plane recipe this run belongs to (server-derived or explicit). */
  recipeId?: string | null;
}

export interface DecodeBenchStreamResult {
  index: number;
  ttftMs: number;
  /** First answer token (post-reasoning) in ms from request start; null when the reply never leaves the reasoning phase. */
  ttftContentMs: number | null;
  /** Number of streamed chunks that carried reasoning (not answer) text. */
  reasoningChunks: number;
  decodeTps: number;
  decodeTokens: number;
  completionTokens: number;
  prefillTps: number;
  prefillTokens: number;
  totalMs: number;
  error: string | null;
  /** Exact prompt used for this stream (debug). */
  prompt?: string | null;
  /** Compact HTTP/SSE trace (no full completion body). */
  http?: {
    url: string | null;
    status: number | null;
    headers: Record<string, string>;
    completionId: string | null;
    finishReason: string | null;
    sseEventCount: number;
    firstSseDataPreview: string | null;
    request: {
      model: string | null;
      maxTokens: number | null;
      temperature: number;
      stream: boolean;
      promptChars: number;
    };
  };
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  contentPreview?: {
    first: string;
    last: string;
    chars: number;
  } | null;
  decodeMs?: number | null;
}

/** One concurrency wave (all streams at that concurrency). */
export interface DecodeBenchLevelResult {
  concurrency: number;
  streamsOk: number;
  streamsFailed: number;
  /** Mean per-stream decode tok/s after first token */
  meanDecodeTps: number;
  medianDecodeTps: number;
  minDecodeTps: number;
  maxDecodeTps: number;
  meanTtftMs: number;
  medianTtftMs: number;
  /** Client: total post-first-token tokens / concurrent decode window */
  aggregateDecodeTps: number;
  meanPrefillTps: number;
  medianPrefillTps: number;
  /** Sum prompt tokens / concurrent TTFT window (min start → max first token) */
  aggregatePrefillTps: number;
  totalPrefillTokens: number;
  totalDecodeTokens: number;
  totalCompletionTokens: number;
  durationMs: number;
  error: string | null;
  streams: DecodeBenchStreamResult[];
  model: string | null;
  /** ~1 Hz GPU/VRAM/power samples during the wave (debug). */
  hardwareSamples?: Array<{
    t: number;
    gpuUsage: number | null;
    temperature: number | null;
    powerDraw: number | null;
    powerLimit?: number | null;
    vramUsed: number | null;
    vramTotal: number | null;
    vramAvailable?: number | null;
    memAvailable?: number | null;
  }>;
}

export interface DecodeBenchProgress {
  currentConcurrency: number | null;
  completedLevels: number;
  totalLevels: number;
  message: string;
}

export interface DecodeBenchJob {
  benchId: string;
  sparkId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt: number | null;
  config: DecodeBenchConfig & { debug?: boolean };
  progress: DecodeBenchProgress;
  results: DecodeBenchLevelResult[];
  error: string | null;
  durationMs: number;
}

export interface DecodeBenchDefaults {
  allowedConcurrencies: number[];
  defaultMaxTokens: number;
  minMaxTokens: number;
  maxMaxTokens: number;
  promptTypes: DecodeBenchPromptType[];
  defaultPromptType: DecodeBenchPromptType;
}

export interface DecodeBenchListResponse {
  active: DecodeBenchJob | null;
  /** Most recent finished job (optionally for a given port) */
  last: DecodeBenchJob | null;
  history: DecodeBenchJob[];
  defaults: DecodeBenchDefaults;
}

export interface StartDecodeBenchRequest {
  port?: number;
  concurrencies: number[];
  maxTokens?: number;
  modelId?: string | null;
  /** Output type: structured (default), prose, code, json. Prompt only. */
  promptType?: DecodeBenchPromptType;
  /** On-demand remote LLM host (hostname or URL). Skips this Spark's LAN/SSH path. */
  host?: string;
  tls?: boolean;
}

// ─── LLM prefill benchmark ───────────────────────────────
export interface PrefillBenchConfig {
  port: number;
  modelId: string | null;
  contextSizes: number[];
  host?: string;
  tls?: boolean;
  /** Control-plane recipe this run belongs to (server-derived or explicit). */
  recipeId?: string | null;
}

export interface PrefillBenchSizeResult {
  targetTokens: number;
  promptTokens: number;
  promptChars: number;
  prefillTps: number;
  ttftMs: number;
  ttftContentMs: number | null;
  completionTokens: number;
  durationMs: number;
  model: string | null;
  error: string | null;
}

export interface PrefillBenchProgress {
  currentContext: number | null;
  completedLevels: number;
  totalLevels: number;
  message: string;
}

export interface PrefillBenchJob {
  benchId: string;
  sparkId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt: number | null;
  config: PrefillBenchConfig;
  progress: PrefillBenchProgress;
  results: PrefillBenchSizeResult[];
  error: string | null;
  durationMs: number;
}

export interface PrefillBenchDefaults {
  allowedContextSizes: number[];
  defaultContextSizes: number[];
  minContextSize?: number;
  maxContextSize?: number;
}

export interface PrefillBenchListResponse {
  active: PrefillBenchJob | null;
  last: PrefillBenchJob | null;
  history: PrefillBenchJob[];
  defaults: PrefillBenchDefaults;
}

export interface StartPrefillBenchRequest {
  port?: number;
  contextSizes: number[];
  modelId?: string | null;
  host?: string;
  tls?: boolean;
}

// ─── LLM Prompt Showcase ─────────────────────────────────
export type ShowcasePromptType = "structural" | "text" | "mixed";

export interface ShowcaseStartRequest {
  port: number;
  modelId?: string | null;
  maxTokens?: number;
  /** Sampling temperature (0–2). Defaults to 0.7 on the server. */
  temperature?: number;
  /** When true, enable model thinking/reasoning flags (UI defaults to off). */
  thinking?: boolean;
  /** Catalog mode used to seed prompts (structural / text / mixed). */
  promptType?: ShowcasePromptType | null;
  prompts: string[];
}

export interface ShowcaseStreamState {
  streamId: string;
  label: string;
  prompt: string;
  status: "pending" | "streaming" | "completed" | "error" | "cancelled";
  contentAppend?: string;
  content?: string;
  contentLength: number;
  reasoningAppend?: string;
  reasoning?: string;
  reasoningLength?: number;
  resetContent?: boolean;
  tokenCount: number;
  ttftMs: number | null;
  decodeTps: number;
  liveTokPerSec: number;
  peakTokPerSec?: number;
  model: string | null;
  error: string | null;
}

export interface ShowcaseSessionState {
  sessionId: string;
  sparkId: string;
  status: "running" | "completed" | "cancelled" | "error";
  rev: number;
  port: number;
  modelId?: string | null;
  maxTokens?: number | null;
  temperature?: number;
  thinking?: boolean;
  promptType?: ShowcasePromptType | null;
  startedAt?: number;
  completedAt?: number | null;
  /** Median server generation tok/s from /metrics during the run (null if unavailable). */
  serverGenerationTps?: number | null;
  serverGenerationTpsMax?: number | null;
  serverGenerationSamples?: number;
  totalTokens?: number;
  meanDecodeTps?: number;
  peakStreamTps?: number;
  streamCount?: number;
  streams: ShowcaseStreamState[];
  error?: string | null;
  /** True when loaded from disk history (not a live poll session). */
  fromHistory?: boolean;
}

/** List-row for finished showcase runs (no stream bodies). */
export interface ShowcaseHistorySummary {
  sessionId: string;
  sparkId: string;
  status: "completed" | "cancelled" | "error" | string;
  port: number;
  modelId?: string | null;
  maxTokens?: number | null;
  temperature?: number;
  thinking?: boolean;
  promptType?: ShowcasePromptType | null;
  startedAt?: number | null;
  completedAt?: number | null;
  serverGenerationTps?: number | null;
  serverGenerationTpsMax?: number | null;
  totalTokens: number;
  meanDecodeTps: number;
  peakStreamTps: number;
  streamCount: number;
  error?: string | null;
}

export interface ShowcaseListResponse {
  active: { sessionId: string; status: string } | null;
  history: ShowcaseHistorySummary[];
}

export interface ShowcaseStartResponse {
  sessionId: string;
  status: "running";
}
// ─── Control plane: Model Registry / Recipes / Deployments ──
export type DeploymentState =
  | "available"
  | "starting"
  | "loading"
  | "running"
  | "stopping"
  | "stopped"
  | "error";

/**
 * Desired intent (operator/SparkDash) — separate from observed reality.
 * Externally-managed recipes have no SparkDash intent, so they stay `unknown`.
 */
export type DeploymentDesired = "running" | "stopped" | "unknown";

/**
 * Observed probe classification. `auth-gated` (HTTP 401/403) PROVES the process
 * is up and serving and must never read as stopped.
 */
export type DeploymentObserved = "running" | "auth-gated" | "unhealthy" | "not-detected";

/** OPTIONAL explicit deployment role set by the owner in config. */
export type DeploymentRole = "primary" | "worker" | "specialist" | "reviewer" | "experimental" | "none";
/** Legacy role spelling still accepted from older records (folds onto `worker`). */
export type LegacyDeploymentRole = "edge";

/**
 * Derived display state — fixed vocabulary (DESIGN_BRIEF global rule 10).
 * Transitional lifecycle slugs pass through while a dry-run op is in flight.
 */
export type DeploymentDisplay =
  | "running"
  | "running-external"
  | "expected-not-detected"
  | "degraded"
  | "stopped"
  | "starting"
  | "loading"
  | "stopping"
  | "available";

/** Runtime id — config-first: any provider runtime is valid, not an enum. */
export type RecipeRuntime = string;
/** Legacy topology slug (`single` | `tp8` | `dp4` | `pp5` | …) from the server. */
export type RecipeTopology = `${TopologyMode}${number}` | "single" | (string & {});
/** v2 structured topology mode (recipe.topology.mode). */
export type TopologyMode = "single" | "tp" | "pp" | "dp" | "ep";
/** Recipe lifecycle badge — flows through the API for read-only rendering. */
export type RecipeLifecycleState = "draft" | "validated" | "proven" | "deprecated" | "archived";

/** v2 structured recipe blocks (all optional for fixture tolerance). */
export interface RecipeEngine {
  runtime: RecipeRuntime;
  quantization?: string | null;
  apiProtocol?: "openai" | "custom";
}
export interface RecipeServing {
  contextLength?: number | null;
  maxParallel?: number | null;
  flags?: { name: string; value?: string | null }[];
}
export interface RecipeLaunch {
  mechanism?: "command" | "systemd" | "docker" | "external";
  executable?: string | null;
  args?: string[];
  command?: string | null;
  workdir?: string | null;
  affinity?: string | null;
  env?: RecipeEnvPublic[];
}
export interface RecipeEndpoint {
  scheme?: "http" | "https";
  hostTemplate?: string;
  port?: number;
  path?: string;
}
export interface RecipeTopologyBlock {
  mode?: TopologyMode;
  parallelism?: number;
  /** Explicit parallelism degrees — null when NOT configured (never inferred from node count). */
  tp?: number | null;
  pp?: number | null;
  dp?: number | null;
  ep?: number | null;
  /** Optional coordinator node id and worker count hints. */
  coordinator?: string | null;
  workers?: number | null;
  minNodes?: number;
  maxNodes?: number;
  nodeConstraints?: Record<string, unknown>;
  /** true when >1 node but no degree configured — render "topology unknown". */
  unknown?: boolean;
}
export interface RecipeHealthProbe {
  kind?: "http" | "tcp" | "process";
  path?: string;
  expectUp?: number[];
}
export interface RecipeProvenance {
  validatedAt?: number;
  provenAt?: number;
  note?: string;
  sourceRecipeId?: string;
}

export interface ModelEntry {
  id: string;
  name: string;
  family: string | null;
  /** Weights identity lives here: variantId -> absolute path. */
  weightPaths?: Record<string, string>;
  tags?: string[];
  notes: string;
  archived: boolean;
  archivedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Where SHOULD this recipe run — first-class deployment binding. */
export interface DeploymentBinding {
  id: string;
  modelId: string;
  recipeId: string;
  nodeIds: string[];
  desiredState: DeploymentDesired;
  metadata: Record<string, unknown>;
  /** OPTIONAL explicit placement role (config data; changeable via PATCH). */
  role?: DeploymentRole | LegacyDeploymentRole | null;
  createdAt: number;
  updatedAt: number;
}

export interface RecipeValidateResponse {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** One runtime type offered by the WS-3 provider registry (chip-picker source). */
export interface RuntimeProviderInfo {
  id: RecipeRuntime;
  label: string;
  launchable: boolean;
  /** Normalized LlmMetrics keys this runtime meaningfully exposes (never fabricated). */
  metrics: string[];
  /**
   * Provider-declared topology capability DATA: strategy → "supported" |
   * "unsupported" | "by-node-count"; an absent strategy means UNKNOWN.
   */
  topology?: Record<string, string>;
}

/** Env entry as returned by the API — secret values are stripped. */
export interface RecipeEnvPublic {
  name: string;
  value?: string;
  secret: boolean;
  /** Stable pointer into the encrypted secrets store (present for secret entries). */
  secretRef?: string | null;
  hasValue?: boolean;
  /** Non-leaking masked hint (prefix…suffix) for secret entries. */
  hint?: string | null;
}

/** Env entry sent on write (secret values included by the client). */
export interface RecipeEnvWrite {
  name: string;
  value: string;
  secret: boolean;
}

export interface RecipePublic {
  id: string;
  schemaVersion?: number;
  modelRef?: { modelId: string; weightId?: string | null };
  name: string;
  engine?: RecipeEngine;
  serving?: RecipeServing;
  launch?: RecipeLaunch;
  endpoint?: RecipeEndpoint;
  /** Legacy flat topology slug (compat); structured block in `topologyBlock`. */
  topology: RecipeTopology;
  topologyBlock?: RecipeTopologyBlock;
  healthProbe?: RecipeHealthProbe;
  discovery?: { strategy: "openai-models" | "process" | "manual" };
  logSource?: { kind: "file" | "docker" | "journal"; path?: string | null };
  lifecycleCommands?: { start?: string | null; stop?: string | null; status?: string | null };
  tags?: string[];
  /** Recipe lifecycle badge — Draft/Validated/Proven/Deprecated/Archived. */
  lifecycleState?: RecipeLifecycleState;
  provenance?: RecipeProvenance;
  /** Legacy flat model id (compat); canonical ref in `modelRef`. */
  modelId: string;
  /** Legacy flat runtime slug (compat); structured block in `engine`. */
  runtime: RecipeRuntime;
  nodeIds: string[];
  modelPath: string;
  workdir: string;
  logDir: string | null;
  apiPort: number;
  healthPath: string;
  contextLength: number | null;
  cpuAffinity: string | null;
  launcher: string | null;
  metadata: Record<string, unknown>;
  notes: string;
  env: RecipeEnvPublic[];
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DeploymentStatus {
  /** Deployment binding id (runtime view is computed PER deployment). */
  deploymentId?: string;
  recipeId: string;
  modelId: string;
  servedModelId?: string | null;
  endpoint?: string | null;
  processEvidence?: boolean | null;
  nodeIds: string[];
  apiPort: number;
  /** OPTIONAL explicit placement role (config-driven). Absent => FE heuristic. */
  role?: DeploymentRole | LegacyDeploymentRole | null;
  managedBy: "external" | "sparkdash";
  dryRun: boolean;
  state: DeploymentState;
  desired: DeploymentDesired;
  observed: DeploymentObserved;
  /** Read-only SSH pgrep corroboration evidence; never process control. */
  discovered: boolean;
  display: DeploymentDisplay;
  lastOp: string | null;
  lastError: string | null;
  startedAt: number | null;
  updatedAt: number;
}

/**
 * One externally-launched serving runtime found by the read-only discovery
 * scan. `alreadyAdopted` is correlation against existing deployments — an
 * uncovered endpoint is what surfaces as a Discovered runtime.
 */
export interface DiscoveredRuntime {
  id: string;
  nodeId: string;
  port: number;
  servedModelIds: string[];
  runtime: RecipeRuntime;
  health: DeploymentObserved;
  /** Read-only pgrep corroboration; never process control. */
  processEvidence: boolean | null;
  endpoint: string;
  detectedAt: number;
  adoptedAt: number | null;
  adoptionMode: "associate" | "create" | null;
  alreadyAdopted: boolean;
  matchedModelId: string | null;
  matchedRecipeId: string | null;
}

export interface DiscoveryResponse {
  discovered: DiscoveredRuntime[];
  readOnly: boolean;
}

/** Adopt a discovered runtime — config-only, never starts/stops the process. */
export interface AdoptDiscoveryRequest {
  mode: "associate" | "create";
  /** mode=associate */
  modelId?: string;
  recipeId?: string;
  /** mode=create */
  modelName?: string;
  recipeDraft?: Record<string, unknown>;
  /** Optional extra nodes to bind. */
  nodeIds?: string[];
}

export interface AdoptDiscoveryResult {
  mode: "associate" | "create";
  ok: boolean;
  dryRun: boolean;
  model: ModelEntry;
  recipe: RecipePublic;
  deployment: DeploymentBinding;
  provenance: Record<string, unknown>;
  note: string;
}

// ─── WS-3b Discovery → Wizard ────────────────────────────────────────────────
/** Where a wizard value came from. `detected`/`probed` are never the operator. */
export type SeedProvenance = "detected" | "probed" | "user" | "unknown";
/** Per-field provenance map keyed by discovered field name. */
export type DiscoveryProvenance = Record<string, SeedProvenance>;

export interface DiscoveryProbeRequest {
  host: string;
  port: number | string;
  scheme?: "http" | "https";
  /** Reference into the secrets store — the value is never echoed. */
  credRef?: string | null;
}

/** Read-only GET /v1/models outcome. `reachable:false` + UNKNOWN degrade freely. */
export interface DiscoveryProbeResult {
  reachable: boolean;
  runtime: RecipeRuntime;
  runtimeConfidence: "high" | "medium" | "low";
  servedModelIds: string[];
  modelId: string | null;
  health: DeploymentObserved;
  contextLength: number | null;
  apiProtocol: "openai" | "native" | "unknown";
  quantization: string | null;
  endpoint: string;
  credAttached: boolean;
  suggestedTemplate: { templateId: string; confidence: "high" | "medium" | "low" };
  provenance: DiscoveryProvenance;
}

export type CapabilityValue = "yes" | "no" | "unknown";

export interface ProbeCapabilitiesRequest {
  host: string;
  port: number | string;
  scheme?: "http" | "https";
  credRef?: string | null;
  modelId?: string | null;
}

/** Opt-in TINY capability probe — never a benchmark. */
export interface ProbeCapabilitiesResult {
  text: CapabilityValue;
  streaming: CapabilityValue;
  vision: CapabilityValue;
  tools: CapabilityValue;
  reasoning: CapabilityValue;
  modelId: string | null;
  provenance: DiscoveryProvenance;
  credAttached: boolean;
}

/**
 * Seed handed to ModelWizard from the discovery form. Discovery = observation,
 * NEVER ownership: an adopted external endpoint stays "external / observed".
 * Every field is overridable and carries provenance.
 */
export interface DiscoveredSeed extends DiscoveryProbeResult {
  host: string;
  port: number;
  scheme: "http" | "https";
  credRef: string | null;
  /** Optional endpoint path when the operator typed a full base URL. */
  endpointPath?: string | null;
  /** Optional opt-in capability result; null when the operator skipped it. */
  capabilities: ProbeCapabilitiesResult | null;
}

// ─── Local weights discovery (discovery-first Add Model path) ───────────────
/** One discovered weight artifact. Provenance is `configured` | `user`. */
export interface WeightsScanMatch {
  path: string;
  name: string;
  dir: string;
  sizeBytes: number | null;
  ext: string | null;
  provenance: "configured" | "user";
}

export interface WeightsScanRequest {
  /** Optional ad-hoc operator-typed dirs; configured dirs are scanned anyway. */
  dirs?: string[];
}

/**
 * Read-only, bounded scan of CONFIGURED weight directories. `configured:false`
 * is an honest state — never a fake empty success. No file is moved or copied.
 */
export interface WeightsScanResult {
  configured: boolean;
  configuredDirs: string[];
  scannedDirs: string[];
  missingDirs: string[];
  matches: WeightsScanMatch[];
  truncated: boolean;
  notes: string[];
  steps: string[];
  readOnly: true;
}

/** Seed handed to ModelWizard from the local-weights path. */
export interface LocalWeightsSeed {
  path: string;
  name: string;
  dir: string;
  provenance: "configured" | "user";
}

// ─── Guided Add Compute (read-only discovery + config-only validation) ───────
/**
 * Compute-local provenance vocabulary. Deliberately richer than SeedProvenance:
 * a compute field can be CONFIGURED (came from an existing registered node),
 * INFERRED (a subnet hint, never claimed as observed) or MANUAL (operator typed).
 * UNKNOWN is first-class — a value is never fabricated.
 */
export type ComputeProvenance = "discovered" | "configured" | "inferred" | "manual" | "unknown";

/** One compute field plus where it came from. */
export interface ComputeField<T = unknown> {
  value: T | null;
  provenance: ComputeProvenance;
}

/** Fields a guided discovery run can carry provenance for. */
export interface ComputeFieldMap {
  hostname: ComputeField<string>;
  device: ComputeField<string>;
  gpuChip: ComputeField<string>;
  gpuDriver: ComputeField<string>;
  gpuMemoryGB: ComputeField<number>;
  cpuModel: ComputeField<string>;
  cpuCores: ComputeField<number>;
  memoryGB: ComputeField<number>;
  arch: ComputeField<string>;
  kernel: ComputeField<string>;
  processes: ComputeField<string[]>;
  interfaces: ComputeField<Array<{ name: string; ip: string }>>;
  fabricIp: ComputeField<string>;
  cx7Ip: ComputeField<string>;
  fabric: ComputeField<string>;
  nodeKind: ComputeField<"spark" | "host">;
}

export interface ComputeDiscoveryRequest {
  /** Hostname or IP the operator supplies — one host, never a sweep. */
  host: string;
  /** Optional runtime port to try GET /v1/models on. */
  port?: number | null;
  sshUser?: string;
  sshAuth?: "key" | "pass";
  /** Reference into the secrets store — the value is never echoed. */
  credRef?: string | null;
  /** Optional already-registered node id to match against. */
  nodeId?: string | null;
}

export interface ComputeEndpointProbe {
  port: number;
  url: string;
  reachable: boolean;
  status: number | null;
  servedModelIds: string[];
  provenance: ComputeProvenance;
}

export interface ComputeDiscoveryResult {
  host: string;
  knownNodeId: string | null;
  hostProvenance: "configured" | "user";
  reachable: boolean;
  sshReachable: boolean | null;
  fields: Partial<ComputeFieldMap>;
  endpoints: ComputeEndpointProbe[];
  notes: string[];
  /** Explainability: what ran and what answered (read-only). */
  steps: string[];
  readOnly: boolean;
}

export type ComputeIssueSeverity = "invalid" | "unverified";

export interface ComputeValidateIssue {
  code: string;
  field: string;
  severity: ComputeIssueSeverity;
  message: string;
}

export interface ComputeValidateResult {
  /** ok = no INVALID issue. UNVERIFIED is not failure. */
  ok: boolean;
  invalidCount: number;
  unverifiedCount: number;
  issues: ComputeValidateIssue[];
}


export interface ActivityEvent {
  seq: number;
  ts: string;
  kind: "node" | "lifecycle" | "bench" | "showcase" | "console" | "alert";
  subject: string | null;
  summary: string;
  attribution: { client?: string; actor?: string } | null;
  meta: Record<string, unknown> | null;
}

export interface AuditEntry {
  ts: string;
  actor: string;
  node: string;
  recipe: string;
  action: string;
  result: string;
  dryRun: boolean;
}

/** One parsed inference request row for the Live Console telemetry view. */
export interface ConsoleTelemetryRow {
  reqId: number;
  ts: string | null;
  state: "inflight" | "done";
  promptTokens: number | null;
  generatedTokens: number | null;
  cachedPct: number | null;
  newPromptTokens: number | null;
  prefillTps: number | null;
  ttftSeconds: number | null;
  decodeTps: number | null;
  totalSeconds: number | null;
  draftAccepted: number | null;
  draftAttempted: number | null;
  draftPct: number | null;
  toolCalls: number;
  temperature: number | null;
}

export interface ConsoleLine {
  ts: string | null;
  level: string;
  msg: string;
  raw: string;
}

export interface ConsoleInitMessage {
  type: "console:init";
  recipeId: string;
  ok: boolean;
  reason: string | null;
  status: { streaming: boolean; error: string | null; bufferedLines: number; startedAt: number | null };
  buffered: ConsoleLine[];
  telemetry: ConsoleTelemetryRow[];
}

export interface ConsoleDataMessage {
  type: "console";
  recipeId: string;
  lines: ConsoleLine[];
  telemetry: ConsoleTelemetryRow[];
}

export interface LifecycleMessage {
  type: "lifecycle";
  state: DeploymentStatus;
}
