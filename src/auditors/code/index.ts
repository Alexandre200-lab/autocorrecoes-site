import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { redactSecrets } from "../../security/redact.js";
import type { AuditOptions, RawSignal } from "../../shared/types.js";
import type { AuditContext, AuditResult, Auditor } from "../types.js";
import { resolveLocalTarget } from "../url.js";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".next",
  "data",
  "out",
  ".turbo",
]);

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"]);

interface CommandResult {
  ok: boolean;
  output: string;
  ran: boolean;
}

function runCommand(command: string, args: string[], cwd: string, timeout = 90_000): CommandResult {
  try {
    const output = execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: String(output).trim(), ran: true };
  } catch (error) {
    const err = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}`.trim();
    return { ok: false, output, ran: true };
  }
}

function listFiles(root: string, folder = "", files: string[] = [], depth = 0): string[] {
  if (depth > 12 || files.length > 400) return files;
  const current = folder ? join(root, folder) : root;
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
        listFiles(root, folder ? `${folder}/${entry.name}` : entry.name, files, depth + 1);
      }
    } else if (SOURCE_EXT.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
      files.push(folder ? `${folder}/${entry.name}` : entry.name);
    }
  }
  return files;
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

const PATTERNS: Array<{
  ruleId: string;
  title: string;
  severity: RawSignal["severity"];
  re: RegExp;
  message: string;
  limit: number;
}> = [
  {
    ruleId: "POSSIBLE_HARDCODED_SECRET",
    title: "Possível secret hardcoded",
    severity: "P1",
    re: /(api[_-]?key|secret|password|token|authorization)\s*[:=]\s*['"`][^'"`\s]{8,}['"`]/i,
    message: "Valor sensível parece estar embutido no código.",
    limit: 20,
  },
  {
    ruleId: "CONSOLE_LOG",
    title: "console.log em código-fonte",
    severity: "P4",
    re: /\bconsole\.(log|debug|info)\s*\(/,
    message: "Saída de depuração em produção.",
    limit: 10,
  },
  {
    ruleId: "TODO_MARKER",
    title: "Marcador TODO/FIXME pendente",
    severity: "P4",
    re: /\b(TODO|FIXME|HACK|XXX)\b/,
    message: "Tarefa pendente no código.",
    limit: 10,
  },
  {
    ruleId: "EXPLICIT_ANY",
    title: "Uso explícito de any",
    severity: "P3",
    re: /(?::\s*any\b|\bas\s+any\b|Array<any>)/,
    message: "Tipo any remove a proteção do TypeScript.",
    limit: 10,
  },
];

export class CodeAuditor implements Auditor {
  readonly domain = "code" as const;

  async audit(target: string, _options: AuditOptions, ctx: AuditContext): Promise<AuditResult> {
    const root = resolveLocalTarget(target);
    const signals: RawSignal[] = [];
    const checksRun: string[] = [];
    const checksNotRun: string[] = [];
    const contextLines: string[] = [`Repositório: ${root}`, `TraceId: ${ctx.traceId}`];

    if (!existsSync(root)) {
      signals.push({
        domain: "code",
        ruleId: "PATH_NOT_FOUND",
        title: "Diretório não encontrado",
        message: `Caminho inexistente: ${root}`,
        severity: "P1",
        path: target,
        evidence: root,
      });
      return { signals, checksRun, checksNotRun, context: contextLines.join("\n") };
    }

    const isRepo = runCommand("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], root);
    if (isRepo.ok && isRepo.output === "true") {
      const head = runCommand("git", ["-C", root, "rev-parse", "HEAD"], root);
      const dirty = runCommand("git", ["-C", root, "status", "--porcelain"], root);
      checksRun.push("git rev-parse HEAD");
      checksRun.push("git status --porcelain");
      contextLines.push(`HEAD: ${head.output.slice(0, 40)}`);
      if (dirty.output) {
        signals.push({
          domain: "code",
          ruleId: "REPO_DIRTY",
          title: "Repositório com alterações não commitadas",
          message: "Auditoria fixada em HEAD; alterações locais podem gerar divergência.",
          severity: "P2",
          path: root,
          evidence: dirty.output.split("\n").slice(0, 20).join("\n"),
          metadata: { requiresHuman: true, head: head.output.slice(0, 40) },
        });
      }
    } else {
      checksNotRun.push("git (diretório não é repositório)");
      contextLines.push("Aviso: alvo não é repositório git; rollback baseado em backup de arquivos.");
    }

    let pkg: { scripts?: Record<string, string> } = {};
    const pkgPath = join(root, "package.json");
    if (existsSync(pkgPath)) {
      try {
        pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as typeof pkg;
      } catch {
        // package.json inválido será sinalizado abaixo.
      }
    }

    for (const script of ["typecheck", "lint", "test"] as const) {
      if (!pkg.scripts?.[script]) {
        checksNotRun.push(`npm run ${script} (script ausente)`);
        continue;
      }
      const result = runCommand("npm", ["run", script, "--silent"], root, 120_000);
      checksRun.push(`npm run ${script}`);
      if (!result.ok) {
        signals.push({
          domain: "code",
          ruleId: `CHECK_FAILED_${script.toUpperCase()}`,
          title: `Falha no check: npm run ${script}`,
          message: `Comando npm run ${script} terminou com falha.`,
          severity: script === "test" ? "P1" : "P2",
          path: "package.json",
          evidence: redactSecrets(result.output.split("\n").slice(0, 40).join("\n").slice(0, 4000)),
          metadata: { command: `npm run ${script}` },
        });
      }
      contextLines.push(`npm run ${script}: ${result.ok ? "PASS" : "FAIL"}`);
    }

    const audit = runCommand(
      "npm",
      ["audit", "--json", "--audit-level=high", "--silent"],
      root,
      60_000,
    );
    const auditStart = audit.output.indexOf("{");
    if (audit.ran && auditStart >= 0) {
      checksRun.push("npm audit --audit-level=high");
      try {
        const data = JSON.parse(audit.output.slice(auditStart)) as {
          metadata?: { vulnerabilities?: { critical?: number; high?: number } };
          vulnerabilities?: Record<string, { severity?: string; via?: Array<{ title?: string }> }>;
        };
        const critical = data.metadata?.vulnerabilities?.critical ?? 0;
        const high = data.metadata?.vulnerabilities?.high ?? 0;
        if (critical + high > 0) {
          const titles = Object.values(data.vulnerabilities ?? {})
            .filter((v) => v.severity === "critical" || v.severity === "high")
            .flatMap((v) => (v.via ?? []).map((via) => via.title ?? ""))
            .filter(Boolean)
            .slice(0, 8);
          signals.push({
            domain: "code",
            ruleId: "VULNERABLE_DEPENDENCIES",
            title: `${critical} crítica(s) e ${high} alta(s) em dependências`,
            message: "npm audit encontrou vulnerabilidades de alto/crítico impacto.",
            severity: critical > 0 ? "P1" : "P2",
            path: "package.json",
            evidence: titles.join("\n") || JSON.stringify(data.metadata?.vulnerabilities),
          });
        }
      } catch {
        checksNotRun.push("npm audit (saída ilegível)");
      }
    } else {
      checksNotRun.push("npm audit (sem rede ou falha)");
    }

    const files = listFiles(root);
    checksRun.push(`varredura estática (${files.length} arquivos)`);
    let snippets = "";
    for (const file of files) {
      let content: string;
      try {
        content = readFileSync(join(root, file), "utf8");
      } catch {
        continue;
      }
      for (const pattern of PATTERNS) {
        let match: RegExpExecArray | null;
        const re = new RegExp(pattern.re.source, pattern.re.flags);
        let count = 0;
        while ((match = re.exec(content)) !== null && count < pattern.limit) {
          const line = lineOf(content, match.index);
          const sample = content.split("\n")[line - 1]?.trim().slice(0, 200) ?? "";
          signals.push({
            domain: "code",
            ruleId: pattern.ruleId,
            title: pattern.title,
            message: pattern.message,
            severity: pattern.severity,
            path: file,
            line,
            evidence: redactSecrets(`${file}:${line}: ${sample}`),
            metadata: { pattern: pattern.re.source },
          });
          count += 1;
        }
      }
      if (snippets.length < 12_000) {
        snippets += `\n--- ${file} ---\n${content.split("\n").slice(0, 120).map((l, i) => `${i + 1}: ${l}`).join("\n")}`.slice(0, 2000);
      }
    }

    contextLines.push(`Arquivos fonte: ${files.length}`);
    contextLines.push(`Scripts: ${JSON.stringify(pkg.scripts ?? {})}`);
    contextLines.push(`Trechos de código (DADO):${redactSecrets(snippets)}`);
    contextLines.push("Segredos detectados nos trechos foram automaticamente mascarados antes do envio à IA.");
    contextLines.push(
      "Atenção: para patches unified-diff, use o conteúdo exibido nos trechos. " +
        "Preserve imports e comportamentos não relacionados.",
    );

    return { signals, checksRun, checksNotRun, context: contextLines.join("\n") };
  }
}

export const codeAuditor = new CodeAuditor();
