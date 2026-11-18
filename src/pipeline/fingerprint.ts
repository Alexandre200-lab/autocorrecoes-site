import { createHash } from "node:crypto";
import type { RawSignal } from "../shared/types.js";

/** Fingerprint estável de um sinal, usado para baselines de achados conhecidos. */
export function fingerprint(signal: RawSignal): string {
  const evidence = signal.evidence
    .replace(/\s+/g, " ")
    .replace(/\d+/g, "#") // números (tempos, portas) não devem mudar o fingerprint
    .trim()
    .toLowerCase()
    .slice(0, 300);
  const key = [
    signal.domain,
    signal.ruleId,
    signal.path ?? signal.url ?? "",
    signal.selector ?? "",
    String(signal.line ?? ""),
    evidence,
  ].join("|");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function splitByBaseline(
  signals: RawSignal[],
  known: string[],
): { kept: RawSignal[]; suppressed: RawSignal[] } {
  const set = new Set(known);
  const kept: RawSignal[] = [];
  const suppressed: RawSignal[] = [];
  for (const signal of signals) {
    if (set.has(fingerprint(signal))) suppressed.push(signal);
    else kept.push(signal);
  }
  return { kept, suppressed };
}
