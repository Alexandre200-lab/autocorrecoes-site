import { config } from "../../config/index.js";
import { assertPublicUrl } from "../../security/network.js";
import { redactSecrets } from "../../security/redact.js";
import type { AuditOptions, RawSignal } from "../../shared/types.js";
import type { AuditContext, AuditResult, Auditor } from "../types.js";

const SECURITY_HEADERS: Array<[string, string, RawSignal["severity"], string]> = [
  ["content-security-policy", "CSP ausente", "P2", "Permite execução de scripts injetados e carregamento de recursos arbitrários."],
  ["strict-transport-security", "HSTS ausente", "P2", "Conexões HTTP podem ser forçadas em navegadores que já visitaram o site."],
  ["x-content-type-options", "X-Content-Type-Options ausente", "P3", "Navegador pode fazer MIME sniffing."],
  ["x-frame-options", "X-Frame-Options/CSP frame-ancestors ausente", "P3", "Página pode ser incorporada em iframe (clickjacking)."],
  ["referrer-policy", "Referrer-Policy ausente", "P4", "URLs completas podem vazar como referrer."],
];

interface Probe {
  status: number;
  headers: Headers;
  latencyMs: number;
  bodySnippet: string;
}

async function probe(url: string, method = "GET"): Promise<Probe> {
  const started = performance.now();
  const response = await fetch(url, {
    method,
    redirect: "follow",
    signal: AbortSignal.timeout(Math.min(config.AUDIT_TIMEOUT_MS, 20_000)),
    headers: { "User-Agent": "AutoCorrecoes/1.0 (auditoria)" },
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    latencyMs: Math.round(performance.now() - started),
    bodySnippet: redactSecrets(text.slice(0, 2000)),
  };
}


export class BackendAuditor implements Auditor {
  readonly domain = "backend" as const;

  async audit(target: string, options: AuditOptions, ctx: AuditContext): Promise<AuditResult> {
    const signals: RawSignal[] = [];
    const checksRun: string[] = [];
    const checksNotRun: string[] = [];
    let url: string;
    try {
      url = (await assertPublicUrl(target, options.allowPrivateHosts)).toString();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      signals.push({
        domain: "backend",
        ruleId: "BACKEND_BLOCKED_HOST",
        title: "Host bloqueado pela proteção SSRF",
        message,
        severity: "P2",
        evidence: message,
        metadata: { error: true, requiresHuman: true },
      });
      checksNotRun.push("HTTP GET (host bloqueado)");
      return { signals, checksRun, checksNotRun, context: message };
    }
    const isHttps = url.startsWith("https://");

    let main: Probe;
    try {
      main = await probe(url);
      checksRun.push("HTTP GET (página principal)");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      signals.push({
        domain: "backend",
        ruleId: "BACKEND_UNREACHABLE",
        title: "Alvo inalcançável",
        message: `Falha ao buscar ${url}: ${message}`,
        severity: "P1",
        url,
        evidence: message,
        metadata: { error: true },
      });
      checksRun.push("HTTP GET (falhou)");
      return { signals, checksRun, checksNotRun, context: `Alvo: ${url}\nFalha de conexão: ${message}` };
    }

    if (main.status >= 500) {
      signals.push({
        domain: "backend",
        ruleId: "HTTP_5XX",
        title: `Erro do servidor: HTTP ${main.status}`,
        message: `A página principal respondeu ${main.status}.`,
        severity: "P1",
        url,
        evidence: `Status ${main.status}\n${main.bodySnippet}`,
      });
    } else if (main.status >= 400) {
      signals.push({
        domain: "backend",
        ruleId: "HTTP_4XX",
        title: `Resposta de erro: HTTP ${main.status}`,
        message: `A página principal respondeu ${main.status}.`,
        severity: "P2",
        url,
        evidence: `Status ${main.status}\n${main.bodySnippet}`,
      });
    }

    for (const [header, title, severity, impact] of SECURITY_HEADERS) {
      // HSTS só faz sentido em HTTPS; sinalizá-lo em http:// gera falso positivo.
      if (!isHttps && header === "strict-transport-security") continue;
      const hasAlternative =
        header === "x-frame-options" &&
        /frame-ancestors/i.test(main.headers.get("content-security-policy") ?? "");
      if (!main.headers.has(header) && !hasAlternative) {
        signals.push({
          domain: "backend",
          ruleId: `MISSING_HEADER_${header.toUpperCase().replace(/-/g, "_")}`,
          title,
          message: `Header ${header} não foi retornado em ${url}.`,
          severity,
          url,
          evidence: redactSecrets(
            `Headers recebidos: ${JSON.stringify(Object.fromEntries(main.headers.entries()))}`,
          ),
          metadata: { impact, header },
        });
      }
    }

    if (main.headers.has("x-powered-by")) {
      signals.push({
        domain: "backend",
        ruleId: "SERVER_FINGERPRINT",
        title: "Tecnologia do servidor exposta",
        message: `Header X-Powered-By: ${main.headers.get("x-powered-by")}`,
        severity: "P4",
        url,
        evidence: `X-Powered-By: ${main.headers.get("x-powered-by")}`,
      });
    }

    const acao = main.headers.get("access-control-allow-origin");
    const acac = main.headers.get("access-control-allow-credentials");
    if (acao === "*" && acac?.toLowerCase() === "true") {
      signals.push({
        domain: "backend",
        ruleId: "CORS_WILDCARD_CREDENTIALS",
        title: "CORS curinga com credenciais",
        message: "Access-Control-Allow-Origin: * combinado com Allow-Credentials: true.",
        severity: "P2",
        url,
        evidence: `ACAO: ${acao}; ACAC: ${acac}`,
      });
    }

    if (/\b(at [A-Za-z]+\.java:|stack trace|Traceback \(most recent|Exception stack)/i.test(main.bodySnippet)) {
      signals.push({
        domain: "backend",
        ruleId: "STACK_TRACE_LEAK",
        title: "Stack trace exposta na resposta",
        message: "A resposta HTTP contém indícios de stack trace.",
        severity: "P1",
        url,
        evidence: main.bodySnippet.slice(0, 800),
      });
    }

    // Latência: amostra pequena para estimar p95 sem abusar do alvo.
    const samples = [main.latencyMs];
    for (let i = 0; i < 4; i += 1) {
      try {
        samples.push((await probe(url)).latencyMs);
      } catch {
        // amostra descartada
      }
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))] ?? 0;
    checksRun.push(`Latência HTTP (${samples.length} amostras, p95=${p95}ms)`);
    if (p95 > 1500) {
      signals.push({
        domain: "backend",
        ruleId: "HIGH_LATENCY",
        title: `Latência p95 elevada (${p95}ms)`,
        message: `Tempo de resposta p95 de ${p95}ms em ${samples.length} requisições.`,
        severity: "P3",
        url,
        evidence: `Amostras: ${samples.join(", ")} ms`,
      });
    }

    if (options.allowMutatingRequests) {
      try {
        const optionsResponse = await fetch(url, { method: "OPTIONS", signal: AbortSignal.timeout(10_000) });
        checksRun.push("HTTP OPTIONS");
        const allow = optionsResponse.headers.get("allow") ?? "";
        if (/\b(PUT|DELETE|PATCH)\b/i.test(allow)) {
          signals.push({
            domain: "backend",
            ruleId: "MUTATING_METHODS_ALLOWED",
            title: "Métodos mutantes anunciados",
            message: `Allow: ${allow}`,
            severity: "P3",
            url,
            evidence: `Allow: ${allow}`,
          });
        }
      } catch {
        checksNotRun.push("HTTP OPTIONS");
      }
    } else {
      checksNotRun.push("HTTP OPTIONS (use --allow-mutating-requests)");
    }

    const context = [
      `Alvo: ${url}`,
      `Status: ${main.status}`,
      `Latência p95: ${p95}ms (amostras: ${samples.join(", ")})`,
      `Headers: ${JSON.stringify(Object.fromEntries(main.headers.entries()))}`,
      `Corpo (início): ${main.bodySnippet.slice(0, 600)}`,
      `TraceId: ${ctx.traceId}`,
    ].join("\n");

    return { signals, checksRun, checksNotRun, context };
  }
}

export const backendAuditor = new BackendAuditor();
