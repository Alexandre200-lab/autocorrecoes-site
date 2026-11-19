import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyFinding } from "../src/patches/index.js";
import { newId, store } from "../src/storage/index.js";
import type { AuditRun, Finding } from "../src/shared/types.js";

test("patch que viola untouchedAssertion é revertido e marcado como falho", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ac-untouched-"));
  const original = 'console.log("debug");\nfunction soma(a, b) { return a + b; }\n';
  writeFileSync(join(dir, "app.js"), original);
  const run: AuditRun = {
    id: newId("run"),
    targetType: "path",
    target: dir,
    startedAt: new Date().toISOString(),
    status: "completed",
    signals: [],
    checksRun: [],
    checksNotRun: [],
  };
  store.createRun(run);
  const finding: Finding = {
    id: newId("fnd"),
    runId: run.id,
    domain: "code",
    severity: "P4",
    title: "remoção indevida",
    observedBehavior: "x",
    impact: "y",
    evidence: "app.js",
    suggestedFix: "remover console.log mas preservar soma()",
    confidence: "high",
    checksRun: [],
    checksSuggested: [],
    uncertainty: "nenhuma",
    status: "approved",
    patch: {
      findingId: "",
      format: "full-file",
      files: ["app.js"],
      content: "// nada aqui\n",
      riskNotes: [],
      // Declara que soma() foi preservada — mas o conteúdo a removeu.
      untouchedAssertion: ["soma()"],
    },
    verifierNote: "",
    verifierConfidence: "low",
    rejectionReason: "",
    createdAt: run.startedAt,
    updatedAt: run.startedAt,
  };
  store.createFinding(finding);
  try {
    const result = await applyFinding(finding);
    assert.equal(result.applied, false);
    assert.match(result.message, /não-alteração|untouched/i);
    assert.equal(readFileSync(join(dir, "app.js"), "utf8"), original);
    assert.equal(store.getFinding(finding.id)?.status, "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
