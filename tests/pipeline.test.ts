import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAudit } from "../src/pipeline/index.js";

test("auditoria local funciona sem chave de IA", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autocorrecoes-"));
  writeFileSync(
    join(dir, "index.js"),
    'const apiKey = "supersecretvalue123";\nconsole.log(apiKey);\n// TODO: remover\n',
  );

  try {
    const outcome = await runAudit(dir, { type: "path", useAI: false });
    const rules = outcome.run.signals.map((s) => s.ruleId);
    assert.ok(rules.includes("POSSIBLE_HARDCODED_SECRET"), rules.join(", "));
    assert.ok(rules.includes("CONSOLE_LOG"));
    assert.ok(rules.includes("TODO_MARKER"));
    assert.equal(outcome.findings.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
