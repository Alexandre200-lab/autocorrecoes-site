/**
 * Redator de segredos aplicado ANTES de qualquer conteúdo do alvo sair do processo.
 * Defesa em profundidade: auditores redatam o contexto e o cliente redatam o prompt.
 */

const NAMED_SECRET = /((?:api[_-]?key|secret|password|passwd|token|authorization|private[_-]?key|access[_-]?key)\s*[:=]\s*)(["'`])([^"'`\n]{4,})\2/gi;
const BARE_ENV_SECRET = /\b(API_KEY|SECRET|TOKEN|PASSWORD|ACCESS_KEY|PRIVATE_KEY)=([^\s"'`]+)/gi;
const SK_KEY = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const AWS_KEY = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const URL_CREDENTIALS = /(:\/\/)[^/\s:@]+:[^/\s@]+@/g;

export interface RedactionResult {
  text: string;
  count: number;
}

export function redactWithStats(input: string): RedactionResult {
  let text = String(input ?? "");
  let count = 0;

  const apply = (re: RegExp, fn: (...args: any[]) => string): void => {
    text = text.replace(re, (...args: any[]) => {
      count += 1;
      return fn(...args);
    });
  };

  apply(PEM, () => "[REDACTED_PRIVATE_KEY]");
  apply(NAMED_SECRET, (_match: string, prefix: string, quote: string) => `${prefix}${quote}[REDACTED]${quote}`);
  apply(BARE_ENV_SECRET, (_match: string, name: string) => `${name}=[REDACTED]`);
  apply(SK_KEY, () => "[REDACTED_KEY]");
  apply(AWS_KEY, () => "[REDACTED_AWS_KEY]");
  apply(URL_CREDENTIALS, (_match: string, scheme: string) => `${scheme}[REDACTED]@`);

  return { text, count };
}

export function redactSecrets(input: string): string {
  return redactWithStats(input).text;
}
