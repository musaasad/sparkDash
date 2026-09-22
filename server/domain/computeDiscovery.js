/**
 * ComputeDiscoveryService — BOUNDED, READ-ONLY, EXPLAINABLE compute discovery.
 *
 * Given ONE operator-supplied host (name/IP) plus optional SSH cred ref, gather
 * only what is actually observable, and mark everything else UNKNOWN. It reuses
 * EXISTING safe mechanisms and introduces NO invasive LAN/port scanning:
 *
 *   1. The SSH collector's already-safe read-only facts, on ONE host, one
 *      bounded command (hostname / GPU / memory / cores / arch / read-only
 *      `pgrep` for runtime processes / `ip -o addr` for interfaces).
 *   2. `GET /v1/models` on KNOWN runtime ports only — the operator's port and,
 *      for an already-registered node, that node's configured llmPorts.
 *   3. Known configured nodes from the SparkRegistry (identity match only).
 *
 * SAFETY (non-negotiable):
 *  - No writes, no process control, no signalling, no restarts. The remote is
 *    NEVER mutated to discover or validate.
 *  - Bounded: at most one SSH exec and ≤ MAX_PORTS HTTP GETs, short timeouts.
 *  - Degrades gracefully: unreachable → reachable:false, every field UNKNOWN.
 *  - Explainable: every run returns `steps` describing what ran and what
 *    answered, so the UI can show WHY a field is unknown.
 *  - Provenance on every field: discovered | configured | inferred | unknown.
 *    A value is never fabricated from node count or topology.
 */
import { llmProbeHost } from "../collectors/llmHost.js";
import { probeUrl, probeEndpoint } from "../deployments/deploymentStatus.js";
import { loadSecrets, loadRecipeEnv } from "../secretsStore.js";
import { isValidSparkId } from "../validate.js";

/** Hard bounds — deliberately small, never a sweep. */
const SSH_TIMEOUT_MS = 8000;
const PORT_TIMEOUT_MS = 2500;
const MAX_PORTS = 4;
const MAX_PROCESSES = 12;
const MAX_INTERFACES = 12;

/**
 * One bounded reader over the *read-only* SSH facts. `;` + `---` delimiters keep
 * sections separable on a single transport; every command is read-only.
 */
export const READONLY_FACTS_CMD = [
  "hostname 2>/dev/null",
  "echo '---'",
  "nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader,nounits 2>/dev/null",
  "echo '---'",
  "grep -E '^model name' /proc/cpuinfo | head -1",
  "echo '---'",
  "grep -cE '^processor' /proc/cpuinfo 2>/dev/null",
  "echo '---'",
  "grep -E '^MemTotal' /proc/meminfo 2>/dev/null",
  "echo '---'",
  "uname -m 2>/dev/null",
  "echo '---'",
  "uname -sr 2>/dev/null",
  "echo '---'",
  `pgrep -a -f 'vllm|llama|sglang|tabby|llama-server|comfy' 2>/dev/null | head -${MAX_PROCESSES}`,
  "echo '---'",
  `ip -o -4 addr show 2>/dev/null | head -${MAX_INTERFACES}`,
].join("; ");

const slug = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "compute";

/** Wrap a value with an explicit provenance, so UNKNOWN stays first-class. */
const field = (value, provenance) => ({ value: value ?? null, provenance: value == null ? "unknown" : provenance });
const discovered = (value) => field(value, "discovered");
const configured = (value) => field(value, "configured");
const unknownField = () => ({ value: null, provenance: "unknown" });

/** Resolve `credRef` to a plaintext value ONLY here; the value is never echoed. */
function defaultCredResolver(ref) {
  const s = String(ref || "").trim();
  if (!s) return null;
  if (s.startsWith("spark:")) {
    const [, id, port] = s.split(":");
    if (!id) return null;
    try {
      const secrets = loadSecrets();
      if (port) return secrets.llmApiKeys.get(id)?.[String(port)] || null;
      return secrets.passwords.get(id) || null;
    } catch {
      return null;
    }
  }
  if (s.startsWith("recipe:")) {
    try {
      return loadRecipeEnv().get(s) || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** First three octets of an IPv4 — the /24 segment, for INFERRED fabric hints. */
function subnet(ip) {
  const parts = String(ip || "").trim().split(".");
  return parts.length === 4 ? parts.slice(0, 3).join(".") : null;
}

export class ComputeDiscoveryService {
  /**
   * @param {{
   *   sparkRegistry?: {sparkIds:string[], getSpark:(id:string)=>object|null},
   *   fetchImpl?: typeof fetch,
   *   sshExecFn?: Function,
   *   credResolver?: (ref:string)=>string|null,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.sparkRegistry = opts.sparkRegistry || null;
    this.fetchImpl = opts.fetchImpl || fetch;
    this.sshExecFn = opts.sshExecFn || null;
    this.credResolver = opts.credResolver || defaultCredResolver;
  }

  /** Find an already-registered node matching an id, LAN IP or SSH host. */
  knownNodeFor(host, nodeId) {
    if (!this.sparkRegistry?.sparkIds) return null;
    if (nodeId && isValidSparkId(nodeId)) {
      const byId = this.sparkRegistry.getSpark(nodeId);
      if (byId) return byId;
    }
    const h = String(host || "").trim();
    if (!h) return null;
    for (const id of this.sparkRegistry.sparkIds) {
      const s = this.sparkRegistry.getSpark(id);
      if (s && (s.lanIp === h || s.ssh?.host === h)) return s;
    }
    return null;
  }

  /**
   * Bounded, read-only discovery of ONE host. Never throws on an unreachable
   * host — it reports reachable:false and leaves fields UNKNOWN.
   *
   * @param {{host:string, port?:number|string, sshUser?:string, sshAuth?:"key"|"pass", credRef?:string, nodeId?:string}} input
   */
  async discover({ host, port, sshUser, sshAuth, credRef, nodeId } = {}) {
    const h = String(host || "").trim();
    const steps = [];
    if (!h) {
      const err = new Error("host is required");
      err.status = 400;
      throw err;
    }

    const knownNode = this.knownNodeFor(h, nodeId);
    const result = {
      host: h,
      knownNodeId: knownNode?.id ?? null,
      /** The typed host came from the operator; a known node is config. */
      hostProvenance: knownNode ? "configured" : "user",
      reachable: false,
      sshReachable: null,
      fields: {
        hostname: unknownField(),
        device: unknownField(),
        gpuChip: unknownField(),
        gpuDriver: unknownField(),
        gpuMemoryGB: unknownField(),
        cpuModel: unknownField(),
        cpuCores: unknownField(),
        memoryGB: unknownField(),
        arch: unknownField(),
        kernel: unknownField(),
        processes: unknownField(),
        interfaces: unknownField(),
        fabricIp: unknownField(),
      },
      endpoints: [],
      notes: [],
      steps,
    };

    // Known node → its configured identity/ports are CONFIGURED provenance.
    if (knownNode) {
      result.fields.nodeKind = configured(knownNode.kind === "host" ? "host" : "spark");
      result.fields.hostname = configured(knownNode.name || null);
      result.fields.cx7Ip = configured(knownNode.cx7Ip ?? null);
      result.fields.fabric = configured(knownNode.fabric ?? null);
      steps.push(`matched known configured node ${knownNode.id} (identity from config, read-only)`);
    }

    // ── 1) SSH read-only facts (only when the operator gave an SSH reason) ──
    const wantSsh = Boolean(this.sshExecFn) && !(knownNode?.isLocal && !sshUser);
    // A `spark:<id>:<port>` ref is an LLM API key; a bare `spark:<id>` is the
    // SSH password. recipe:<id>:<NAME> stays endpoint-only. Value never echoed.
    const refHasPort = String(credRef || "").split(":").length >= 3;
    const resolveCred = () => {
      if (!credRef) return null;
      try {
        return this.credResolver(credRef);
      } catch {
        return null;
      }
    };
    const sshCred = sshAuth === "pass" && !refHasPort ? resolveCred() : null;
    const endpointCred = refHasPort ? resolveCred() : null;

    if (wantSsh) {
      const sshSpark = knownNode
        ? knownNode
        : {
            id: slug(h),
            name: slug(h),
            lanIp: h,
            ssh: {
              host: h,
              user: sshUser || "root",
              auth: sshAuth === "pass" ? "pass" : "key",
              ...(sshCred ? { password: sshCred } : {}),
            },
          };
      steps.push(`ssh read-only facts against ${sshSpark.ssh?.user || sshUser || "root"}@${sshSpark.ssh?.host || sshSpark.lanIp || h}`);
      try {
        const out = await this.sshExecFn(sshSpark, READONLY_FACTS_CMD, { timeoutMs: SSH_TIMEOUT_MS });
        const parts = String(out ?? "").split("---");
        result.sshReachable = true;
        result.reachable = true;

        const hostname = parts[0]?.trim() || null;
        if (hostname) result.fields.hostname = discovered(hostname);

        const smiLine = (parts[1] || "").split("\n").find((l) => l.trim()) || "";
        const smi = smiLine.split(",").map((s) => s.trim());
        if (smi[0]) result.fields.gpuChip = discovered(smi[0]);
        if (smi[1]) result.fields.gpuDriver = discovered(smi[1]);
        if (smi[2]) {
          const mb = Number(smi[2]);
          result.fields.gpuMemoryGB = discovered(Number.isFinite(mb) && mb > 0 ? Math.round(mb / 1024) : null);
        }
        if (!smiLine) steps.push("nvidia-smi answered nothing — GPU UNKNOWN");

        const cpuModel = (parts[2]?.trim() || "").split("\n").find(Boolean) || null;
        if (cpuModel) result.fields.cpuModel = discovered(cpuModel.replace(/^model name\s*:\s*/i, "").trim());

        const cores = parseInt(parts[3]?.trim() || "", 10);
        if (Number.isInteger(cores) && cores > 0) result.fields.cpuCores = discovered(cores);

        const mem = String(parts[4] || "").match(/MemTotal:\s+(\d+)\s+kB/);
        if (mem) result.fields.memoryGB = discovered(Math.max(1, Math.round(parseInt(mem[1], 10) / 1024 / 1024)));

        const arch = parts[5]?.trim() || null;
        if (arch) result.fields.arch = discovered(arch);
        const kernel = parts[6]?.trim() || null;
        if (kernel) result.fields.kernel = discovered(kernel);

        const procs = (parts[7] || "")
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, MAX_PROCESSES);
        if (procs.length) result.fields.processes = discovered(procs);

        const ifaces = (parts[8] || "")
          .split("\n")
          .map((l) => {
            const m = l.match(/\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)/);
            return m ? { name: m[1], ip: m[2] } : null;
          })
          .filter(Boolean)
          .slice(0, MAX_INTERFACES);
        if (ifaces.length) result.fields.interfaces = discovered(ifaces);
      } catch (err) {
        result.sshReachable = false;
        result.notes.push(`ssh facts skipped: ${err.message}`);
        steps.push("ssh read-only facts did not answer — fields stay UNKNOWN");
      }
    } else {
      steps.push("no ssh path (local or no collector) — remote fields stay UNKNOWN");
    }

    // ── 2) INFERRED fabric hint from a discovered interface sharing a peer subnet ──
    const selfSubnets = new Set((result.fields.interfaces.value || []).map((i) => subnet(i.ip)).filter(Boolean));
    if (selfSubnets.size && this.sparkRegistry?.sparkIds) {
      for (const id of this.sparkRegistry.sparkIds) {
        const peer = this.sparkRegistry.getSpark(id);
        if (!peer || peer.id === result.knownNodeId) continue;
        const ps = subnet(peer.cx7Ip);
        if (ps && selfSubnets.has(ps)) {
          result.fields.fabricIp = {
            value: peer.cx7Ip ? `${ps}.0/24` : null,
            provenance: "inferred",
          };
          steps.push(`interface subnet overlaps peer ${peer.id} cx7 /24 — fabric INFERRED, not claimed`);
          break;
        }
      }
    }

    // ── 3) Known runtime endpoints: GET /v1/models only, bounded ports ──
    const ports = new Set();
    const typed = Number(port);
    if (Number.isInteger(typed) && typed >= 1 && typed <= 65535) ports.add(typed);
    for (const p of knownNode?.llmPorts || []) ports.add(Number(p));
    const boundedPorts = [...ports].filter((p) => Number.isInteger(p) && p > 0 && p < 65536).slice(0, MAX_PORTS);

    const probeHost = knownNode ? llmProbeHost(knownNode) : h;
    for (const p of boundedPorts) {
      const url = probeUrl(probeHost, p, "/v1/models");
      const outcome = await probeEndpoint(url, {
        fetchImpl: this.fetchImpl,
        timeoutMs: PORT_TIMEOUT_MS,
        headers: endpointCred ? { Authorization: `Bearer ${endpointCred}` } : null,
        parseBody: true,
      });
      const ep = {
        port: p,
        url,
        reachable: outcome.status != null,
        status: outcome.status,
        servedModelIds: [],
        provenance: outcome.status != null ? "discovered" : "unknown",
      };
      if (outcome.body) {
        const data = Array.isArray(outcome.body?.data) ? outcome.body.data : Array.isArray(outcome.body) ? outcome.body : [];
        ep.servedModelIds = data.map((m) => m?.id).filter((id) => typeof id === "string").slice(0, 8);
      }
      result.endpoints.push(ep);
      if (outcome.status != null) {
        result.reachable = true;
        steps.push(`GET /v1/models on port ${p} answered ${outcome.status}`);
      } else {
        steps.push(`GET /v1/models on port ${p} did not answer`);
      }
    }

    steps.push("read-only: nothing started, stopped, signalled or reconfigured");
    return result;
  }
}
