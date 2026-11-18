import { config } from "../config/index.js";
import { applySeverityOverride, isIgnored, loadProjectConfig, ruleAction } from "../config/project.js";
import { propose } from "../ai/proposer.js";
import { verify } from "../ai/verifier.js";
import { getBudget, resetBudget } from "../ai/client.js";
import type { AiProvider } from "../ai/provider.js";
import { designAuditor } from "../auditors/design/index.js";
import { backendAuditor } from "../auditors/backend/index.js";
import { codeAuditor } from "../auditors/code/index.js";
import type { AuditContext, AuditResult, Auditor } from "../auditors/types.js";
import { newTraceId, logger, span } from "../observability/index.js";
import { recordAudit } from "../observability/metrics.js";
import { events } from "../shared/events.js";
import { newId, store } from "../storage/index.js";
import type {
  AuditOptions,
  AuditRun,
  Domain,
  Finding,
  FindingStatus,
  RawSignal,
  TargetType,
} from "../shared/types.js";
import { dedupeSignals } from "./dedup.js";
import { fingerprint, splitByBaseline } from "./fingerprint.js";
import { resolveLocalTarget } from "../auditors/url.js";

function detectTargetType(target: string): TargetType {
  if (/^https?:\/\//i.test(target) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(target)) return "url";
  return "path";
}

function pickAuditors(type: TargetType, domains?: Domain[]): Auditor[] {
  // Alvo local: auditoria estática de código (inclui backend). Design exige URL renderizável.
  const available: Auditor[] =
    type === "url" ? [designAuditor, backendAuditor] : [codeAuditor];
  if (!domains?.length) return available;
  return available.filter((a) => domains.includes(a.domain));
}

async function collect(
  target: string,
  type: TargetType,
  domains: Domain[] | undefined,
  ctx: AuditContext,
  runId: string,
  options: AuditOptions = {},
): Promise<AuditResult> {
  const signals: RawSignal[] = [];
  const checksRun: string[] = [];
  const checksNotRun: string[] = [];
  const contexts: string[] = [];

  for (const auditor of pickAuditors(type, domains)) {
    events.emitEvent({ type: "audit:progress", runId, domain: auditor.domain, count: signals.length });
    const result = await span(
      `audit.${auditor.domain}`,
      () => auditor.audit(target, options, ctx),
      { runId, traceId: ctx.traceId, domain: auditor.domain },
    );
    signals.push(...result.signals);
    checksRun.push(...result.checksRun);
    checksNotRun.push(...result.checksNotRun);
    contexts.push(`## Auditor ${auditor.domain}\n${result.context}`);
  }

  return {
    signals: dedupeSignals(signals),
    checksRun,
    checksNotRun,
    context: contexts.join("\n\n"),
  };
}

export interface AuditOutcome {
  run: AuditRun;
  findings: Finding[];
  budget: ReturnType<typeof getBudget>;
}

export async function runAudit(
  target: string,
  options: AuditOptions = {},
  provider?: AiProvider,
): Promise<AuditOutcome> {
  const type = options.type ?? detectTargetType(target);
  let project = options.project;
  if (!project) {
    try {
      project = loadProjectConfig(type === "path" ? resolveLocalTarget(target) : process.cwd());
    } catch (error) {
      logger.warn("project.config.invalid", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const auditOptions: AuditOptions = { ...options, project };
  const startedAtMs = performance.now();
  const id = newId("run");
  const traceId = newTraceId();
  const run: AuditRun = {
    id,
    targetType: type,
    target,
    startedAt: new Date().toISOString(),
    status: "running",
    signals: [],
    checksRun: [],
    checksNotRun: [],
  };
  store.createRun(run);
  events.emitEvent({ type: "run:started", runId: id, target });
  logger.info("pipeline.started", { runId: id, target, type, traceId });

  try {
    const collected = await collect(
      target,
      type,
      options.domains ?? project?.domains,
      { runId: id, traceId },
      id,
      auditOptions,
    );

    const filtered = collected.signals.filter(
      (signal) =>
        !isIgnored(signal.path ?? signal.url ?? "", project?.ignore ?? []) &&
        (!project || ruleAction(project, signal.ruleId) !== "off"),
    );
    const withOverrides = filtered.map((signal) => ({
      ...signal,
      severity: project ? applySeverityOverride(signal.severity, signal.ruleId, project) : signal.severity,
    }));
    const baseline = splitByBaseline(withOverrides, project?.baseline.fingerprints ?? []);

    run.signals = baseline.kept;
    run.checksRun = collected.checksRun;
    run.checksNotRun = collected.checksNotRun;
    for (const signal of baseline.kept) store.insertSignal(id, signal);
    events.emitEvent({ type: "audit:finished", runId: id, signals: baseline.kept.length });
    store.updateRun(id, {
      status: "completed",
      checksRun: collected.checksRun,
      checksNotRun: collected.checksNotRun,
    });

    store.addReceipt({
      id: newId("rcpt"),
      runId: id,
      kind: "audit",
      payload: {
        target,
        type,
        traceId,
        signalCount: baseline.kept.length,
        ignored: collected.signals.length - filtered.length,
        baselineSuppressed: baseline.suppressed.map((s) => fingerprint(s)),
        configFile: Boolean(project),
        checksRun: collected.checksRun,
        checksNotRun: collected.checksNotRun,
        note: "Limite da auditoria automática: ferramentas detectam apenas parte dos critérios WCAG; revisão humana continua necessária.",
      },
      createdAt: new Date().toISOString(),
    });

    let findings: Finding[] = [];
    if (options.useAI !== false && config.apiKeyConfigured) {
      resetBudget();
      events.emitEvent({ type: "ai:proposing", runId: id });
      findings = await span(
        "ai.propose",
        () => propose(run, collected.context, provider),
        { runId: id, traceId },
      );

      events.emitEvent({ type: "ai:verifying", runId: id });
      for (const finding of findings) {
        await span(`ai.verify.${finding.id}`, () => verify(finding, run, provider), {
          runId: id,
          findingId: finding.id,
          traceId,
        });
      }
    } else {
      logger.info("pipeline.ai_skipped", {
        runId: id,
        reason: options.useAI === false ? "desligado via opção" : "DEEPSEEK_API_KEY ausente",
      });
      store.addReceipt({
        id: newId("rcpt"),
        runId: id,
        kind: "audit",
        payload: {
          note:
            options.useAI === false
              ? "IA desligada pelo usuário; sinais brutos disponíveis para revisão."
              : "DEEPSEEK_API_KEY não configurada; sinais brutos disponíveis para revisão.",
        },
        createdAt: new Date().toISOString(),
      });
    }

    recordAudit(Math.round(performance.now() - startedAtMs), false);
    events.emitEvent({ type: "run:finished", runId: id });
    return {
      run: store.getRun(id) ?? run,
      findings: store.listFindings({ runId: id, limit: 500 }),
      budget: getBudget(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.updateRun(id, { status: "failed", error: message });
    recordAudit(Math.round(performance.now() - startedAtMs), true);
    events.emitEvent({ type: "error", runId: id, message });
    logger.error("pipeline.failed", { runId: id, message });
    throw error;
  }
}

export interface ReauditOutcome {
  status: FindingStatus;
  persists: boolean;
  newSignals: number;
}

/** Re-auditoria independente após aplicação: só marca "fixed" se o sinal sumiu. */
export async function reauditFinding(finding: Finding): Promise<ReauditOutcome> {
  const run = store.getRun(finding.runId);
  if (!run) throw new Error("Execução original não encontrada.");
  const traceId = newTraceId();
  const collected = await collect(
    run.target,
    run.targetType,
    [finding.domain],
    { runId: run.id, traceId },
    run.id,
  );

  const persists = collected.signals.some(
    (s) =>
      (finding.sourceRuleId && s.ruleId === finding.sourceRuleId) ||
      (!finding.sourceRuleId && s.title === finding.title),
  );
  const status: FindingStatus = persists ? "reaudited" : "fixed";
  store.updateFinding(finding.id, {
    status,
    rejectionReason: persists ? "Sinal persiste após a aplicação do patch." : "",
  });
  store.addReceipt({
    id: newId("rcpt"),
    runId: run.id,
    findingId: finding.id,
    kind: "reaudit",
    payload: {
      status,
      persists,
      newSignals: collected.signals.length,
      checksRun: collected.checksRun,
      traceId,
      note: "Verificação pós-aplicação independente da geração do patch.",
    },
    createdAt: new Date().toISOString(),
  });
  events.emitEvent({ type: "finding:updated", runId: run.id, findingId: finding.id, status });
  return { status, persists, newSignals: collected.signals.length };
}
