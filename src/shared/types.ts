/** Tipos compartilhados por todas as camadas do AutoCorrecoes. */

export type Domain = "design" | "backend" | "code";
export type Severity = "P1" | "P2" | "P3" | "P4";
export type Confidence = "high" | "medium" | "low";

export type FindingStatus =
  | "detected" // sinal bruto coletado pelo auditor determinístico
  | "proposed" // Proposer gerou achado + patch
  | "verified" // Verifier independente confirmou
  | "approved" // humano aprovou
  | "applied" // patch aplicado
  | "reaudited" // re-auditoria rodou
  | "fixed" // re-auditoria confirmou que o sinal desapareceu
  | "rejected" // rejeitado pelo Verifier ou pelo humano
  | "failed"; // falha ao aplicar

export type RunStatus = "running" | "completed" | "failed";
export type TargetType = "url" | "path";

/** Sinal determinístico produzido por um auditor. A IA trabalha em cima dele. */
export interface RawSignal {
  domain: Domain;
  ruleId: string;
  title: string;
  message: string;
  severity: Severity;
  path?: string;
  line?: number;
  url?: string;
  selector?: string;
  evidence: string;
  metadata?: Record<string, unknown>;
}

export interface AuditRun {
  id: string;
  targetType: TargetType;
  target: string;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  baseCommit?: string;
  headCommit?: string;
  signals: RawSignal[];
  error?: string;
  /** Resumo dos checks executados por domínio (para o receipt). */
  checksRun: string[];
  checksNotRun: string[];
}

export type PatchFormat = "unified-diff" | "full-file" | "css-rule" | "config-change";

export interface Patch {
  findingId: string;
  format: PatchFormat;
  files: string[];
  content: string;
  riskNotes: string[];
  /** Arquivos/escopos que deliberadamente NÃO foram alterados. */
  untouchedAssertion: string[];
  /** Caminho do artefato exportado quando o alvo é uma URL (não há filesystem remoto). */
  exportedArtifact?: string;
}

export interface Finding {
  id: string;
  runId: string;
  /** Regra determinística que originou o achado (usada na re-auditoria). */
  sourceRuleId?: string;
  domain: Domain;
  severity: Severity;
  path?: string;
  line?: number;
  url?: string;
  title: string;
  observedBehavior: string;
  impact: string;
  evidence: string;
  suggestedFix: string;
  confidence: Confidence;
  checksRun: string[];
  checksSuggested: string[];
  /** Campo obrigatório: onde a IA não tem certeza. */
  uncertainty: string;
  status: FindingStatus;
  patch: Patch | null;
  verifierNote: string;
  verifierConfidence: Confidence;
  rejectionReason: string;
  createdAt: string;
  updatedAt: string;
}

export interface Receipt {
  id: string;
  runId: string;
  findingId?: string;
  kind: "audit" | "proposal" | "verification" | "approval" | "application" | "reaudit" | "rejection";
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface BudgetState {
  spentUsd: number;
  limitUsd: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export type PipelineEvent =
  | { type: "run:started"; runId: string; target: string }
  | { type: "audit:progress"; runId: string; domain: Domain; count: number }
  | { type: "audit:finished"; runId: string; signals: number }
  | { type: "ai:proposing"; runId: string }
  | { type: "ai:verifying"; runId: string }
  | { type: "finding:created"; runId: string; findingId: string; status: FindingStatus }
  | { type: "finding:updated"; runId: string; findingId: string; status: FindingStatus }
  | { type: "run:finished"; runId: string }
  | { type: "error"; runId?: string; message: string };

export interface AuditOptions {
  type?: TargetType;
  domains?: Domain[];
  useAI?: boolean;
  /** Executa verificações mutantes em URLs (desligado por padrão). */
  allowMutatingRequests?: boolean;
  maxPages?: number;
}
