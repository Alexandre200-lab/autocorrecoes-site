import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { allowedAuditRoots, config } from "../config/index.js";

/** Diretórios que nunca devem ser usados como raiz de auditoria/escrita. */
const DENIED_ROOTS = [
  "/",
  "/etc",
  "/usr",
  "/var",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
  "/root",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/opt",
];

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

function resolveReal(path: string): string {
  const abs = isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path);
  if (!existsSync(abs)) return abs;
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/**
 * Valida um alvo local antes de enfileirar uma auditoria ou gravar baseline.
 * Bloqueia diretórios de sistema e, quando configurado, exige que o alvo esteja
 * dentro de AUDIT_ALLOWED_ROOTS.
 */
export function assertSafeAuditRoot(target: string, cfg = config): string {
  const abs = resolveReal(target);
  for (const denied of DENIED_ROOTS) {
    if (within(denied, abs)) {
      throw new Error(`Diretório de sistema não pode ser alvo de auditoria: ${abs}`);
    }
  }
  const allowed = allowedAuditRoots(cfg).map(resolveReal);
  if (allowed.length > 0 && !allowed.some((root) => within(root, abs))) {
    throw new Error(`Alvo fora das raízes permitidas (AUDIT_ALLOWED_ROOTS): ${abs}`);
  }
  return abs;
}
