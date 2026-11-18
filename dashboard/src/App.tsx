import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Severity = "P1" | "P2" | "P3" | "P4";
type FindingStatus =
  | "detected"
  | "proposed"
  | "verified"
  | "approved"
  | "applied"
  | "reaudited"
  | "fixed"
  | "rejected"
  | "failed";

interface Patch {
  format: string;
  files: string[];
  content: string;
  riskNotes: string[];
  untouchedAssertion: string[];
  exportedArtifact?: string;
}

interface Finding {
  id: string;
  sourceRuleId?: string;
  domain: string;
  severity: Severity;
  path?: string;
  line?: number;
  url?: string;
  title: string;
  observedBehavior: string;
  impact: string;
  evidence: string;
  suggestedFix: string;
  confidence: string;
  checksRun: string[];
  checksSuggested: string[];
  uncertainty: string;
  status: FindingStatus;
  patch: Patch | null;
  verifierNote: string;
  rejectionReason: string;
}

interface Run {
  id: string;
  targetType: string;
  target: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  signals: unknown[];
  checksRun: string[];
  checksNotRun: string[];
}

interface Receipt {
  id: string;
  kind: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

interface PipelineEvent {
  type: string;
  eventId?: number;
  runId?: string;
  jobId?: string;
  findingId?: string;
  message?: string;
  domain?: string;
  count?: number;
}

const STATUS_LABEL: Record<FindingStatus, string> = {
  detected: "Detectado",
  proposed: "Proposto",
  verified: "Verificado",
  approved: "Aprovado",
  applied: "Aplicado",
  reaudited: "Re-auditado",
  fixed: "Corrigido",
  rejected: "Rejeitado",
  failed: "Falhou",
};

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("autocorrecoes_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}

function time(value: string): string {
  return value.replace("T", " ").slice(0, 19);
}

export default function App() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"all" | FindingStatus>("all");
  const [token, setToken] = useState(() => localStorage.getItem("autocorrecoes_token") ?? "");
  const [tokenInput, setTokenInput] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const lastEventIdRef = useRef(0);
  const currentJobIdRef = useRef<string | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      const data = await getJson<{ runs: Run[] }>("/api/runs");
      setRuns(data.runs);
      setRunId((current) => current ?? data.runs[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadRun = useCallback(async (id: string) => {
    try {
      const data = await getJson<{
        run: Run;
        findings: Finding[];
        receipts: Receipt[];
      }>(`/api/runs/${id}`);
      setRun(data.run);
      setFindings(data.findings);
      setReceipts(data.receipts);
      setSelectedId((current) => current ?? data.findings[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    fetch("/api/config")
      .then((response) => response.json())
      .then((data: { authRequired?: boolean }) => setAuthRequired(Boolean(data.authRequired)))
      .catch(() => undefined);
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (runId) void loadRun(runId);
  }, [runId, loadRun]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (token) params.set("token", token);
    if (runId) params.set("runId", runId);
    if (lastEventIdRef.current) params.set("afterId", String(lastEventIdRef.current));
    const query = params.toString();
    const source = new EventSource(`/api/events${query ? `?${query}` : ""}`);
    source.onmessage = (message) => {
      let event: PipelineEvent;
      try {
        event = JSON.parse(message.data) as PipelineEvent;
      } catch {
        return;
      }
      if (event.eventId) {
        if (event.eventId <= lastEventIdRef.current) return; // dedupe do replay
        lastEventIdRef.current = event.eventId;
      }
      setEvents((current) => [...current.slice(-60), `${time(new Date().toISOString())}  ${event.type}`]);
      if (event.type === "error" && event.message) setError(event.message);
      if (event.type === "run:started" || event.type === "run:finished") void loadRuns();
      if (event.type === "job:finished" && event.jobId === currentJobIdRef.current && event.runId) {
        setRunId(event.runId);
        void loadRuns();
        setBusy(false);
      }
      if (
        event.runId &&
        event.runId === runId &&
        ["finding:created", "finding:updated", "audit:finished", "run:finished"].includes(event.type)
      ) {
        void loadRun(event.runId);
      }
    };
    return () => source.close();
  }, [runId, token, loadRuns, loadRun]);

  const startAudit = async () => {
    if (!target.trim()) return;
    setBusy(true);
    setError("");
    const previous = runs[0]?.id;
    try {
      const response = await postJson<{ jobId: string }>("/api/audit", { target: target.trim() });
      currentJobIdRef.current = response.jobId;
      setEvents((current) => [
        ...current,
        `${time(new Date().toISOString())}  job:queued ${response.jobId}`,
      ]);
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const data = await getJson<{ runs: Run[] }>("/api/runs");
        setRuns(data.runs);
        const newest = data.runs[0];
        if (newest && newest.id !== previous) {
          setRunId(newest.id);
          break;
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (id: string, status: "approved" | "rejected") => {
    await postJson(`/api/findings/${id}/${status}`, { reason: "Decisão registrada no dashboard" });
    if (runId) await loadRun(runId);
  };

  const applyAll = async () => {
    setBusy(true);
    try {
      const result = await postJson<{
        results: Array<{ findingId: string; applied: boolean; message: string }>;
      }>("/api/apply", { runId, reaudit: true });
      setEvents((current) => [
        ...current,
        ...result.results.map((r) => `${time(new Date().toISOString())}  apply ${r.findingId}: ${r.applied ? "OK" : "FALHA"}`),
      ]);
      if (runId) await loadRun(runId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const selected = useMemo(
    () => findings.find((f) => f.id === selectedId) ?? null,
    [findings, selectedId],
  );
  const filtered = useMemo(
    () => (filter === "all" ? findings : findings.filter((f) => f.status === filter)),
    [findings, filter],
  );
  const counts = useMemo(() => {
    const result: Record<string, number> = {};
    for (const f of findings) result[f.status] = (result[f.status] ?? 0) + 1;
    return result;
  }, [findings]);

  return (
    <div className="app">
      <header>
        <div>
          <h1>AutoCorrecoes</h1>
          <p>Auditoria e autocorreção com fiscalização independente por DeepSeek</p>
        </div>
        <span className="pill">v1.0</span>
      </header>

      {authRequired && !token && (
        <section className="panel login">
          <h2>Acesso ao painel</h2>
          <p className="muted">Esta instância exige o token definido em API_TOKEN.</p>
          <input
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || !tokenInput.trim()) return;
              localStorage.setItem("autocorrecoes_token", tokenInput.trim());
              setToken(tokenInput.trim());
              setError("");
            }}
            placeholder="API_TOKEN"
            aria-label="Token de acesso"
          />
          <button
            onClick={() => {
              if (!tokenInput.trim()) return;
              localStorage.setItem("autocorrecoes_token", tokenInput.trim());
              setToken(tokenInput.trim());
              setError("");
            }}
          >
            Entrar
          </button>
        </section>
      )}

      <section className="new-audit panel">
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void startAudit()}
          placeholder="https://exemplo.com  ou  ./meu-projeto"
          aria-label="Alvo da auditoria"
        />
        <button onClick={() => void startAudit()} disabled={busy}>
          {busy ? "Auditando…" : "Nova auditoria"}
        </button>
      </section>

      {error && <div className="error">{error}</div>}

      <div className="layout">
        <aside className="panel">
          <h2>Execuções</h2>
          <div className="run-list">
            {runs.map((item) => (
              <button
                key={item.id}
                className={`run-item ${item.id === runId ? "active" : ""}`}
                onClick={() => setRunId(item.id)}
              >
                <strong>{item.targetType === "url" ? "🌐" : "📁"} {item.target}</strong>
                <small>
                  {item.id} · {item.status} · {time(item.startedAt)}
                </small>
              </button>
            ))}
            {!runs.length && <p className="muted">Nenhuma auditoria ainda.</p>}
          </div>
        </aside>

        <main className="panel">
          <div className="section-head">
            <h2>Achados {findings.length > 0 && <span className="count">{findings.length}</span>}</h2>
            <div className="actions">
              <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
                <option value="all">Todos</option>
                {Object.keys(STATUS_LABEL).map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABEL[status as FindingStatus]} ({counts[status] ?? 0})
                  </option>
                ))}
              </select>
              <button className="primary" onClick={() => void applyAll()} disabled={busy}>
                Aplicar aprovados + re-auditar
              </button>
            </div>
          </div>

          <div className="findings">
            {filtered.map((finding) => (
              <article
                key={finding.id}
                className={`finding ${finding.id === selectedId ? "selected" : ""} sev-${finding.severity}`}
                onClick={() => setSelectedId(finding.id)}
              >
                <div className="finding-top">
                  <span className={`severity sev-${finding.severity}`}>{finding.severity}</span>
                  <span className={`status status-${finding.status}`}>
                    {STATUS_LABEL[finding.status]}
                  </span>
                  <span className="domain">{finding.domain}</span>
                  <small>{finding.id}</small>
                </div>
                <h3>{finding.title}</h3>
                <p className="location">
                  {finding.path
                    ? `${finding.path}${finding.line ? `:${finding.line}` : ""}`
                    : finding.url ?? "—"}
                </p>
                <p>{finding.observedBehavior}</p>
                {finding.verifierNote && (
                  <p className="verifier">
                    <strong>Verificador:</strong> {finding.verifierNote}
                  </p>
                )}
                {finding.status !== "fixed" && finding.status !== "rejected" && (
                  <div className="finding-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="approve"
                      onClick={() => void setStatus(finding.id, "approved")}
                      disabled={finding.status === "approved"}
                    >
                      Aprovar
                    </button>
                    <button onClick={() => void setStatus(finding.id, "rejected")}>Rejeitar</button>
                  </div>
                )}
              </article>
            ))}
            {!filtered.length && <p className="muted">Nenhum achado para este filtro.</p>}
          </div>
        </main>

        <aside className="panel details">
          <h2>Detalhes</h2>
          {selected ? (
            <div className="detail-content">
              <h3>{selected.title}</h3>
              <dl>
                <dt>Impacto</dt>
                <dd>{selected.impact}</dd>
                <dt>Evidência</dt>
                <dd><pre>{selected.evidence}</pre></dd>
                <dt>Correção sugerida</dt>
                <dd>{selected.suggestedFix}</dd>
                <dt>Incerteza</dt>
                <dd className="muted">{selected.uncertainty}</dd>
                <dt>Checks executados</dt>
                <dd>{selected.checksRun.join(", ") || "nenhum"}</dd>
                <dt>Checks sugeridos</dt>
                <dd>{selected.checksSuggested.join(", ") || "nenhum"}</dd>
              </dl>
              {selected.patch && (
                <details open>
                  <summary>
                    Patch · {selected.patch.format} · {selected.patch.files.join(", ")}
                  </summary>
                  <pre className="patch">{selected.patch.content}</pre>
                  {selected.patch.riskNotes.length > 0 && (
                    <p className="muted">Riscos: {selected.patch.riskNotes.join("; ")}</p>
                  )}
                  <p className="muted">
                    Não alterado: {selected.patch.untouchedAssertion.join("; ") || "não informado"}
                  </p>
                </details>
              )}
              {selected.rejectionReason && <p className="error">{selected.rejectionReason}</p>}
            </div>
          ) : (
            <p className="muted">Selecione um achado.</p>
          )}

          <h2 className="mt">Audit trail</h2>
          <div className="receipts">
            {receipts.slice(-12).reverse().map((receipt) => (
              <div key={receipt.id} className="receipt">
                <span className="pill small">{receipt.kind}</span>
                <small>{time(receipt.createdAt)}</small>
              </div>
            ))}
            {!receipts.length && <p className="muted">Sem eventos registrados.</p>}
          </div>

          <h2 className="mt">Eventos ao vivo</h2>
          <div className="event-log">
            {events.slice(-15).reverse().map((event, index) => (
              <div key={`${event}-${index}`}>{event}</div>
            ))}
          </div>

          {run && (
            <div className="run-meta">
              <h2 className="mt">Execução</h2>
              <p><small>{run.id}</small></p>
              <p>Sinais: {run.signals.length}</p>
              <p>Checks não executados: {run.checksNotRun.join(", ") || "nenhum"}</p>
              {run.error && <p className="error">{run.error}</p>}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
