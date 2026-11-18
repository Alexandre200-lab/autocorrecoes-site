import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { propose } from "../src/ai/proposer.js";
import { verify } from "../src/ai/verifier.js";
import type { AiProvider } from "../src/ai/provider.js";
import type { CompletionArgs } from "../src/ai/client.js";
import { newId, store } from "../src/storage/index.js";
import type { AuditRun, Finding, RawSignal } from "../src/shared/types.js";

function fixture(target: string, signals: RawSignal[]): AuditRun {
  const run: AuditRun = {
    id: newId("run"),
    targetType: "path",
    target,
    startedAt: new Date().toISOString(),
    status: "completed",
    signals,
    checksRun: ["varredura estática"],
    checksNotRun: [],
  };
  store.createRun(run);
  for (const signal of signals) store.insertSignal(run.id, signal);
  return run;
}

const signals: RawSignal[] = [
  {
    domain: "code",
    ruleId: "TODO_MARKER",
    title: "TODO",
    message: "pendente",
    severity: "P4",
    path: "todo.js",
    line: 3,
    evidence: "todo.js:3 TODO",
  },
  {
    domain: "code",
    ruleId: "CONSOLE_LOG",
    title: "console.log",
    message: "depuração",
    severity: "P4",
    path: "app.js",
    line: 1,
    evidence: "app.js:1 console.log",
  },
];

function providerResponding(raw: string): AiProvider {
  return {
    name: "mock",
    complete: async (_args: CompletionArgs) => raw,
  };
}

test("proposer preserva proveniência do sinal de origem", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ac-ai-test-"));
  const run = fixture(dir, signals);
  const raw = JSON.stringify({
    findings: [
      {
        sourceRuleId: "CONSOLE_LOG",
        signalIndex: 2,
        domain: "code",
        severity: "P4",
        title: "console.log em código",
        observedBehavior: "saída de depuração",
        impact: "polui console",
        evidence: "app.js:1",
        suggestedFix: "remover console.log",
        confidence: "high",
        checksRun: [],
        checksSuggested: [],
        uncertainty: "nenhuma",
        patch: null,
      },
    ],
  });

  try {
    const findings = await propose(run, "contexto", providerResponding(raw));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].sourceRuleId, "CONSOLE_LOG");
    assert.equal(findings[0].path, "app.js");
    assert.equal(findings[0].line, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proposer bloqueia patch supressivo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ac-ai-test-"));
  const run = fixture(dir, signals);
  const raw = JSON.stringify({
    findings: [
      {
        sourceRuleId: "CONSOLE_LOG",
        domain: "code",
        severity: "P4",
        title: "supressão",
        observedBehavior: "saída de depuração",
        impact: "polui o console",
        evidence: "z",
        suggestedFix: "esconder",
        confidence: "high",
        checksRun: [],
        checksSuggested: [],
        uncertainty: "nenhuma",
        patch: {
          format: "css-rule",
          files: ["app.css"],
          content: ".erro { display: none; }",
          riskNotes: [],
          untouchedAssertion: [],
        },
      },
    ],
  });
  try {
    assert.deepEqual(await propose(run, "contexto", providerResponding(raw)), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifier independente rejeita quando detecta supressão", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ac-ai-test-"));
  const run = fixture(dir, signals);
  const finding: Finding = {
    id: newId("fnd"),
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.createFinding(finding);
  const raw = JSON.stringify({
    valid: false,
    reason: "O patch esconde o sintoma.",
    confidence: "high",
    suppressionDetected: true,
    recommendedStatus: "rejected",
  });
  try {
    const result = await verify(finding, run, providerResponding(raw));
    assert.equal(result?.valid, false);
    assert.equal(store.getFinding(finding.id)?.status, "rejected");
    const receipts = store.listReceipts(run.id);
    assert.ok(receipts.some((r) => r.kind === "verification" && r.payload.promptVersion));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
