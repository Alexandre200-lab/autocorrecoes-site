import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applySeverityOverride,
  isIgnored,
  loadProjectConfig,
  resolveStorageState,
  ruleAction,
} from "../src/config/project.js";
import { splitByBaseline, fingerprint } from "../src/pipeline/fingerprint.js";
import type { RawSignal } from "../src/shared/types.js";

test("configuração de projeto é lida e validada", () => {
  const dir = mkdtempSync(join(tmpdir(), "ac-project-"));
  writeFileSync(
    join(dir, ".autocorrecoes.yml"),
    [
      "version: 1",
      "ignore:",
      "  - '**/generated/**'",
      "rules:",
      "  CONSOLE_LOG: P1",
      "  TODO_MARKER: 'off'",
      "headers:",
      "  X-Test: 'sim'",
      "baseline:",
      "  fingerprints: [abc123]",
    ].join("\n"),
  );
  try {
    const config = loadProjectConfig(dir);
    assert.equal(config.rules.CONSOLE_LOG, "P1");
    assert.equal(ruleAction(config, "TODO_MARKER"), "off");
    assert.equal(config.headers["X-Test"], "sim");
    assert.deepEqual(config.baseline.fingerprints, ["abc123"]);
    assert.equal(applySeverityOverride("P4", "CONSOLE_LOG", config), "P1");
    assert.equal(applySeverityOverride("P4", "DESCONHECIDA", config), "P4");
    assert.equal(resolveStorageState({ auth: {} }, dir), undefined);
    writeFileSync(join(dir, "auth.json"), "{}");
    assert.equal(
      resolveStorageState({ auth: { storageState: "auth.json" } }, dir),
      join(dir, "auth.json"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("globs ignoram paths corretamente", () => {
  const patterns = ["**/generated/**", "src/tmp/*.js", "https://exemplo.com/legal/**"];
  assert.equal(isIgnored("src/generated/foo.ts", patterns), true);
  assert.equal(isIgnored("generated/foo.ts", patterns), true);
  assert.equal(isIgnored("src/tmp/a.js", patterns), true);
  assert.equal(isIgnored("src/app.ts", patterns), false);
  assert.equal(isIgnored("https://exemplo.com/legal/termos", patterns), true);
});

test("baseline suprime apenas fingerprints conhecidos", () => {
  const signal: RawSignal = {
    domain: "code",
    ruleId: "CONSOLE_LOG",
    title: "console",
    message: "msg",
    severity: "P4",
    path: "app.js",
    line: 1,
    evidence: "app.js:1 console.log(123)",
  };
  const id = fingerprint(signal);
  const changed = { ...signal, evidence: "app.js:1 console.log(999)" };
  assert.equal(fingerprint(changed), id, "números não devem alterar o fingerprint");

  const result = splitByBaseline(
    [signal, { ...signal, ruleId: "TODO_MARKER" }],
    [id],
  );
  assert.equal(result.suppressed.length, 1);
  assert.equal(result.kept.length, 1);
});
