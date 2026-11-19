import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("Swagger UI e rate limit estão ativos", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ac-infra-"));
  process.env.DATA_DIR = dataDir;
  process.env.API_TOKEN = "";
  process.env.RATE_LIMIT_MAX = "2";

  const { startServer } = await import("../src/server/index.js");
  const app = await startServer(0);
  const port = (app.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const docs = await fetch(`${base}/docs`);
    assert.equal(docs.status, 200);

    const specCandidates = ["/openapi.json", "/openapi/json", "/docs/json"];
    let specOk = false;
    for (const path of specCandidates) {
      const response = await fetch(`${base}${path}`);
      if (response.ok && response.headers.get("content-type")?.includes("json")) {
        const body = (await response.json()) as { openapi?: string };
        if (body.openapi) {
          specOk = true;
          break;
        }
      }
    }
    assert.equal(specOk, true, "especificação OpenAPI não encontrada");

    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await fetch(`${base}/api/runs`)).status);
    }
    assert.deepEqual(statuses, [200, 200, 429, 429]);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
