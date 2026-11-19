/**
 * Redator de segredos aplicado ANTES de qualquer conteúdo do alvo sair do processo.
 * Defesa em profundidade: auditores redatam o contexto e o cliente redatam o prompt.
 */

const NAMED_SECRET = /((?:api[_-]?key|secret|password|passwd|token|authorization|private[_-]?key|access[_-]?key)\s*[:=]\s*)(["'`])([^"'`\n]{4,})\2/gi;
/** Valores nomeados sem aspas — ex.: `Authorization: Bearer eyJ...`. */
const NAMED_SECRET_BARE = /\b((?:api[_-]?key|secret|password|passwd|token|authorization|private[_-]?key|access[_-]?key)\s*[:=]\s*)([^\s"'`,\n]{4,})/gi;
const BARE_ENV_SECRET = /\b(API_KEY|SECRET|TOKEN|PASSWORD|ACCESS_KEY|PRIVATE_KEY)=([^\s"'`]+)/gi;
const SK_KEY = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const AWS_KEY = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const URL_CREDENTIALS = /(:\/\/)[^/\s:@]+:[^/\s@]+@/g;
/** JWTs (三段) e tokens Bearer opacos, mesmo sem aspas. */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi;

export interface RedactionResult {
  text: string;
  count: number;
}

export function redactWithStats(input: string): RedactionResult {
  let text = String(input ?? "");
  let count = 0;

  const apply = (re: RegExp, fn: (...args: string[]) => string): void => {
    text = text.replace(re, (...args: unknown[]) => {
      count += 1;
      return fn(...(args as string[]));
    });
  };

  apply(PEM, () => "[REDACTED_PRIVATE_KEY]");
  apply(NAMED_SECRET, (_match, prefix: string, quote: string) => `${prefix}${quote}[REDACTED]${quote}`);
  apply(BEARER, (_match, prefix: string) => `${prefix}[REDACTED]`);
  apply(JWT, () => "[REDACTED_JWT]");
  apply(NAMED_SECRET_BARE, (_match, prefix: string) => `${prefix}[REDACTED]`);
  apply(BARE_ENV_SECRET, (_match, name: string) => `${name}=[REDACTED]`);
  apply(SK_KEY, () => "[REDACTED_KEY]");
  apply(AWS_KEY, () => "[REDACTED_AWS_KEY]");
  apply(URL_CREDENTIALS, (_match, scheme: string) => `${scheme}[REDACTED]@`);

  return { text, count };
}

export function redactSecrets(input: string): string {
  return redactWithStats(input).text;
}
