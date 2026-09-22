/**
 * Operator-readable VALIDATE report. Pure, no writes, no lifecycle.
 *
 * One line per concept, with an HONEST marker:
 *   ✓ valid · ✗ invalid (reason) · ? UNKNOWN / NOT-VERIFIED
 * A "?" is never upgraded to a "✓" just because a value happens to be present —
 * when a thing cannot be verified, it stays UNKNOWN.
 */
import type { TopologyStatus } from "./topologyCapability";

export type ReportStatus = "valid" | "invalid" | "unknown";
export interface ReportLine {
  key: string;
  status: ReportStatus;
  detail: string;
}

export const REPORT_SYMBOL: Record<ReportStatus, string> = { valid: "✓", invalid: "✗", unknown: "?" };

export function reportSymbol(s: ReportStatus): string {
  return REPORT_SYMBOL[s];
}

export interface ValidateReportInput {
  modelName: string;
  modelId: string;
  weightPath: string;
  runtime: string;
  /** True when the runtime declares capability DATA (else unverifiable). */
  runtimeVerifiable: boolean;
  nodeCount: number;
  rangeMin: number;
  rangeMax: number;
  topologyStatus: TopologyStatus;
  topologyReason: string;
  /** Secret env entries and how many lack a name. */
  secretEntries: number;
  secretMissingNames: number;
  role: string | null;
}

const RANGE = (a: number, b: number) => (a === b ? `${a}` : `${a}–${b}`);

/** Build the ordered report. Order is the operator's mental model. */
export function buildValidateReport(input: ValidateReportInput): ReportLine[] {
  const modelOk = Boolean(input.modelName.trim() && input.modelId.trim());
  const nodeOk = input.nodeCount >= input.rangeMin && input.nodeCount <= input.rangeMax;

  return [
    {
      key: "MODEL",
      status: modelOk ? "valid" : "invalid",
      detail: modelOk ? `${input.modelName} (${input.modelId})` : "name and id are required",
    },
    {
      key: "RUNTIME",
      status: input.runtime ? (input.runtimeVerifiable ? "valid" : "unknown") : "invalid",
      detail: input.runtime
        ? input.runtimeVerifiable
          ? `${input.runtime} — declared capability known`
          : `${input.runtime} — capability not declared (NOT-VERIFIED)`
        : "no runtime selected",
    },
    {
      key: "COMPUTE",
      status: nodeOk ? "valid" : "invalid",
      detail: `${input.nodeCount} node(s) placed · bounds ${RANGE(input.rangeMin, input.rangeMax)}`,
    },
    {
      key: input.topologyStatus === "invalid" ? "TOPOLOGY" : "TOPOLOGY",
      status: input.topologyStatus === "valid" ? "valid" : input.topologyStatus === "invalid" ? "invalid" : "unknown",
      detail: input.topologyStatus === "valid" ? input.topologyReason : input.topologyReason,
    },
    {
      key: "WEIGHTS",
      status: input.weightPath.trim() ? "valid" : "unknown",
      detail: input.weightPath.trim() ? input.weightPath : "weight path UNKNOWN (never guessed)",
    },
    {
      key: "SECRETS",
      status: input.secretEntries === 0 ? "valid" : input.secretMissingNames > 0 ? "unknown" : "valid",
      detail:
        input.secretEntries === 0
          ? "no secret env entries"
          : input.secretMissingNames > 0
            ? `${input.secretMissingNames} secret entry(ies) without a NAME — by ref, values never echoed`
            : `${input.secretEntries} secret ref(s) — values never echoed`,
    },
    {
      key: "ROLE",
      status: input.role ? "valid" : "unknown",
      detail: input.role ? `${input.role} · changeable later via PATCH (no recreation)` : "none (default) — not auto-assigned",
    },
    {
      key: "LIFECYCLE",
      status: "valid",
      detail: "CONFIG ONLY · DRY RUN",
    },
  ];
}
