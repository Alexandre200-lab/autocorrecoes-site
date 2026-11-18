import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

test("cliente DeepSeek usa contrato correto, redata segredos e contabiliza custo", async () => {
  let captured: Record<string, unknown> | null = null;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      captured = JSON.parse(body) as Record<string, unknown>;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: '{"findings":[]}' } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.DEEPSEEK_API_KEY = "sk-test-key-1234567890";
  process.env.AI_BUDGET_USD = "2";

  const { complete, getBudget } = await import("../src/ai/client.js");

  try {
    const raw = await complete({
      system: "sys",
      user: 'Analise: apiKey = "super-secret-value"',
      json: true,
      label: "test",
    });
    assert.equal(raw, '{"findings":[]}');

    const payload = captured as {
      model: string;
      response_format: { type: string };
      thinking: { type: string };
      messages: Array<{ role: string; content: string }>;
    };
    assert.equal(payload.model, "deepseek-flash");
    assert.equal(payload.response_format.type, "json_object");
    assert.equal(payload.thinking.type, "disabled");
    assert.doesNotMatch(payload.messages[1].content, /super-secret-value/);
    assert.match(payload.messages[1].content, /\[REDACTED\]/);

    const budget = getBudget();
    assert.ok(budget.promptTokens === 100 && budget.completionTokens === 50);
    assert.ok(budget.spentUsd > 0 && budget.spentUsd < 0.01);
  } finally {
    server.close();
  }
});
