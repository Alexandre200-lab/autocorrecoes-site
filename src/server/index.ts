import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCookie from "@fastify/cookie";
import { createHash, randomBytes } from "node:crypto";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import { config } from "../config/index.js";
import { reauditFinding, runAudit } from "../pipeline/index.js";
import { applyApproved, rollbackRun } from "../patches/index.js";
import { events } from "../shared/events.js";
import { newId, store } from "../storage/index.js";
import type { AuditOptions, Domain, Job, TargetType } from "../shared/types.js";
import { logger } from "../observability/index.js";
import { snapshot } from "../observability/metrics.js";
import { startWorker, stopWorker } from "./worker.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { diffRuns } from "../pipeline/diff.js";
import { addBaselineFingerprints } from "../config/project.js";
import { resolveLocalTarget } from "../auditors/url.js";

const dashboardDir = resolve(process.cwd(), "dashboard/dist");

const FALLBACK_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AutoCorrecoes</title><style>
body{font-family:system-ui,sans-serif;background:#0d1117;color:#e6edf3;max-width:720px;margin:10vh auto;padding:24px}
code{background:#161b22;padding:2px 6px;border-radius:4px;color:#79c0ff}a{color:#79c0ff}
</style></head><body><h1>AutoCorrecoes</h1>
<p>API ativa. O dashboard ainda não foi compilado.</p>
<p>Para habilitar a interface: <code>cd dashboard && npm install && npm run build</code></p>
<p>Endpoints: <code>/api/runs</code>, <code>/api/findings</code>, <code>/api/events</code></p>
</body></html>`;

export async function startServer(port = config.PORT): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "AutoCorrecoes API",
        version: "1.0.0",
        description: "Auditoria e autocorreção de sites com fiscalização DeepSeek.",
      },
      tags: [
        { name: "audits", description: "Execuções e fila de auditorias" },
        { name: "findings", description: "Achados e decisões humanas" },
        { name: "system", description: "Saúde, métricas e eventos" },
      ],
    },
  });
  await app.register(swaggerUI, { routePrefix: "/docs" });
  await app.register(fastifyCookie);

  const rateHits = new Map<string, { count: number; resetAt: number }>();
  const sseTickets = new Map<string, number>();
  const SESSION_COOKIE = "autocorrecoes_session";
  const SESSION_MAX_AGE = 8 * 60 * 60;
  const SSE_TICKET_TTL = 5 * 60 * 1000;
  const publicRoutes = new Set([
    "/api/health",
    "/api/config",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/events/ticket",
  ]);
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

    const path = request.url.split("?")[0];
    const isPublicDocs = path.startsWith("/docs") || path.startsWith("/openapi");
    const isApi = path.startsWith("/api/");
    const isPublic = publicRoutes.has(path) || isPublicDocs;

    const cookies = (request as unknown as { cookies?: Record<string, string> }).cookies ?? {};
    const bearer = request.headers.authorization?.startsWith("Bearer ")
      ? request.headers.authorization.slice(7)
      : undefined;
    const queryAuth = request.query as { token?: string; ticket?: string } | undefined;
    const identity = cookies[SESSION_COOKIE] ?? bearer ?? queryAuth?.token ?? request.ip;
    const rateKey = createHash("sha256").update(identity).digest("hex").slice(0, 16);

    if (config.RATE_LIMIT_MAX > 0 && isApi && !isPublic) {
      const key = rateKey;
      const now = Date.now();
      let entry = rateHits.get(key);
      if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + 60_000 };
        rateHits.set(key, entry);
      }
      entry.count += 1;
      if (entry.count > config.RATE_LIMIT_MAX) {
        return reply
          .code(429)
          .header("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)))
          .send({ error: "Muitas requisições. Tente novamente em instantes." });
      }
    }

    if (!config.API_TOKEN || !isApi || isPublic) return;

    // SSE usa ticket de curta duração em vez do token de sessão na URL.
    if (path === "/api/events" && queryAuth?.ticket) {
      const expires = sseTickets.get(queryAuth.ticket);
      if (expires && expires > Date.now()) return;
      reply.code(401);
      return reply.send({ error: "Ticket de eventos inválido ou expirado." });
    }

    // Cookie httpOnly é a forma preferida; Bearer mantém compatibilidade com CLI/CI.
    if (cookies[SESSION_COOKIE] !== config.API_TOKEN && bearer !== config.API_TOKEN) {
      reply.code(401);
      return reply.send({ error: "Não autorizado. Faça login ou informe Bearer <API_TOKEN>." });
    }
  });
  app.options("/*", async (_request, reply) => reply.code(204).send());

  app.post(
    "/api/auth/login",
    {
      schema: {
        tags: ["system"],
        body: {
          type: "object",
          required: ["token"],
          properties: { token: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const { token } = request.body as { token: string };
      if (!config.API_TOKEN || token !== config.API_TOKEN) {
        return reply.code(401).send({ error: "Token inválido." });
      }
      const secure =
        request.headers["x-forwarded-proto"] === "https" || request.protocol === "https";
      reply.setCookie(SESSION_COOKIE, config.API_TOKEN, {
        httpOnly: true,
        sameSite: "strict",
        secure,
        path: "/",
        maxAge: SESSION_MAX_AGE,
      });
      return { ok: true };
    },
  );

  app.post("/api/auth/logout", async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post("/api/events/ticket", async (request, reply) => {
    const cookies = (request as unknown as { cookies?: Record<string, string> }).cookies ?? {};
    const bearer = request.headers.authorization?.startsWith("Bearer ")
      ? request.headers.authorization.slice(7)
      : undefined;
    if (config.API_TOKEN && cookies[SESSION_COOKIE] !== config.API_TOKEN && bearer !== config.API_TOKEN) {
      return reply.code(401).send({ error: "Não autorizado." });
    }
    for (const [key, expires] of sseTickets) {
      if (expires < Date.now()) sseTickets.delete(key);
    }
    const ticket = randomBytes(24).toString("base64url");
    sseTickets.set(ticket, Date.now() + SSE_TICKET_TTL);
    return { ticket, expiresIn: Math.round(SSE_TICKET_TTL / 1000) };
  });

  app.get("/api/health", async () => ({ ok: true, version: "1.0.0" }));
  app.get("/api/metrics", async () => snapshot());
  app.get("/api/config", async () => ({
    model: config.DEEPSEEK_MODEL,
    verifyModel: config.DEEPSEEK_VERIFY_MODEL,
    apiKeyConfigured: config.apiKeyConfigured,
    authRequired: Boolean(config.API_TOKEN),
    dataDir: config.dataDir,
  }));

  app.get("/api/runs", async (request) => {
    const query = request.query as { limit?: string };
    return { runs: store.listRuns(Math.min(Number(query.limit) || 50, 200)) };
  });

  app.get("/api/jobs", async (request) => {
    const query = request.query as { limit?: string; dead?: string };
    return {
      jobs: store.listJobs(
        Math.min(Number(query.limit) || 50, 200),
        query.dead === "true" ? true : query.dead === "false" ? false : undefined,
      ),
    };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", async (request, reply) => {
    if (!store.retryJob(request.params.id)) {
      return reply.code(404).send({ error: "Job não encontrado." });
    }
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const job = store.getJob(request.params.id);
    if (!job) return reply.code(404).send({ error: "Job não encontrado." });
    return { job };
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
    const run = store.getRun(request.params.id);
    if (!run) return reply.code(404).send({ error: "Execução não encontrada." });
    return {
      run,
      findings: store.listFindings({ runId: run.id }),
      receipts: store.listReceipts(run.id),
    };
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id/diff", async (request, reply) => {
    const run = store.getRun(request.params.id);
    if (!run) return reply.code(404).send({ error: "Execução não encontrada." });
    const query = request.query as { against?: string };
    const previous = query.against
      ? store.getRun(query.against)
      : store.previousRun(run);
    return diffRuns(previous, run);
  });

  app.get("/api/trends", async (request) => {
    const query = request.query as { limit?: string };
    const runs = store
      .listRuns(Math.min(Number(query.limit) || 20, 100))
      .slice()
      .reverse();
    return {
      trends: runs.map((run) => {
        const findings = store.listFindings({ runId: run.id, limit: 500 });
        const bySeverity = { P1: 0, P2: 0, P3: 0, P4: 0 };
        for (const finding of findings) bySeverity[finding.severity] += 1;
        return {
          id: run.id,
          startedAt: run.startedAt,
          target: run.target,
          signals: run.signals.length,
          bySeverity,
        };
      }),
    };
  });

  app.post("/api/baseline", {
    schema: {
      tags: ["findings"],
      body: {
        type: "object",
        required: ["runId"],
        properties: {
          runId: { type: "string" },
          fingerprints: { type: "array", items: { type: "string" } },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { runId: string; fingerprints?: string[] };
    const run = store.getRun(body.runId);
    if (!run) return reply.code(404).send({ error: "Execução não encontrada." });
    const root = run.targetType === "path" ? resolveLocalTarget(run.target) : process.cwd();
    return addBaselineFingerprints(root, body.fingerprints ?? []);
  });

  app.get("/api/findings", async (request) => {
    const query = request.query as { runId?: string; status?: string; limit?: string };
    return {
      findings: store.listFindings({
        runId: query.runId,
        status: query.status as never,
        limit: Math.min(Number(query.limit) || 200, 500),
      }),
    };
  });

  app.post("/api/audit", {
    schema: {
      tags: ["audits"],
      summary: "Enfileira uma auditoria",
      response: {
        202: {
          type: "object",
          properties: {
            started: { type: "boolean" },
            jobId: { type: "string" },
            target: { type: "string" },
          },
        },
        400: {
          type: "object",
          properties: { error: { type: "string" } },
        },
      },
      body: {
        type: "object",
        required: ["target"],
        additionalProperties: false,
        properties: {
          target: { type: "string", minLength: 1 },
          type: { type: "string", enum: ["url", "path"] },
          domains: {
            type: "array",
            items: { type: "string", enum: ["design", "backend", "code"] },
          },
          useAI: { type: "boolean" },
          allowPrivateHosts: { type: "boolean" },
          allowMutatingRequests: { type: "boolean" },
        },
      },
    },
  }, async (request, reply) => {
    const body = (request.body ?? {}) as {
      target?: string;
      type?: TargetType;
      domains?: Domain[];
      useAI?: boolean;
      allowPrivateHosts?: boolean;
      allowMutatingRequests?: boolean;
    };
    if (!body.target || typeof body.target !== "string") {
      return reply.code(400).send({ error: "Campo 'target' é obrigatório." });
    }
    const options: AuditOptions = {
      type: body.type,
      domains: body.domains,
      useAI: body.useAI,
      allowPrivateHosts: body.allowPrivateHosts,
      allowMutatingRequests: body.allowMutatingRequests,
    };
    // Fila durável: o worker processa e o progresso chega por /api/events (SSE).
    const job: Job = {
      id: newId("job"),
      target: body.target,
      options,
      status: "queued",
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
    store.enqueueJob(job);
    events.emitEvent({ type: "job:queued", jobId: job.id, target: job.target });
    return reply.code(202).send({ started: true, jobId: job.id, target: body.target });
  });

  async function setFindingStatus(
    id: string,
    status: "approved" | "rejected",
    reason: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const finding = store.getFinding(id);
    if (!finding) return { ok: false, error: "Achado não encontrado." };
    store.updateFinding(id, {
      status,
      rejectionReason: status === "rejected" ? reason : "",
    });
    store.addReceipt({
      id: newId("rcpt"),
      runId: finding.runId,
      findingId: finding.id,
      kind: status === "approved" ? "approval" : "rejection",
      payload: { status, reason, humanDecision: true },
      createdAt: new Date().toISOString(),
    });
    events.emitEvent({
      type: "finding:updated",
      runId: finding.runId,
      findingId: finding.id,
      status,
    });
    return { ok: true };
  }

  app.post<{ Params: { id: string } }>("/api/findings/:id/approve", async (request) =>
    setFindingStatus(request.params.id, "approved", ""),
  );

  app.post<{ Params: { id: string } }>("/api/findings/:id/reject", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: { reason: { type: "string", maxLength: 2000 } },
      },
    },
  }, async (request) => {
    const body = (request.body ?? {}) as { reason?: string };
    return setFindingStatus(request.params.id, "rejected", body.reason ?? "Rejeitado no dashboard");
  });

  app.post("/api/apply", {
    schema: {
      tags: ["findings"],
      summary: "Aplica patches aprovados",
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          runId: { type: "string" },
          reaudit: { type: "boolean" },
        },
      },
    },
  }, async (request) => {
    const body = (request.body ?? {}) as { runId?: string; reaudit?: boolean };
    const results = await applyApproved(body.runId);
    if (body.reaudit) {
      for (const result of results) {
        if (!result.applied) continue;
        const finding = store.getFinding(result.findingId);
        if (finding && !finding.patch?.exportedArtifact) await reauditFinding(finding);
      }
    }
    return { results };
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/rollback", async (request) => ({
    restored: rollbackRun(request.params.id),
  }));

  app.get("/api/events", (request, reply) => {
    const query = request.query as { runId?: string; afterId?: string };
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(": conectado\n\n");
    const unsubscribe = events.onEvent(
      (event) => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      },
      { runId: query.runId, afterId: query.afterId ? Number(query.afterId) : undefined },
    );
    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 20_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  if (existsSync(resolve(dashboardDir, "index.html"))) {
    await app.register(fastifyStatic, { root: dashboardDir, prefix: "/" });
    app.setNotFoundHandler((_request, reply) => reply.sendFile("index.html"));
  } else {
    app.get("/", async (_request, reply) => reply.type("text/html").send(FALLBACK_HTML));
  }

  app.addHook("onClose", async () => {
    stopWorker();
    stopScheduler();
  });
  startWorker();
  startScheduler();
  await app.listen({ port, host: config.HOST });
  logger.info("server.started", { port, host: config.HOST, dashboard: existsSync(dashboardDir) });
  console.log(`AutoCorrecoes API + dashboard: http://${config.HOST}:${port}`);
  return app;
}
