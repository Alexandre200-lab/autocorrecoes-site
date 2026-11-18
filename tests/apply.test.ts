import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyFinding, rollbackRun, safeResolve } from "../src/patches/index.js";
import { newId, store } from "../src/storage/index.js";
import type { AuditRun, Finding } from "../src/shared/types.js";

function makeRun(dir: string): AuditRun {
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
  return run;
}

test("aplica patch com backup e restaura no rollback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ac-apply-"));
  const original = 'console.log("debug");\nfunction soma(a, b) { return a + b; }\n';
  const cleaned = 'function soma(a, b) { return a + b; }\n';
  writeFileSync(join(dir, "app.js"), original);
  const run = makeRun(dir);
  const finding: Finding = {
    id: newId("fnd"),
    runId: run.id,
    sourceRuleId: "CONSOLE_LOG",
    domain: "code",
    severity: "P4",
    path: "app.js",
    title: "console.log",
    observedBehavior: "depuração",
    impact: "ruído",
    evidence: "app.js:1",
    suggestedFix: "remover",
    confidence: "high",
    checksRun: [],
    checksSuggested: [],
    uncertainty: "nenhuma",
    status: "approved",
    patch: {
      findingId: "",
      format: "full-file",
      files: ["app.js"],
      content: cleaned,
      riskNotes: [],
      untouchedAssertion: ["soma()"],
    },
    verifierNote: "ok",
    verifierConfidence: "high",
    rejectionReason: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.createFinding(finding);

  try {
    const result = await applyFinding(finding);
    assert.equal(result.applied, true, result.message);
    assert.equal(readFileSync(join(dir, "app.js"), "utf8"), cleaned);
    assert.equal(store.getFinding(finding.id)?.status, "applied");

    const restored = rollbackRun(run.id);
    assert.ok(restored.includes("app.js"));
    assert.equal(readFileSync(join(dir, "app.js"), "utf8"), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("safeResolve rejeita symlink para fora do repositório", () => {
  const dir = mkdtempSync(join(tmpdir(), "ac-symlink-"));
  const outside = join(tmpdir(), `ac-outside-${Date.now()}.txt`);
  writeFileSync(outside, "segredo");
  symlinkSync(outside, join(dir, "link.txt"));
  try {
    assert.throws(() => safeResolve(dir, "link.txt"), /symlink/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});
