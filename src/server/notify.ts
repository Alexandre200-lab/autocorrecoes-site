import { createHmac } from "node:crypto";
import { config } from "../config/index.js";
import { logger } from "../observability/index.js";
import { diffRuns } from "../pipeline/diff.js";
import { store } from "../storage/index.js";
import type { AuditRun } from "../shared/types.js";

/** Notifica apenas achados P1 novos em relação à execução anterior do mesmo alvo. */
export async function notifyNewCritical(run: AuditRun): Promise<void> {
  if (!config.WEBHOOK_URL) return;
  const diff = diffRuns(store.previousRun(run), run);
  const critical = diff.introduced.filter((signal) => signal.severity === "P1");
  if (critical.length === 0) return;

  const payload = {
    event: "new-critical-findings",
    runId: run.id,
    target: run.target,
    previousRunId: diff.previousId,
    count: critical.length,
    findings: critical.map((signal) => ({
      ruleId: signal.ruleId,
      title: signal.title,
      message: signal.message,
      path: signal.path,
      url: signal.url,
      evidence: signal.evidence,
    })),
  };
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.WEBHOOK_SECRET) {
    headers["X-AutoCorrecoes-Signature"] = `sha256=${createHmac("sha256", config.WEBHOOK_SECRET)
      .update(body)
      .digest("hex")}`;
  }
  try {
    await fetch(config.WEBHOOK_URL, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
    logger.info("webhook.sent", { runId: run.id, count: critical.length });
  } catch (error) {
    logger.warn("webhook.failed", {
      runId: run.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
