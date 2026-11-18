import type { RawSignal } from "../shared/types.js";

/**
 * Remove duplicatas por CAUSA (regra + local), preservando a evidência mais rica.
 * Sinais que exigem julgamento humano nunca são mesclados com achados automáticos.
 */
export function dedupeSignals(signals: RawSignal[]): RawSignal[] {
  const byKey = new Map<string, RawSignal>();
  for (const signal of signals) {
    const location = [signal.path ?? signal.url ?? "", signal.selector ?? "", String(signal.line ?? "")]
      .filter(Boolean)
      .join("|");
    const key = signal.metadata?.requiresHuman
      ? `human:${signal.ruleId}:${location}:${Math.random()}`
      : `${signal.domain}:${signal.ruleId}:${location}`;

    const existing = byKey.get(key);
    if (!existing || signal.evidence.length > existing.evidence.length) {
      byKey.set(key, signal);
    }
  }
  return [...byKey.values()];
}
