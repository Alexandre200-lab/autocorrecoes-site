import assert from "node:assert/strict";
import test from "node:test";

test("API exige Bearer token quando API_TOKEN está configurado", async () => {
  process.env.API_TOKEN = "token-de-teste-123456";
  const { startServer } = await import("../src/server/index.js");
  const port = 14311;
  const base = `http://127.0.0.1:${port}`;
  const app = await startServer(port);

  try {
    const withoutToken = await fetch(`${base}/api/runs`);
    assert.equal(withoutToken.status, 401);

    const withToken = await fetch(`${base}/api/runs`, {
      headers: { Authorization: "Bearer token-de-teste-123456" },
    });
    assert.equal(withToken.status, 200);

    const config = await fetch(`${base}/api/config`);
    assert.equal(config.status, 200);
    const body = (await config.json()) as { authRequired: boolean };
    assert.equal(body.authRequired, true);

    const queryToken = await fetch(`${base}/api/metrics?token=token-de-teste-123456`);
    assert.equal(queryToken.status, 200);
  } finally {
    await app.close();
  }
});
