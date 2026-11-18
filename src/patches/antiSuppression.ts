/**
 * Detecta "correções" que apenas escondem o sintoma — fraude comum de agentes de IA.
 * Combina regras léxicas com análise semântica (CSS via PostCSS, JS/TS via Babel AST).
 */

import { detectSuppressionAst } from "../security/suppressionAst.js";
const SUPPRESSION_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\baria-hidden\b/i, reason: "aria-hidden esconde o elemento de tecnologias assistivas" },
  { re: /\bdisplay\s*:\s*none\b/i, reason: "display:none esconde o elemento" },
  { re: /\bvisibility\s*:\s*hidden\b/i, reason: "visibility:hidden esconde o elemento" },
  { re: /\bvisibility\s*:\s*collapse\b/i, reason: "visibility:collapse esconde o elemento" },
  { re: /\bopacity\s*:\s*0(?:\.0+)?(?![\d.])/i, reason: "opacity:0 esconde o elemento visualmente" },
  { re: /\bpointer-events\s*:\s*none\b/i, reason: "pointer-events:none desativa a interação" },
  { re: /\binert\b/i, reason: "inert remove o elemento da árvore de acessibilidade" },
  { re: /\bdisableRules\b/i, reason: "disableRules desliga a regra do axe" },
  { re: /\beslint-disable\b/i, reason: "eslint-disable suprime o lint" },
  { re: /\b@ts-(ignore|nocheck|expect-error)\b/i, reason: "diretiva TypeScript suprime a checagem" },
  { re: /\bcontinue-on-error\s*:/i, reason: "continue-on-error desliga o gate de CI" },
  { re: /\bskipTests\s*=|\bxit\s*\(|\bxdescribe\s*\(/i, reason: "teste desligado no lugar da correção" },
  { re: /\bprocess\.exit\s*\(\s*0\s*\)/, reason: "process.exit(0) força sucesso" },
  { re: /rerun\s+on\s*:/i, reason: "mudança de política de CI suspeita" },
];

export function isSuppression(text: string, format?: string): string[] {
  const reasons: string[] = [];
  for (const { re, reason } of SUPPRESSION_PATTERNS) {
    if (re.test(text)) reasons.push(reason);
  }
  reasons.push(...detectSuppressionAst(text, format));
  return [...new Set(reasons)];
}

export function assertNoSuppression(text: string, format?: string): void {
  const reasons = isSuppression(text, format);
  if (reasons.length > 0) {
    throw new Error(`Patch supressivo rejeitado: ${reasons.join("; ")}`);
  }
}
