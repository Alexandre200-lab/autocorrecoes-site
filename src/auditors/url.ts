import { resolve } from "node:path";

/** Normaliza uma URL informada pelo usuário (aceita exemplo.com e https://exemplo.com). */
export function normalizeTargetUrl(target: string): string {
  const value = /^https?:\/\//i.test(target) ? target : `https://${target}`;
  return new URL(value).toString();
}

/** Resolve um alvo local a um diretório absoluto. */
export function resolveLocalTarget(target: string): string {
  return resolve(process.cwd(), target);
}
