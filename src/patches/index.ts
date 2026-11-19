import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { config } from "../config/index.js";
import { logger } from "../observability/index.js";
import { recordApply } from "../observability/metrics.js";
import { newId, store } from "../storage/index.js";
import type { Finding, Patch } from "../shared/types.js";
import { assertNoSuppression } from "./antiSuppression.js";
import { applyUnifiedDiff } from "./diff.js";

export function safeResolve(root: string, file: string): string {
  const normalized = file.replace(/\\/g, "/").trim();
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`Caminho inseguro: ${file}`);
  }
  if (normalized.split("/").includes("..")) {
    throw new Error(`Caminho com travessia de diretório: ${file}`);
  }
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, normalized);
  const rootReal = realpathSync(rootAbs);

  // realpath bloqueia symlinks que apontam para fora do repositório.
  let check = abs;
  if (existsSync(abs)) {
    check = realpathSync(abs);
  } else {
    let parent = dirname(abs);
    while (!existsSync(parent) && parent !== dirname(parent)) parent = dirname(parent);
    check = join(realpathSync(parent), relative(parent, abs));
  }
  if (check !== rootReal && !check.startsWith(rootReal + sep)) {
    throw new Error(`Arquivo fora do repositório (symlink): ${file}`);
  }
  return abs;
}

export function validatePatch(patch: Patch, root?: string): void {
  assertNoSuppression(`${patch.content}\n${patch.riskNotes.join("\n")}`, patch.format);
  if (!patch.files.length) throw new Error("Patch sem arquivos de destino.");
  if (root) {
    for (const file of patch.files) safeResolve(root, file);
  }
}

function backupDir(runId: string, findingId: string): string {
  return join(config.dataDir, "backups", runId, findingId);
}

function backupFiles(runId: string, findingId: string, root: string, files: string[]): void {
  for (const file of files) {
    const abs = safeResolve(root, file);
    if (!existsSync(abs)) throw new Error(`Arquivo para backup não existe: ${file}`);
    const dest = join(backupDir(runId, findingId), relative(root, abs));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(abs, dest);
  }
}

export function restoreBackup(runId: string, findingId: string, root: string): string[] {
  const dir = backupDir(runId, findingId);
  if (!existsSync(dir)) return [];
  const restored: string[] = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = join(folder, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const target = safeResolve(root, relative(dir, full));
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(full, target);
        restored.push(relative(root, target));
      }
    }
  };
  walk(dir);
  return restored;
}

function renderContent(patch: Patch, original: string): string {
  switch (patch.format) {
    case "unified-diff":
      return applyUnifiedDiff(original, patch.content);
    case "full-file":
    case "config-change":
      return patch.content;
    case "css-rule":
      return `${original.replace(/\s+$/, "")}\n\n${patch.content}\n`;
    default:
      throw new Error(`Formato de patch desconhecido: ${patch.format as string}`);
  }
}

/**
 * Verifica a promessa de "não alteração" feita pelo Proposer. Se um trecho
 * declarado como preservado existia no original e desapareceu após o patch,
 * a aplicação é abortada e revertida.
 */
export function assertUntouched(
  patch: Patch,
  originals: Map<string, string>,
  updated: Map<string, string>,
): void {
  const before = [...originals.values()].join("\n");
  const after = [...updated.values()].join("\n");
  for (const raw of patch.untouchedAssertion ?? []) {
    const token = raw.trim();
    if (!token || !before.includes(token)) continue;
    if (!after.includes(token)) {
      throw new Error(`Declaração de não-alteração violada: "${token}" desapareceu do patch.`);
    }
  }
}

function localChecks(root: string): { ok: boolean; output: string[] } {
  const output: string[] = [];
  let ok = true;
  if (!existsSync(join(root, ".git"))) {
    output.push("sem repositório git: validação de whitespace ignorada");
  } else {
    try {
      const result = execFileSync("git", ["-C", root, "diff", "--check"], {
        encoding: "utf8",
        timeout: 30_000,
      });
      if (result.trim()) output.push(result.trim());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/not a git repository|fatal:/i.test(message)) {
        ok = false;
        output.push(message);
      }
    }
  }

  let pkg: { scripts?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    // Repositório sem package.json: apenas git diff --check.
  }
  // Segurança: scripts do repositório auditado são código arbitrário. Só são
  // executados com opt-in explícito (AUDIT_ALLOW_NPM_SCRIPTS=true).
  const script = config.AUDIT_ALLOW_NPM_SCRIPTS
    ? pkg.scripts?.typecheck
      ? "typecheck"
      : pkg.scripts?.["check"]
        ? "check"
        : null
    : null;
  if (script) {
    try {
      const result = execFileSync("npm", ["run", script, "--silent"], {
        cwd: root,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      if (result.trim()) output.push(result.trim());
    } catch (error) {
      ok = false;
      output.push(error instanceof Error ? error.message : String(error));
    }
  } else {
    output.push(
      config.AUDIT_ALLOW_NPM_SCRIPTS
        ? "nenhum script typecheck/check disponível"
        : "scripts npm do alvo não executados (AUDIT_ALLOW_NPM_SCRIPTS=false)",
    );
  }
  return { ok, output };
}

function exportArtifact(finding: Finding, patch: Patch): string {
  const dir = join(config.dataDir, "patches", finding.runId);
  mkdirSync(dir, { recursive: true });
  const ext =
    patch.format === "css-rule"
      ? ".css"
      : patch.format === "unified-diff"
        ? ".diff"
        : extname(patch.files[0] ?? "") || ".txt";
  const file = join(dir, `${finding.id}${ext}`);
  const header = [
    `# AutoCorrecoes — artefato proposto (alvo remoto, não aplicado automaticamente)`,
    `# Achado: ${finding.id}`,
    `# URL: ${finding.url ?? "não informada"}`,
    `# Arquivos sugeridos: ${patch.files.join(", ")}`,
    "",
  ].join("\n");
  writeFileSync(file, `${header}\n${patch.content}\n`, "utf8");
  return file;
}

export interface ApplyResult {
  findingId: string;
  applied: boolean;
  message: string;
  checks: string[];
  artifact?: string;
  rolledBack?: boolean;
}

export async function applyFinding(finding: Finding): Promise<ApplyResult> {
  if (!finding.patch) {
    return { findingId: finding.id, applied: false, message: "Achado não possui patch.", checks: [] };
  }
  const patch = finding.patch;
  const run = store.getRun(finding.runId);
  if (!run) {
    return { findingId: finding.id, applied: false, message: "Execução não encontrada.", checks: [] };
  }

  // Alvo remoto: nunca escrevemos em servidor de terceiros. Exportamos o patch.
  if (run.targetType === "url") {
    const artifact = exportArtifact(finding, patch);
    store.transaction(() => {
      store.updateFinding(finding.id, {
        status: "applied",
        patch: { ...patch, exportedArtifact: artifact },
      });
      store.addReceipt({
        id: newId("rcpt"),
        runId: run.id,
        findingId: finding.id,
        kind: "application",
        payload: { mode: "export", artifact, note: "Alvo remoto: patch exportado, não aplicado." },
        createdAt: new Date().toISOString(),
      });
    });
    recordApply(true);
    return {
      findingId: finding.id,
      applied: true,
      message: `Patch exportado para ${artifact} (alvo remoto não foi modificado).`,
      checks: [],
      artifact,
    };
  }

  const root = resolve(run.target);
  try {
    validatePatch(patch, root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.updateFinding(finding.id, { status: "failed", rejectionReason: message });
    recordApply(false);
    return { findingId: finding.id, applied: false, message, checks: [] };
  }

  try {
    backupFiles(run.id, finding.id, root, patch.files);
    const originals = new Map<string, string>();
    const updated = new Map<string, string>();
    for (const file of patch.files) {
      const abs = safeResolve(root, file);
      const original = readFileSync(abs, "utf8");
      const next = renderContent(patch, original);
      originals.set(file, original);
      updated.set(file, next);
      writeFileSync(abs, next, "utf8");
    }
    assertUntouched(patch, originals, updated);
    const checks = localChecks(root);
    if (!checks.ok) {
      const restored = restoreBackup(run.id, finding.id, root);
      store.updateFinding(finding.id, {
        status: "failed",
        rejectionReason: `Checks falharam após aplicação; rollback automático. ${checks.output.join(" | ").slice(0, 1000)}`,
      });
      logger.warn("patch.rollback", { findingId: finding.id, restored });
      recordApply(false);
      return {
        findingId: finding.id,
        applied: false,
        message: "Checks falharam após aplicação. Rollback automático executado.",
        checks: checks.output,
        rolledBack: true,
      };
    }

    store.transaction(() => {
      store.updateFinding(finding.id, { status: "applied" });
      store.addReceipt({
        id: newId("rcpt"),
        runId: run.id,
        findingId: finding.id,
        kind: "application",
        payload: {
          mode: "filesystem",
          files: patch.files,
          backup: relative(config.dataDir, backupDir(run.id, finding.id)),
          checks: checks.output,
          humanDecision: "approved by operator",
        },
        createdAt: new Date().toISOString(),
      });
    });
    recordApply(true);
    return {
      findingId: finding.id,
      applied: true,
      message: `Patch aplicado em ${patch.files.join(", ")}.`,
      checks: checks.output,
    };
  } catch (error) {
    const restored = restoreBackup(run.id, finding.id, root);
    const message = error instanceof Error ? error.message : String(error);
    store.updateFinding(finding.id, { status: "failed", rejectionReason: message });
    logger.error("patch.apply.failed", { findingId: finding.id, message, restored });
    recordApply(false);
    return { findingId: finding.id, applied: false, message, checks: [], rolledBack: restored.length > 0 };
  }
}

export async function applyApproved(runId?: string): Promise<ApplyResult[]> {
  const findings = store
    .listFindings({ status: "approved", limit: 500 })
    .filter((f) => !runId || f.runId === runId);
  const results: ApplyResult[] = [];
  for (const finding of findings) results.push(await applyFinding(finding));
  return results;
}

export function rollbackRun(runId: string): string[] {
  const run = store.getRun(runId);
  if (!run) throw new Error("Execução não encontrada.");
  if (run.targetType === "url") return [];
  const root = resolve(run.target);
  const restored: string[] = [];
  const backups = join(config.dataDir, "backups", runId);
  if (!existsSync(backups)) return [];
  for (const findingId of readdirSync(backups)) {
    restored.push(...restoreBackup(runId, findingId, root));
    const finding = store.getFinding(findingId);
    if (finding && ["applied", "failed"].includes(finding.status)) {
      store.updateFinding(findingId, { status: "rejected", rejectionReason: "Rollback executado." });
    }
  }
  rmSync(backups, { recursive: true, force: true });
  logger.info("patch.rollback.run", { runId, restored });
  return restored;
}
