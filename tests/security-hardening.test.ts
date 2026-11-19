import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "ac-sec-hard-"));
process.env.DATA_DIR = dataDir;
process.env.API_TOKEN = "token-seguranca-123456";
process.env.RATE_LIMIT_MAX = "50";
process.env.LOGIN_RATE_LIMIT_MAX = "2";

test("hardening: login limitado, alvos de sistema bloqueados e limites validados", async () => {
  const { startServer } = await import("../src/server/index.js");
  const app = await startServer(0);
  const port = (app.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: "Bearer token-seguranca-123456" };

  try {
    // Força bruta: terceira tentativa com token errado é limitada.
    const attempts: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      attempts.push(
        (
          await fetch(`${base}/api/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: "errado" }),
          })
        ).status,
      );
    }
    assert.deepEqual(attempts, [401, 401, 429]);

    // Não é possível enfileirar auditoria de diretório de sistema.
    const traversal = await fetch(`${base}/api/audit`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ target: "/etc", type: "path" }),
    });
    assert.equal(traversal.status, 400);

    // Limite negativo não vira LIMIT -1 (ilimitado).
    const negative = await fetch(`${base}/api/runs?limit=-1`, { headers: auth });
    assert.equal(negative.status, 200);
    const body = (await negative.json()) as { runs: unknown[] };
    assert.ok(body.runs.length <= 50);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
