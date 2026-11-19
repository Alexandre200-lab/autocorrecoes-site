import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertSafeAuditRoot } from "../src/security/paths.js";

test("assertSafeAuditRoot bloqueia diretórios de sistema e aceita temporários", () => {
  const dir = mkdtempSync(join(tmpdir(), "ac-paths-"));
  try {
    assert.doesNotThrow(() => assertSafeAuditRoot(dir));
    assert.throws(() => assertSafeAuditRoot("/etc"), /sistema/i);
    assert.throws(() => assertSafeAuditRoot("/"), /sistema/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
