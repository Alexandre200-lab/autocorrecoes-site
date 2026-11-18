import type { Severity } from "../shared/types.js";

/** Contadores em processo. Para múltiplas instâncias, exportar via OTLP (span.js). */
export interface MetricsSnapshot {
  auditsTotal: number;
  auditFailures: number;
  auditDurationP95Ms: number;
  findingsBySeverity: Record<Severity, number>;
  aiCalls: number;
  aiPromptTokens: number;
  aiCompletionTokens: number;
  aiCostUsd: number;
  applySuccess: number;
  applyFailure: number;
}

const findingsBySeverity: Record<Severity, number> = { P1: 0, P2: 0, P3: 0, P4: 0 };
const durations: number[] = [];

export const metrics = {
  auditsTotal: 0,
  auditFailures: 0,
  aiCalls: 0,
  aiPromptTokens: 0,
  aiCompletionTokens: 0,
  aiCostUsd: 0,
  applySuccess: 0,
  applyFailure: 0,
};

export function recordAudit(durationMs: number, failed: boolean): void {
  metrics.auditsTotal += 1;
  if (failed) metrics.auditFailures += 1;
  durations.push(durationMs);
  if (durations.length > 500) durations.shift();
}

export function recordFinding(severity: Severity): void {
  findingsBySeverity[severity] += 1;
}

export function recordAi(tokens: { prompt: number; completion: number }, costUsd: number): void {
  metrics.aiCalls += 1;
  metrics.aiPromptTokens += tokens.prompt;
  metrics.aiCompletionTokens += tokens.completion;
  metrics.aiCostUsd += costUsd;
}

export function recordApply(success: boolean): void {
  if (success) metrics.applySuccess += 1;
  else metrics.applyFailure += 1;
}

export function snapshot(): MetricsSnapshot {
  const sorted = [...durations].sort((a, b) => a - b);
  const p95 = sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
    : 0;
  return {
    ...metrics,
    auditDurationP95Ms: p95,
    aiCostUsd: Number(metrics.aiCostUsd.toFixed(6)),
    findingsBySeverity: { ...findingsBySeverity },
  };
}
