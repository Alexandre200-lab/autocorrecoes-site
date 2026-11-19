import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

test("API exige Bearer token quando API_TOKEN está configurado", async () => {
  process.env.API_TOKEN = "token-de-teste-123456";
  const { startServer } = await import("../src/server/index.js");
  const app = await startServer(0);
  const port = (app.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

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

    const withBearer = await fetch(`${base}/api/metrics`, {
      headers: { Authorization: "Bearer token-de-teste-123456" },
    });
    assert.equal(withBearer.status, 200);

    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "token-de-teste-123456" }),
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    assert.match(login.headers.get("set-cookie") ?? "", /HttpOnly/i);
    const withCookie = await fetch(`${base}/api/runs`, { headers: { Cookie: cookie } });
    assert.equal(withCookie.status, 200);

    const ticketResponse = await fetch(`${base}/api/events/ticket`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    const { ticket } = (await ticketResponse.json()) as { ticket: string };
    const sse = await fetch(`${base}/api/events?ticket=${ticket}`, {
      signal: AbortSignal.timeout(1000),
    });
    assert.equal(sse.status, 200);
    await sse.body?.cancel();
  } finally {
    await app.close();
  }
});
