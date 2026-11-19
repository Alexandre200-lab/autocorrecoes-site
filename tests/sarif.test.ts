import assert from "node:assert/strict";
import test from "node:test";
import { toSarif } from "../src/report/sarif.js";
import type { AuditRun, Finding } from "../src/shared/types.js";

const run: AuditRun = {
  id: "run_sarif",
  targetType: "path",
  target: "/projeto",
  startedAt: "2026-01-01T00:00:00.000Z",
  status: "completed",
  signals: [],
  checksRun: ["varredura estática"],
  checksNotRun: [],
};

const finding: Finding = {
  id: "fnd_sarif",
  runId: run.id,
  sourceRuleId: "CONSOLE_LOG",
  domain: "code",
  severity: "P1",
  path: "app.js",
  line: 7,
  title: "console.log",
  observedBehavior: "saída de debug",
  impact: "polui o console",
  evidence: "app.js:7",
  suggestedFix: "remover",
  confidence: "high",
  checksRun: [],
  checksSuggested: [],
  uncertainty: "nenhuma",
  status: "verified",
  patch: null,
  verifierNote: "ok",
  verifierConfidence: "high",
  rejectionReason: "",
  createdAt: run.startedAt,
  updatedAt: run.startedAt,
};

test("toSarif gera SARIF 2.1.0 com regra, nível e localização", () => {
  const sarif = toSarif(run, [finding]) as {
    version: string;
    runs: Array<{
      tool: { driver: { rules: Array<{ id: string; defaultConfiguration: { level: string } }> } };
      results: Array<{ ruleId: string; level: string; locations: Array<{ physicalLocation: { region: { startLine: number } } }> }>;
    }>;
  };
  assert.equal(sarif.version, "2.1.0");
  assert.equal(sarif.runs[0].tool.driver.rules[0].id, "CONSOLE_LOG");
  assert.equal(sarif.runs[0].tool.driver.rules[0].defaultConfiguration.level, "error");
  assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine, 7);
});
