import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "ac-rate-"));
process.env.DATA_DIR = dataDir;
process.env.API_TOKEN = "token-rate-123456";
process.env.RATE_LIMIT_MAX = "3";

test("parâmetro ?token= não cria novos buckets de rate limit", async () => {
  const { startServer } = await import("../src/server/index.js");
  const app = await startServer(0);
  const port = (app.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const response = await fetch(
        `${base}/api/runs?token=${Math.random().toString(36).slice(2)}`,
        { headers: { Authorization: "Bearer token-rate-123456" } },
      );
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429]);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
