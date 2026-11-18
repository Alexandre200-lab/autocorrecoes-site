#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { Command } from "commander";
import { config } from "../config/index.js";
import { getBudget } from "../ai/client.js";
import { reauditFinding, runAudit } from "../pipeline/index.js";
import { applyApproved, rollbackRun } from "../patches/index.js";
import { newId, store } from "../storage/index.js";
import { toSarif } from "../report/sarif.js";
import { fingerprint } from "../pipeline/fingerprint.js";
import { startOtel } from "../observability/otel.js";
import type { Domain, Finding, TargetType } from "../shared/types.js";

const program = new Command();

const SEVERITY_LABEL: Record<string, string> = {
  P1: "CRÍTICO",
  P2: "ALTO   ",
  P3: "MÉDIO  ",
  P4: "BAIXO  ",
};

function short(text: string, max = 90): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function printFindings(findings: Finding[]): void {
  if (findings.length === 0) {
    console.log("Nenhum achado.");
    return;
  }
  for (const f of findings) {
    const location = f.path ? `${f.path}${f.line ? `:${f.line}` : ""}` : (f.url ?? "-");
    console.log(
      `\n[${SEVERITY_LABEL[f.severity] ?? f.severity}] ${f.id}  ${f.status.toUpperCase()}\n` +
        `  ${f.title}\n` +
        `  Domínio: ${f.domain} | Local: ${location} | Confiança: ${f.confidence}\n` +
        `  Evidência: ${short(f.evidence)}\n` +
        `  Impacto: ${short(f.impact)}\n` +
        `  Correção: ${short(f.suggestedFix)}\n` +
        (f.uncertainty ? `  Incerteza: ${short(f.uncertainty, 120)}\n` : "") +
        (f.verifierNote ? `  Verificador: ${short(f.verifierNote, 120)}\n` : "") +
        (f.patch ? `  Patch: ${f.patch.format} em ${f.patch.files.join(", ")}\n` : "  Patch: nenhum (orientação)\n"),
    );
  }
}

/** Sem IA, os sinais brutos também viram itens de gate/relatório. */
function signalsToFindings(run: Awaited<ReturnType<typeof runAudit>>["run"]): Finding[] {
  return run.signals
    .filter((signal) => !signal.metadata?.infrastructure && !signal.metadata?.requiresHuman)
    .map((signal) => ({
      id: `signal:${signal.ruleId}`,
      runId: run.id,
      sourceRuleId: signal.ruleId,
      domain: signal.domain,
      severity: signal.severity,
      path: signal.path,
      line: signal.line,
      url: signal.url,
      title: signal.title,
      observedBehavior: signal.message,
      impact: signal.message,
      evidence: signal.evidence,
      suggestedFix: "Revisar sinal determinístico e aplicar correção adequada.",
      confidence: "high",
      checksRun: run.checksRun,
      checksSuggested: [],
      uncertainty: "Achado bruto: a IA não foi executada nesta auditoria.",
      status: "detected",
      patch: null,
      verifierNote: "",
      verifierConfidence: "low",
      rejectionReason: "",
      createdAt: run.startedAt,
      updatedAt: run.startedAt,
    }));
}

function parseDomains(value?: string): Domain[] | undefined {
  if (!value) return undefined;
  const parts = value.split(",").map((v) => v.trim().toLowerCase());
  const valid: Domain[] = ["design", "backend", "code"];
  const result = parts.filter((p): p is Domain => valid.includes(p as Domain));
  return result.length ? result : undefined;
}

program
  .name("autocorrecoes")
  .description("Auditoria e autocorreção de sites com fiscalização independente por DeepSeek")
  .version("1.0.0");

program
  .command("audit")
  .description("Executa auditoria em uma URL ou repositório local")
  .argument("<target>", "URL ou caminho do projeto")
  .option("--url", "força alvo como URL")
  .option("--path", "força alvo como diretório local")
  .option("--domains <lista>", "design,backend,code (separados por vírgula)")
  .option("--no-ai", "coleta sinais sem chamar DeepSeek")
  .option("--allow-mutating-requests", "permete OPTIONS no alvo remoto")
  .option("--allow-private-hosts", "libera localhost/privados (use apenas em testes)")
  .option("--json", "atalho para --format json")
  .option("--format <formato>", "text | json | sarif", "text")
  .option("--output <arquivo>", "grava o relatório em arquivo")
  .option("--fail-on <severidade>", "exit code 1 se houver achado P1|P2|P3|P4 (ou none)")
  .action(async (target: string, opts) => {
    const type: TargetType | undefined = opts.url ? "url" : opts.path ? "path" : undefined;
    const outcome = await runAudit(target, {
      type,
      domains: parseDomains(opts.domains),
      useAI: opts.ai !== false,
      allowMutatingRequests: Boolean(opts.allowMutatingRequests),
      allowPrivateHosts: Boolean(opts.allowPrivateHosts),
    });

    const format = opts.json ? "json" : (opts.format as string);
    const effectiveFindings = outcome.findings.length
      ? outcome.findings
      : signalsToFindings(outcome.run);
    const active = effectiveFindings.filter(
      (f) => !["rejected", "fixed"].includes(f.status),
    );
    let report: string | null = null;
    if (format === "json") {
      report = JSON.stringify(outcome, null, 2);
    } else if (format === "sarif") {
      report = JSON.stringify(toSarif(outcome.run, active), null, 2);
    }
    if (report && opts.output) {
      writeFileSync(opts.output, report, "utf8");
    }

    const log = format === "text" ? console.log : console.error;
    log(`\nAuditoria ${outcome.run.id} concluída.`);
    log(`Alvo: ${outcome.run.targetType} ${outcome.run.target}`);
    log(
      `Sinais: ${outcome.run.signals.length} | Achados: ${active.length} | ` +
        `Custo IA: $${outcome.budget.spentUsd.toFixed(4)}`,
    );
    log(`Checks executados: ${outcome.run.checksRun.join(", ") || "nenhum"}`);
    if (outcome.run.checksNotRun.length) {
      log(`Checks não executados: ${outcome.run.checksNotRun.join(", ")}`);
    }
    if (format === "text") {
      printFindings(active);
      if (active.length) {
        log(`\nPróximos passos: autocorrecoes approve <id> && autocorrecoes apply --reaudit`);
      }
    } else if (report) {
      console.log(report);
    }

    if (opts.failOn && opts.failOn !== "none") {
      const order = ["P4", "P3", "P2", "P1"];
      const threshold = order.indexOf(opts.failOn as string);
      if (threshold >= 0 && active.some((f) => order.indexOf(f.severity) >= threshold)) {
        log(`\nGate CI: falhando por achados >= ${opts.failOn}.`);
        process.exitCode = 1;
      }
    }
  });

program
  .command("report")
  .description("Mostra execuções e achados (padrão: última execução)")
  .argument("[runId]", "ID da execução")
  .option("--json", "saída em JSON")
  .action(async (runId: string | undefined, opts) => {
    const run = runId ? store.getRun(runId) : store.latestRun();
    if (!run) {
      console.log("Nenhuma execução encontrada.");
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify({ run, findings: store.listFindings({ runId: run.id }) }, null, 2));
      return;
    }
    console.log(`Execução ${run.id} — ${run.targetType} ${run.target}`);
    console.log(`Status: ${run.status} | Iniciada: ${run.startedAt} | Sinais: ${run.signals.length}`);
    printFindings(store.listFindings({ runId: run.id }));
  });

program
  .command("runs")
  .description("Lista execuções recentes")
  .action(() => {
    const runs = store.listRuns(20);
    if (!runs.length) return console.log("Nenhuma execução.");
    console.table(
      runs.map((r) => ({
        id: r.id,
        alvo: short(r.target, 45),
        tipo: r.targetType,
        status: r.status,
        sinais: r.signals.length,
        iniciada: r.startedAt.slice(0, 19),
      })),
    );
  });

program
  .command("baseline")
  .description("Adiciona ao .autocorrecoes.yml as fingerprints dos sinais de uma execução")
  .argument("<runId>")
  .option("--file <caminho>", "arquivo de configuração", ".autocorrecoes.yml")
  .action((runId: string, opts) => {
    const run = store.getRun(runId);
    if (!run) {
      console.error("Execução não encontrada.");
      process.exitCode = 1;
      return;
    }
    const file = resolve(process.cwd(), opts.file);
    const existing = (existsSync(file)
      ? (YAML.parse(readFileSync(file, "utf8")) as Record<string, unknown>)
      : {}) as {
      baseline?: { fingerprints?: string[] };
      [key: string]: unknown;
    };
    const current = existing.baseline?.fingerprints ?? [];
    const merged = [...new Set([...current, ...run.signals.map(fingerprint)])];
    existing.baseline = { ...(existing.baseline ?? {}), fingerprints: merged };
    writeFileSync(file, YAML.stringify(existing), "utf8");
    console.log(`${merged.length - current.length} nova(s) fingerprint(s) em ${file} (total: ${merged.length}).`);
  });

program
  .command("jobs")
  .description("Lista jobs da fila durável (quando o servidor está ativo)")
  .action(async () => {
    const base = `http://${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? 4310}`;
    try {
      const token = process.env.API_TOKEN;
      const response = await fetch(`${base}/api/jobs`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = (await response.json()) as {
        jobs: Array<{ id: string; target: string; status: string; runId?: string }>;
      };
      console.table(
        data.jobs.map((job) => ({
          id: job.id,
          alvo: short(job.target, 45),
          status: job.status,
          runId: job.runId ?? "-",
        })),
      );
    } catch (error) {
      console.error(`Não foi possível consultar ${base}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

async function setStatus(ids: string[], status: "approved" | "rejected", reason: string): Promise<void> {
  for (const id of ids) {
    const finding = store.getFinding(id);
    if (!finding) {
      console.warn(`Achado não encontrado: ${id}`);
      continue;
    }
    const updated = store.updateFinding(id, {
      status,
      rejectionReason: status === "rejected" ? reason : "",
    });
    if (!updated) continue;
    store.addReceipt({
      id: newId("rcpt"),
      runId: finding.runId,
      findingId: finding.id,
      kind: status === "approved" ? "approval" : "rejection",
      payload: { status, reason, humanDecision: true, previousStatus: finding.status },
      createdAt: new Date().toISOString(),
    });
    console.log(`${id} → ${status}`);
  }
}

program
  .command("approve")
  .description("Aprova achados para aplicação")
  .argument("<ids...>", "IDs dos achados")
  .action((ids: string[]) => setStatus(ids, "approved", ""));

program
  .command("reject")
  .description("Rejeita achados")
  .argument("<ids...>", "IDs dos achados")
  .option("--reason <texto>", "motivo", "Rejeitado pelo operador")
  .action((ids: string[], opts) => setStatus(ids, "rejected", opts.reason));

program
  .command("apply")
  .description("Aplica patches aprovados (com backup e rollback automático em falha)")
  .option("--run <id>", "limita a uma execução")
  .option("--reaudit", "roda re-auditoria após aplicar")
  .action(async (opts) => {
    const results = await applyApproved(opts.run);
    if (!results.length) return console.log("Nenhum patch aprovado para aplicar.");
    for (const r of results) {
      console.log(`${r.applied ? "OK" : "FALHA"} ${r.findingId}: ${r.message}`);
      if (r.checks.length) console.log(`  checks: ${r.checks.join(" | ").slice(0, 300)}`);
      if (opts.reaudit && r.applied) {
        const finding = store.getFinding(r.findingId);
        if (finding && !finding.patch?.exportedArtifact) {
          const re = await reauditFinding(finding);
          console.log(`  re-auditoria: ${re.status} (persiste=${re.persists})`);
        }
      }
    }
  });

program
  .command("rollback")
  .description("Restaura arquivos a partir dos backups de uma execução")
  .argument("<runId>")
  .action((runId: string) => {
    const restored = rollbackRun(runId);
    console.log(restored.length ? `Restaurados: ${restored.join(", ")}` : "Nada para restaurar.");
  });

program
  .command("serve")
  .description("Sobe a API REST e o dashboard")
  .option("--port <porta>", "porta do servidor")
  .action(async (opts) => {
    const { startServer } = await import("../server/index.js");
    await startServer(opts.port ? Number(opts.port) : config.PORT);
  });

program
  .command("doctor")
  .description("Verifica configuração e dependências")
  .action(async () => {
    console.log(`Node: ${process.version}`);
    console.log(`Chave DeepSeek: ${config.apiKeyConfigured ? "configurada" : "AUSENTE"}`);
    console.log(`Modelo: ${config.DEEPSEEK_MODEL} | Verificador: ${config.DEEPSEEK_VERIFY_MODEL}`);
    console.log(`Base URL: ${config.DEEPSEEK_BASE_URL}`);
    console.log(`Dados: ${config.dataDir} (${existsSync(config.dataDir) ? "ok" : "será criado"})`);
    console.log(`Banco SQLite: ${existsSync(`${config.dataDir}/autocorrecoes.db`) ? "ok" : "será criado"}`);
    try {
      const pw = await import("playwright");
      const browserPath = pw.chromium.executablePath();
      console.log(`Chromium: ${existsSync(browserPath) ? browserPath : `NÃO INSTALADO (${browserPath})`}`);
    } catch {
      console.log("Playwright: não instalado");
    }
    console.log(
      "Dica: npx playwright install chromium  ·  cp .env.example .env  ·  npm run cli -- audit <alvo>",
    );
  });

startOtel();
program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
