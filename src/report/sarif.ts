import type { AuditRun, Finding, Severity } from "../shared/types.js";

/** Conversor para SARIF 2.1.0 (padrão consumido por GitHub/GitLab/Azure DevOps). */

const SARIF_LEVEL: Record<Severity, string> = {
  P1: "error",
  P2: "error",
  P3: "warning",
  P4: "note",
};

export function toSarif(run: AuditRun, findings: Finding[]): Record<string, unknown> {
  const rules = findings.map((finding) => ({
    id: finding.sourceRuleId ?? finding.domain.toUpperCase(),
    name: finding.title,
    shortDescription: { text: finding.title },
    fullDescription: { text: finding.impact },
    help: { text: finding.suggestedFix },
    defaultConfiguration: { level: SARIF_LEVEL[finding.severity] },
  }));

  const results = findings.map((finding, index) => ({
    ruleId: finding.sourceRuleId ?? finding.domain.toUpperCase(),
    ruleIndex: index,
    level: SARIF_LEVEL[finding.severity],
    message: { text: `${finding.observedBehavior} ${finding.impact}`.trim() },
    properties: {
      status: finding.status,
      confidence: finding.confidence,
      verifierNote: finding.verifierNote,
      uncertainty: finding.uncertainty,
      patchFormat: finding.patch?.format ?? null,
    },
    locations: [
      {
        physicalLocation: {
          artifactLocation: {
            uri: finding.path ?? finding.url ?? run.target,
          },
          region: finding.line ? { startLine: finding.line } : undefined,
        },
      },
    ],
  }));

  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "AutoCorrecoes",
            version: "1.0.0",
            informationUri: "https://github.com/autocorrecoes/autocorrecoes",
            rules,
          },
        },
        invocations: [
          {
            executionSuccessful: run.status === "completed",
            properties: {
              runId: run.id,
              target: run.target,
              startedAt: run.startedAt,
              checksRun: run.checksRun,
              checksNotRun: run.checksNotRun,
            },
          },
        ],
        results,
      },
    ],
  };
}
