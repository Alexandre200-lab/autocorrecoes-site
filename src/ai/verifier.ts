import { config } from "../config/index.js";
import { logger } from "../observability/index.js";
import { newId, store } from "../storage/index.js";
import { events } from "../shared/events.js";
import type { AuditRun, Finding } from "../shared/types.js";
import { deepSeekProvider, type AiProvider } from "./provider.js";
import { PROMPT_VERSION, SYSTEM_VERIFIER, buildVerifierUserPrompt } from "./prompts/index.js";
import { VerificationSchema, type Verification } from "./schemas.js";

import { stripFences } from "./json.js";

/** Seleciona o sinal que deu origem ao achado — nunca um sinal arbitrário do domínio. */
export function sourceSignal(run: AuditRun, finding: Finding) {
  return (
    run.signals.find(
      (s) =>
        Boolean(finding.sourceRuleId) &&
        s.ruleId === finding.sourceRuleId &&
        (!finding.path || s.path === finding.path),
    ) ??
    run.signals.find((s) => Boolean(finding.sourceRuleId) && s.ruleId === finding.sourceRuleId) ??
    run.signals.find(
      (s) => finding.path !== undefined && s.path === finding.path && s.line === finding.line,
    ) ??
    run.signals.find((s) => s.domain === finding.domain)
  );
}

/**
 * Verificador independente: recebe apenas achado, evidência e patch.
 * Nunca recebe o raciocínio do Proposer — evita auto-confirmação.
 */
export async function verify(
  finding: Finding,
  run: AuditRun,
  provider: AiProvider = deepSeekProvider,
  modelOverride?: string,
): Promise<Verification | null> {
  const signal = sourceSignal(run, finding);
  let raw: string;
  try {
    raw = await provider.complete({
      system: SYSTEM_VERIFIER,
      user: buildVerifierUserPrompt(finding, signal),
      json: true,
      thinking: false,
      model: modelOverride ?? config.DEEPSEEK_VERIFY_MODEL,
      label: "verifier",
      traceId: run.id,
    });
  } catch (error) {
    logger.warn("ai.verifier.failed", {
      findingId: finding.id,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  let result: Verification;
  try {
    result = VerificationSchema.parse(JSON.parse(stripFences(raw)));
  } catch (error) {
    logger.warn("ai.verifier.invalid_json", {
      findingId: finding.id,
      message: error instanceof Error ? error.message : String(error),
      raw: raw.slice(0, 500),
    });
    return null;
  }

  if (result.suppressionDetected) result.valid = false;
  const status = result.valid && result.recommendedStatus !== "rejected" ? "verified" : "rejected";
  const updated = store.updateFinding(finding.id, {
    status,
    verifierNote: result.reason,
    verifierConfidence: result.confidence,
    severity: result.severityAdjusted ?? finding.severity,
    rejectionReason: status === "rejected" ? result.reason : "",
  });

  store.addReceipt({
    id: newId("rcpt"),
    runId: run.id,
    findingId: finding.id,
    kind: "verification",
    payload: {
      ...result,
      status,
      independent: true,
      promptVersion: PROMPT_VERSION,
      provider: provider.name,
      model: modelOverride ?? config.DEEPSEEK_VERIFY_MODEL,
      reviewerHadProposerReasoning: false,
    },
    createdAt: new Date().toISOString(),
  });

  if (updated) {
    events.emitEvent({
      type: "finding:updated",
      runId: run.id,
      findingId: finding.id,
      status,
    });
  }
  return result;
}
