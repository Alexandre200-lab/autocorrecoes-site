import { existsSync, readFileSync } from "node:fs";
import { config } from "../config/index.js";
import { logger } from "../observability/index.js";
import { recordFinding } from "../observability/metrics.js";
import { validatePatch } from "../patches/index.js";
import { isSuppression } from "../patches/antiSuppression.js";
import { newId, store } from "../storage/index.js";
import { events } from "../shared/events.js";
import type { AuditRun, Finding, RawSignal } from "../shared/types.js";
import { resolveLocalTarget } from "../auditors/url.js";
import { deepSeekProvider, type AiProvider } from "./provider.js";
import { PROMPT_VERSION, SYSTEM_PROPOSER, buildProposerUserPrompt } from "./prompts/index.js";
import { ProposalSchema, type ProposedFinding } from "./schemas.js";

const CHUNK_SIZE = 10;
const MAX_CONTEXT_CHARS = 18_000;

function stripFences(text: string): string {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
}

function screenshotsFrom(context: string): string[] {
  const paths = new Set<string>();
  const re = /Screenshot(?:[^:]*):\s*(\S+\.png)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(context)) !== null) paths.add(match[1]);
  return [...paths]
    .filter((p) => existsSync(p))
    .slice(0, 2)
    .map((p) => `data:image/png;base64,${readFileSync(p).toString("base64")}`);
}

function toFinding(
  proposal: ProposedFinding,
  run: AuditRun,
  chunk: RawSignal[],
): Finding {
  const signal =
    (proposal.signalIndex ? chunk[proposal.signalIndex - 1] : undefined) ??
    chunk.find((s) => s.ruleId === proposal.sourceRuleId) ??
    chunk.find((s) => s.path === proposal.path && s.line === proposal.line) ??
    chunk[0];
  const provenanceNote =
    signal?.ruleId === proposal.sourceRuleId
      ? ""
      : ` Origem incerta: ruleId "${proposal.sourceRuleId}" não correspondeu a um sinal do lote.`;
  const now = new Date().toISOString();
  const patch = proposal.patch
    ? {
        findingId: "",
        format: proposal.patch.format,
        files: proposal.patch.files,
        content: proposal.patch.content,
        riskNotes: proposal.patch.riskNotes,
        untouchedAssertion: proposal.patch.untouchedAssertion,
      }
    : null;

  return {
    id: newId("fnd"),
    runId: run.id,
    sourceRuleId: signal?.ruleId,
    domain: proposal.domain,
    severity: proposal.severity,
    path: proposal.path ?? signal?.path,
    line: proposal.line ?? signal?.line,
    url: proposal.url ?? signal?.url,
    title: proposal.title,
    observedBehavior: proposal.observedBehavior,
    impact: proposal.impact,
    evidence: proposal.evidence || (signal?.evidence ?? ""),
    suggestedFix: proposal.suggestedFix,
    confidence: proposal.confidence,
    checksRun: proposal.checksRun.length ? proposal.checksRun : run.checksRun,
    checksSuggested: proposal.checksSuggested,
    uncertainty: `${proposal.uncertainty}${provenanceNote}`,
    status: "proposed",
    patch: patch ? { ...patch, findingId: "" } : null,
    verifierNote: "",
    verifierConfidence: "low",
    rejectionReason: "",
    createdAt: now,
    updatedAt: now,
  };
}

export async function propose(
  run: AuditRun,
  context: string,
  provider: AiProvider = deepSeekProvider,
): Promise<Finding[]> {
  // Sinais que exigem julgamento humano não viram patch automático.
  const eligible = run.signals.filter((s) => !s.metadata?.requiresHuman && !s.metadata?.infrastructure);
  if (eligible.length === 0) return [];

  const root = run.targetType === "path" ? resolveLocalTarget(run.target) : undefined;
  const images = run.signals.some((s) => s.domain === "design") ? screenshotsFrom(context) : [];
  const contextForAi = context.slice(0, MAX_CONTEXT_CHARS);
  const created: Finding[] = [];
  const seen = new Set<string>();

  const domains = [...new Set(eligible.map((s) => s.domain))];
  for (const domain of domains) {
    const domainSignals = eligible.filter((s) => s.domain === domain);
    for (let i = 0; i < domainSignals.length; i += CHUNK_SIZE) {
      const chunk = domainSignals.slice(i, i + CHUNK_SIZE);
      const beforeChunk = created.length;
      let raw: string;
      try {
        raw = await provider.complete({
          system: SYSTEM_PROPOSER,
          user: buildProposerUserPrompt(run, chunk, contextForAi),
          json: true,
          thinking: false,
          images: domain === "design" ? images : undefined,
          label: `proposer:${domain}`,
          traceId: run.id,
        });
      } catch (error) {
        logger.warn("ai.proposer.failed", {
          runId: run.id,
          domain,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      let parsed;
      try {
        parsed = ProposalSchema.parse(JSON.parse(stripFences(raw)));
      } catch (error) {
        logger.warn("ai.proposer.invalid_json", {
          runId: run.id,
          domain,
          message: error instanceof Error ? error.message : String(error),
          raw: raw.slice(0, 500),
        });
        continue;
      }

      for (const proposal of parsed.findings) {
        if (proposal.domain !== domain) continue;
        const reasons = isSuppression(
          `${proposal.suggestedFix}\n${proposal.patch?.content ?? ""}\n${proposal.patch?.riskNotes.join("\n") ?? ""}`,
        );
        if (reasons.length > 0) {
          logger.warn("ai.proposer.suppression_blocked", { runId: run.id, reasons });
          continue;
        }
        const finding = toFinding(proposal, run, chunk);
        const key = `${finding.sourceRuleId ?? ""}|${finding.path ?? finding.url ?? ""}|${finding.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (finding.patch) {
          try {
            validatePatch(finding.patch, root);
            finding.patch.findingId = finding.id;
          } catch (error) {
            logger.warn("ai.proposer.invalid_patch", {
              findingId: finding.id,
              message: error instanceof Error ? error.message : String(error),
            });
            finding.patch = null; // mantém o achado, mas sem patch aplicável
          }
        }
        store.createFinding(finding);
        recordFinding(finding.severity);
        created.push(finding);
        events.emitEvent({
          type: "finding:created",
          runId: run.id,
          findingId: finding.id,
          status: finding.status,
        });
      }

      store.addReceipt({
        id: newId("rcpt"),
        runId: run.id,
        kind: "proposal",
        payload: {
          promptVersion: PROMPT_VERSION,
          provider: provider.name,
          model: config.DEEPSEEK_MODEL,
          domain,
          signalCount: chunk.length,
          proposedCount: created.length - beforeChunk,
          sourceRuleIds: chunk.map((s) => s.ruleId),
          imagesSent: domain === "design" ? images.length : 0,
        },
        createdAt: new Date().toISOString(),
      });
    }
  }
  return created;
}
