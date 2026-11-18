import assert from "node:assert/strict";
import test from "node:test";
import { diffRuns } from "../src/pipeline/diff.js";
import type { AuditRun, RawSignal } from "../src/shared/types.js";

const signal = (ruleId: string, evidence: string): RawSignal => ({
  domain: "code",
  ruleId,
  title: ruleId,
  message: "mensagem",
  severity: "P2",
  path: "app.js",
  evidence,
});

function run(id: string, signals: RawSignal[]): AuditRun {
  return {
    id,
    targetType: "path",
    target: "/tmp/projeto",
    startedAt: new Date().toISOString(),
    status: "completed",
    signals,
    checksRun: [],
    checksNotRun: [],
  };
}

test("diff separa introduzidos, corrigidos e persistentes", () => {
  const a = signal("REGRA_A", "evidência A");
  const b = signal("REGRA_B", "evidência B");
  const c = signal("REGRA_C", "evidência C");

  const diff = diffRuns(run("anterior", [a, b]), run("atual", [b, c]));
  assert.equal(diff.previousId, "anterior");
  assert.equal(diff.currentId, "atual");
  assert.deepEqual(diff.introduced.map((s) => s.ruleId), ["REGRA_C"]);
  assert.deepEqual(diff.fixed.map((s) => s.ruleId), ["REGRA_A"]);
  assert.deepEqual(diff.persisting.map((s) => s.ruleId), ["REGRA_B"]);
});

test("diff com execução anterior ausente marca tudo como introduzido", () => {
  const diff = diffRuns(null, run("atual", [signal("REGRA_A", "x")]));
  assert.equal(diff.introduced.length, 1);
  assert.equal(diff.fixed.length, 0);
});
