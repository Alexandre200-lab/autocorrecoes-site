import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { migrations, runMigrations } from "../src/storage/migrations.js";

test("migração adiciona source_rule_id sem perder dados existentes", () => {
  const dir = mkdtempSync(join(tmpdir(), "ac-migrate-"));
  const db = new DatabaseSync(join(dir, "legacy.db"));
  try {
    // Simula um banco criado antes da coluna de proveniência existir.
    migrations[0].up(db);
    db.prepare(
      `INSERT INTO runs (id, target_type, target, started_at, status)
       VALUES ('r1', 'path', '/tmp/legacy', '2026-01-01', 'completed')`,
    ).run();
    db.prepare(
      `INSERT INTO findings (id, run_id, domain, severity, title, observed_behavior, impact,
        evidence, suggested_fix, confidence, uncertainty, status, created_at, updated_at)
       VALUES ('f1', 'r1', 'code', 'P4', 'antigo', 'a', 'b', 'c', 'd', 'high', 'n', 'proposed',
        '2026-01-01', '2026-01-01')`,
    ).run();

    runMigrations(db);
    runMigrations(db); // idempotente

    const columns = db.prepare("PRAGMA table_info(findings)").all() as Array<{ name: string }>;
    assert.ok(columns.some((c) => c.name === "source_rule_id"));
    const row = db.prepare("SELECT id, source_rule_id FROM findings WHERE id = 'f1'").get() as {
      id: string;
      source_rule_id: string | null;
    };
    assert.equal(row.id, "f1");
    assert.equal(row.source_rule_id, null);
    const applied = db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number };
    assert.equal(applied.n, 4);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
