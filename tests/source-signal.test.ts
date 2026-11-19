import assert from "node:assert/strict";
import test from "node:test";
import { sourceSignal } from "../src/ai/verifier.js";
import type { AuditRun, Finding, RawSignal } from "../src/shared/types.js";

const signals: RawSignal[] = [
  {
    domain: "code",
    ruleId: "TODO_MARKER",
    title: "TODO",
    message: "a",
    severity: "P4",
    path: "todo.js",
    evidence: "todo.js:1",
  },
  {
    domain: "code",
    ruleId: "CONSOLE_LOG",
    title: "console.log",
    message: "b",
    severity: "P4",
    path: "app.js",
    line: 2,
    evidence: "app.js:2",
  },
];

const run = {
  id: "run_test",
  targetType: "path",
  target: ".",
  startedAt: "2026-01-01T00:00:00.000Z",
  status: "completed",
  signals,
  checksRun: [],
  checksNotRun: [],
} as AuditRun;

const finding = {
  id: "fnd_test",
  runId: run.id,
  sourceRuleId: "CONSOLE_LOG",
  domain: "code",
  severity: "P4",
  title: "console.log",
  observedBehavior: "x",
  impact: "y",
  evidence: "z",
  suggestedFix: "remover",
  confidence: "high",
  checksRun: [],
  checksSuggested: [],
  uncertainty: "nenhuma",
  status: "proposed",
  patch: null,
  verifierNote: "",
  verifierConfidence: "low",
  rejectionReason: "",
  createdAt: run.startedAt,
  updatedAt: run.startedAt,
} as Finding;

test("verificador seleciona o sinal de origem, não o primeiro do domínio", () => {
  assert.equal(sourceSignal(run, finding)?.ruleId, "CONSOLE_LOG");
  assert.equal(sourceSignal(run, finding)?.path, "app.js");
});
