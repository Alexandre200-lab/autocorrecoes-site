import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { backendAuditor } from "../src/auditors/backend/index.js";

test("auditor backend detecta headers de segurança ausentes", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Teste</title><p>ok</p>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const result = await backendAuditor.audit(
      `http://127.0.0.1:${port}`,
      {},
      { runId: "test", traceId: "test" },
    );
    const rules = result.signals.map((s) => s.ruleId);
    assert.ok(rules.includes("MISSING_HEADER_CONTENT_SECURITY_POLICY"));
    assert.ok(rules.includes("MISSING_HEADER_STRICT_TRANSPORT_SECURITY"));
    assert.ok(result.checksRun.some((c) => c.includes("HTTP GET")));
  } finally {
    server.close();
  }
});
