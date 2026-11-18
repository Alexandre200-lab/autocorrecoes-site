import type { AuditOptions, Domain, RawSignal } from "../shared/types.js";

export interface AuditContext {
  runId: string;
  traceId: string;
}

export interface AuditResult {
  signals: RawSignal[];
  checksRun: string[];
  checksNotRun: string[];
  /** Contexto determinístico enviado ao DeepSeek junto com os sinais. */
  context: string;
}

export interface Auditor {
  readonly domain: Domain;
  audit(
    target: string,
    options: AuditOptions,
    context: AuditContext,
  ): Promise<AuditResult>;
}

export function mapImpactToSeverity(impact?: string | null): RawSignal["severity"] {
  switch ((impact ?? "").toLowerCase()) {
    case "critical":
      return "P1";
    case "serious":
      return "P2";
    case "moderate":
      return "P3";
    default:
      return "P4";
  }
}
