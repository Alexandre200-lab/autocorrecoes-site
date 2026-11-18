import { config } from "../config/index.js";
import { logger } from "../observability/index.js";
import { newId, store } from "../storage/index.js";
import { events } from "../shared/events.js";
import type { AuditRun, Finding } from "../shared/types.js";
import { deepSeekProvider, type AiProvider } from "./provider.js";
import { PROMPT_VERSION, SYSTEM_VERIFIER, buildVerifierUserPrompt } from "./prompts/index.js";
import { VerificationSchema, type Verification } from "./schemas.js";

function stripFences(text: string): string {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
}

/**
 * Verificador independente: recebe apenas achado, evidência e patch.
 * Nunca recebe o raciocínio do Proposer — evita auto-confirmação.
 */
export async function verify(
  finding: Finding,
  run: AuditRun,
  provider: AiProvider = deepSeekProvider,
): Promise<Verification | null> {
  const signal = run.signals.find((s) => s.domain === finding.domain);
  let raw: string;
  try {
    raw = await provider.complete({
      system: SYSTEM_VERIFIER,
      user: buildVerifierUserPrompt(finding, signal),
      json: true,
      thinking: false,
      model: config.DEEPSEEK_VERIFY_MODEL,
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
      model: config.DEEPSEEK_VERIFY_MODEL,
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
