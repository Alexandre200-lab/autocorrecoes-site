import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "baseline",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          target_type TEXT NOT NULL,
          target TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          status TEXT NOT NULL,
          base_commit TEXT,
          head_commit TEXT,
          error TEXT,
          checks_run TEXT NOT NULL DEFAULT '[]',
          checks_not_run TEXT NOT NULL DEFAULT '[]'
        );

        CREATE TABLE IF NOT EXISTS signals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          domain TEXT NOT NULL,
          rule_id TEXT NOT NULL,
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          severity TEXT NOT NULL,
          path TEXT,
          line INTEGER,
          url TEXT,
          selector TEXT,
          evidence TEXT NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS findings (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          domain TEXT NOT NULL,
          severity TEXT NOT NULL,
          path TEXT,
          line INTEGER,
          url TEXT,
          title TEXT NOT NULL,
          observed_behavior TEXT NOT NULL,
          impact TEXT NOT NULL,
          evidence TEXT NOT NULL,
          suggested_fix TEXT NOT NULL,
          confidence TEXT NOT NULL,
          checks_run TEXT NOT NULL DEFAULT '[]',
          checks_suggested TEXT NOT NULL DEFAULT '[]',
          uncertainty TEXT NOT NULL,
          status TEXT NOT NULL,
          patch TEXT,
          verifier_note TEXT NOT NULL DEFAULT '',
          verifier_confidence TEXT NOT NULL DEFAULT 'low',
          rejection_reason TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS receipts (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          finding_id TEXT,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_signals_run ON signals(run_id);
        CREATE INDEX IF NOT EXISTS idx_findings_run ON findings(run_id);
        CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status);
        CREATE INDEX IF NOT EXISTS idx_receipts_run ON receipts(run_id);
      `);
    },
  },
  {
    version: 2,
    name: "finding-provenance",
    up(db) {
      if (!columnExists(db, "findings", "source_rule_id")) {
        db.exec("ALTER TABLE findings ADD COLUMN source_rule_id TEXT");
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_findings_source ON findings(source_rule_id)");
    },
  },
];

export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map(
      (row) => row.version,
    ),
  );
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN");
    try {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
