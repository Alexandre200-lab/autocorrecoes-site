import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config/index.js";
import { runMigrations } from "./migrations.js";
import type {
  AuditRun,
  Finding,
  Job,
  Patch,
  RawSignal,
  Receipt,
  RunStatus,
  StoredEvent,
  TargetType,
} from "../shared/types.js";

mkdirSync(config.dataDir, { recursive: true });

const db = new DatabaseSync(join(config.dataDir, "autocorrecoes.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

runMigrations(db);

function parse<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

type RunRow = {
  id: string;
  target_type: string;
  target: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  base_commit: string | null;
  head_commit: string | null;
  error: string | null;
  checks_run: string;
  checks_not_run: string;
};

type FindingRow = {
  id: string;
  run_id: string;
  source_rule_id: string | null;
  domain: AuditRun["signals"][number]["domain"];
  severity: Finding["severity"];
  path: string | null;
  line: number | null;
  url: string | null;
  title: string;
  observed_behavior: string;
  impact: string;
  evidence: string;
  suggested_fix: string;
  confidence: Finding["confidence"];
  checks_run: string;
  checks_suggested: string;
  uncertainty: string;
  status: Finding["status"];
  patch: string | null;
  verifier_note: string;
  verifier_confidence: Finding["confidence"];
  rejection_reason: string;
  created_at: string;
  updated_at: string;
};

function toRun(row: RunRow, signals: RawSignal[]): AuditRun {
  return {
    id: row.id,
    targetType: row.target_type as AuditRun["targetType"],
    target: row.target,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    status: row.status as RunStatus,
    baseCommit: row.base_commit ?? undefined,
    headCommit: row.head_commit ?? undefined,
    error: row.error ?? undefined,
    checksRun: parse<string[]>(row.checks_run, []),
    checksNotRun: parse<string[]>(row.checks_not_run, []),
    signals,
  };
}

function toFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    runId: row.run_id,
    sourceRuleId: row.source_rule_id ?? undefined,
    domain: row.domain,
    severity: row.severity,
    path: row.path ?? undefined,
    line: row.line ?? undefined,
    url: row.url ?? undefined,
    title: row.title,
    observedBehavior: row.observed_behavior,
    impact: row.impact,
    evidence: row.evidence,
    suggestedFix: row.suggested_fix,
    confidence: row.confidence,
    checksRun: parse<string[]>(row.checks_run, []),
    checksSuggested: parse<string[]>(row.checks_suggested, []),
    uncertainty: row.uncertainty,
    status: row.status,
    patch: parse<Patch | null>(row.patch, null),
    verifierNote: row.verifier_note,
    verifierConfidence: row.verifier_confidence,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const store = {
  /** Agrupa escritas relacionadas (status + receipt) em uma única transação. */
  transaction<T>(fn: () => T): T {
    db.exec("BEGIN");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },

  createRun(run: AuditRun): void {
    db.prepare(
      `INSERT INTO runs (id, target_type, target, started_at, status, base_commit, head_commit, checks_run, checks_not_run)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      run.id,
      run.targetType,
      run.target,
      run.startedAt,
      run.status,
      run.baseCommit ?? null,
      run.headCommit ?? null,
      JSON.stringify(run.checksRun),
      JSON.stringify(run.checksNotRun),
    );
  },

  updateRun(
    id: string,
    patch: Partial<Pick<AuditRun, "status" | "finishedAt" | "error" | "checksRun" | "checksNotRun">>,
  ): void {
    const current = db.prepare("SELECT checks_run, checks_not_run FROM runs WHERE id = ?").get(id) as
      | { checks_run: string; checks_not_run: string }
      | undefined;
    if (!current) return;
    db.prepare(
      `UPDATE runs SET status = ?, finished_at = ?, error = ?, checks_run = ?, checks_not_run = ? WHERE id = ?`,
    ).run(
      patch.status ?? "completed",
      patch.finishedAt ??
        (patch.status && patch.status !== "running" ? new Date().toISOString() : null),
      patch.error ?? null,
      JSON.stringify(patch.checksRun ?? parse(current.checks_run, [])),
      JSON.stringify(patch.checksNotRun ?? parse(current.checks_not_run, [])),
      id,
    );
  },

  getRun(id: string): AuditRun | null {
    const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    if (!row) return null;
    return toRun(row, this.listSignals(id));
  },

  listRuns(limit = 50): AuditRun[] {
    const rows = db
      .prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?")
      .all(limit) as RunRow[];
    return rows.map((row) => toRun(row, []));
  },

  latestRun(): AuditRun | null {
    const row = db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 1").get() as
      | RunRow
      | undefined;
    return row ? toRun(row, this.listSignals(row.id)) : null;
  },

  insertSignal(runId: string, signal: RawSignal): void {
    db.prepare(
      `INSERT INTO signals (run_id, domain, rule_id, title, message, severity, path, line, url, selector, evidence, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      signal.domain,
      signal.ruleId,
      signal.title,
      signal.message,
      signal.severity,
      signal.path ?? null,
      signal.line ?? null,
      signal.url ?? null,
      signal.selector ?? null,
      signal.evidence,
      JSON.stringify(signal.metadata ?? {}),
    );
  },

  listSignals(runId: string): RawSignal[] {
    const rows = db
      .prepare("SELECT * FROM signals WHERE run_id = ? ORDER BY id")
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      domain: row.domain as RawSignal["domain"],
      ruleId: String(row.rule_id),
      title: String(row.title),
      message: String(row.message),
      severity: row.severity as RawSignal["severity"],
      path: (row.path as string | null) ?? undefined,
      line: (row.line as number | null) ?? undefined,
      url: (row.url as string | null) ?? undefined,
      selector: (row.selector as string | null) ?? undefined,
      evidence: String(row.evidence),
      metadata: parse<Record<string, unknown>>(row.metadata, {}),
    }));
  },

  createFinding(finding: Finding): void {
    db.prepare(
      `INSERT OR REPLACE INTO findings (
        id, run_id, source_rule_id, domain, severity, path, line, url, title, observed_behavior, impact,
        evidence, suggested_fix, confidence, checks_run, checks_suggested, uncertainty,
        status, patch, verifier_note, verifier_confidence, rejection_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      finding.id,
      finding.runId,
      finding.sourceRuleId ?? null,
      finding.domain,
      finding.severity,
      finding.path ?? null,
      finding.line ?? null,
      finding.url ?? null,
      finding.title,
      finding.observedBehavior,
      finding.impact,
      finding.evidence,
      finding.suggestedFix,
      finding.confidence,
      JSON.stringify(finding.checksRun),
      JSON.stringify(finding.checksSuggested),
      finding.uncertainty,
      finding.status,
      finding.patch ? JSON.stringify(finding.patch) : null,
      finding.verifierNote,
      finding.verifierConfidence,
      finding.rejectionReason,
      finding.createdAt,
      finding.updatedAt,
    );
  },

  getFinding(id: string): Finding | null {
    const row = db.prepare("SELECT * FROM findings WHERE id = ?").get(id) as FindingRow | undefined;
    return row ? toFinding(row) : null;
  },

  listFindings(filter: { runId?: string; status?: Finding["status"]; limit?: number } = {}): Finding[] {
    const clauses: string[] = [];
    const params: Array<string | number | null> = [];
    if (filter.runId) {
      clauses.push("run_id = ?");
      params.push(filter.runId);
    }
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(filter.limit ?? 200);
    const rows = db
      .prepare(`SELECT * FROM findings ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as FindingRow[];
    return rows.map(toFinding);
  },

  updateFinding(
    id: string,
    patch: Partial<
      Pick<
        Finding,
        | "status"
        | "patch"
        | "verifierNote"
        | "verifierConfidence"
        | "rejectionReason"
        | "severity"
      >
    >,
  ): Finding | null {
    const current = this.getFinding(id);
    if (!current) return null;
    const next: Finding = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.createFinding(next);
    return next;
  },

  addReceipt(receipt: Receipt): void {
    db.prepare(
      "INSERT OR REPLACE INTO receipts (id, run_id, finding_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      receipt.id,
      receipt.runId,
      receipt.findingId ?? null,
      receipt.kind,
      JSON.stringify(receipt.payload),
      receipt.createdAt,
    );
  },

  listReceipts(runId?: string): Receipt[] {
    const rows = (runId
      ? db.prepare("SELECT * FROM receipts WHERE run_id = ? ORDER BY created_at").all(runId)
      : db.prepare("SELECT * FROM receipts ORDER BY created_at LIMIT 500").all()) as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      id: String(row.id),
      runId: String(row.run_id),
      findingId: (row.finding_id as string | null) ?? undefined,
      kind: row.kind as Receipt["kind"],
      payload: parse<Record<string, unknown>>(row.payload, {}),
      createdAt: String(row.created_at),
    }));
  },

  // ---- Fila durável -------------------------------------------------------

  enqueueJob(job: Job): void {
    db.prepare(
      `INSERT INTO jobs (id, target, options, status, attempts, max_attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      job.id,
      job.target,
      JSON.stringify(job.options),
      "queued",
      0,
      job.maxAttempts ?? 3,
      job.createdAt,
    );
  },

  claimNextJob(): Job | null {
    return this.transaction(() => {
      const row = db
        .prepare(
          `SELECT * FROM jobs
           WHERE status = 'queued' AND dead_letter = 0
             AND (next_run_at IS NULL OR next_run_at <= ?)
           ORDER BY created_at LIMIT 1`,
        )
        .get(new Date().toISOString()) as Record<string, unknown> | undefined;
      if (!row) return null;
      db.prepare(
        "UPDATE jobs SET status = 'running', started_at = ?, next_run_at = NULL, attempts = attempts + 1 WHERE id = ?",
      ).run(new Date().toISOString(), String(row.id));
      return {
        id: String(row.id),
        target: String(row.target),
        options: parse<Job["options"]>(row.options, {}),
        status: "running" as const,
        attempts: Number(row.attempts) + 1,
        maxAttempts: Number(row.max_attempts ?? 3),
        createdAt: String(row.created_at),
        startedAt: new Date().toISOString(),
      };
    });
  },

  updateJob(
    id: string,
    patch: Partial<
      Pick<Job, "status" | "runId" | "error" | "finishedAt" | "nextRunAt" | "deadLetter">
    >,
  ): void {
    const current = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!current) return;
    const now = new Date().toISOString();
    const finishedAt =
      patch.finishedAt ??
      (patch.status === "done" || patch.status === "failed"
        ? now
        : (current.finished_at as string | null));
    db.prepare(
      `UPDATE jobs SET status = ?, run_id = ?, error = ?, finished_at = ?,
        next_run_at = ?, dead_letter = ? WHERE id = ?`,
    ).run(
      patch.status ?? String(current.status),
      patch.runId ?? (current.run_id as string | null),
      patch.error ?? (current.error as string | null),
      finishedAt,
      patch.nextRunAt ?? (current.next_run_at as string | null),
      patch.deadLetter === undefined
        ? Number(current.dead_letter ?? 0)
        : patch.deadLetter
          ? 1
          : 0,
      id,
    );
  },

  /** Reabre um job da dead-letter com orçamento de tentativas renovado. */
  retryJob(id: string): boolean {
    const result = db
      .prepare(
        `UPDATE jobs SET status = 'queued', dead_letter = 0, next_run_at = NULL,
          attempts = 0, error = NULL, started_at = NULL, finished_at = NULL WHERE id = ?`,
      )
      .run(id);
    return Number(result.changes ?? 0) > 0;
  },

  getJob(id: string): Job | null {
    const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.toJob(row) : null;
  },

  listJobs(limit = 50, deadLetter?: boolean): Job[] {
    const rows = (
      deadLetter === undefined
        ? db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit)
        : db
            .prepare("SELECT * FROM jobs WHERE dead_letter = ? ORDER BY created_at DESC LIMIT ?")
            .all(deadLetter ? 1 : 0, limit)
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => this.toJob(row));
  },

  /** Reconcilia jobs órfãos de um processo anterior. */
  recoverJobs(): number {
    const result = db
      .prepare("UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'running'")
      .run();
    return Number(result.changes ?? 0);
  },

  toJob(row: Record<string, unknown>): Job {
    return {
      id: String(row.id),
      target: String(row.target),
      options: parse<Job["options"]>(row.options, {}),
      status: row.status as Job["status"],
      runId: (row.run_id as string | null) ?? undefined,
      error: (row.error as string | null) ?? undefined,
      attempts: Number(row.attempts ?? 0),
      maxAttempts: Number(row.max_attempts ?? 3),
      nextRunAt: (row.next_run_at as string | null) ?? undefined,
      deadLetter: Number(row.dead_letter ?? 0) === 1,
      createdAt: String(row.created_at),
      startedAt: (row.started_at as string | null) ?? undefined,
      finishedAt: (row.finished_at as string | null) ?? undefined,
    };
  },

  // ---- Eventos persistidos ------------------------------------------------

  insertEvent(event: { runId?: string; type: string; payload: Record<string, unknown> }): StoredEvent {
    const createdAt = new Date().toISOString();
    const result = db
      .prepare("INSERT INTO events (run_id, type, payload, created_at) VALUES (?, ?, ?, ?)")
      .run(event.runId ?? null, event.type, JSON.stringify(event.payload), createdAt);
    return {
      id: Number(result.lastInsertRowid),
      runId: event.runId,
      type: event.type,
      payload: event.payload,
      createdAt,
    };
  },

  listEvents(filter: { runId?: string; afterId?: number; limit?: number } = {}): StoredEvent[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.runId) {
      clauses.push("run_id = ?");
      params.push(filter.runId);
    }
    if (filter.afterId) {
      clauses.push("id > ?");
      params.push(filter.afterId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(filter.limit ?? 500);
    const rows = db
      .prepare(`SELECT * FROM events ${where} ORDER BY id ASC LIMIT ?`)
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id),
      runId: (row.run_id as string | null) ?? undefined,
      type: String(row.type),
      payload: parse<Record<string, unknown>>(row.payload, {}),
      createdAt: String(row.created_at),
    }));
  },

  maxEventId(): number {
    const row = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events").get() as { id: number };
    return Number(row.id);
  },

  // ---- Agendamento e comparação ------------------------------------------

  listDistinctTargets(limit = 100): Array<{ target: string; targetType: TargetType }> {
    const rows = db
      .prepare(
        "SELECT target, target_type FROM runs GROUP BY target, target_type ORDER BY MAX(started_at) DESC LIMIT ?",
      )
      .all(limit) as Array<{ target: string; target_type: string }>;
    return rows.map((row) => ({ target: row.target, targetType: row.target_type as TargetType }));
  },

  hasRecentJob(target: string, sinceIso: string): boolean {
    const row = db
      .prepare("SELECT 1 FROM jobs WHERE target = ? AND created_at >= ? LIMIT 1")
      .get(target, sinceIso);
    return Boolean(row);
  },

  previousRun(run: AuditRun): AuditRun | null {
    const row = db
      .prepare(
        "SELECT * FROM runs WHERE target = ? AND id != ? AND started_at < ? ORDER BY started_at DESC LIMIT 1",
      )
      .get(run.target, run.id, run.startedAt) as RunRow | undefined;
    return row ? toRun(row, this.listSignals(row.id)) : null;
  },
};

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}
