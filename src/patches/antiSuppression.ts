/**
 * Detecta "correções" que apenas escondem o sintoma — fraude comum de agentes de IA.
 * Um patch que aciona uma destas regras é rejeitado antes de chegar ao humano.
 */
const SUPPRESSION_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\baria-hidden\b/i, reason: "aria-hidden esconde o elemento de tecnologias assistivas" },
  { re: /\bdisplay\s*:\s*none\b/i, reason: "display:none esconde o elemento" },
  { re: /\bvisibility\s*:\s*hidden\b/i, reason: "visibility:hidden esconde o elemento" },
  { re: /\bdisableRules\b/i, reason: "disableRules desliga a regra do axe" },
  { re: /\beslint-disable\b/i, reason: "eslint-disable suprime o lint" },
  { re: /\b@ts-(ignore|nocheck|expect-error)\b/i, reason: "diretiva TypeScript suprime a checagem" },
  { re: /\bcontinue-on-error\s*:/i, reason: "continue-on-error desliga o gate de CI" },
  { re: /\bskipTests\s*=|\bxit\s*\(|\bxdescribe\s*\(/i, reason: "teste desligado no lugar da correção" },
  { re: /\bprocess\.exit\s*\(\s*0\s*\)/, reason: "process.exit(0) força sucesso" },
  { re: /rerun\s+on\s*:/i, reason: "mudança de política de CI suspeita" },
];

export function isSuppression(text: string): string[] {
  const reasons: string[] = [];
  for (const { re, reason } of SUPPRESSION_PATTERNS) {
    if (re.test(text)) reasons.push(reason);
  }
  return reasons;
}

export function assertNoSuppression(text: string): void {
  const reasons = isSuppression(text);
  if (reasons.length > 0) {
    throw new Error(`Patch supressivo rejeitado: ${reasons.join("; ")}`);
  }
}
