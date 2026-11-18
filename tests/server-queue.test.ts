import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("API enfileira auditoria e worker a conclui com runId", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ac-server-data-"));
  const project = mkdtempSync(join(tmpdir(), "ac-server-project-"));
  writeFileSync(join(project, "app.js"), 'console.log("debug");\n');

  process.env.DATA_DIR = dataDir;
  process.env.API_TOKEN = "";

  const { startServer } = await import("../src/server/index.js");
  const port = 14312;
  const base = `http://127.0.0.1:${port}`;
  const app = await startServer(port);

  try {
    const response = await fetch(`${base}/api/audit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: project, type: "path", useAI: false }),
    });
    assert.equal(response.status, 202);
    const { jobId } = (await response.json()) as { jobId: string };

    let status = "queued";
    let runId: string | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const jobResponse = await fetch(`${base}/api/jobs/${jobId}`);
      const { job } = (await jobResponse.json()) as {
        job: { status: string; runId?: string };
      };
      status = job.status;
      runId = job.runId;
      if (status === "done" || status === "failed") break;
    }
    assert.equal(status, "done");
    assert.ok(runId);

    const runResponse = await fetch(`${base}/api/runs/${runId}`);
    const { run } = (await runResponse.json()) as { run: { signals: unknown[] } };
    assert.ok(run.signals.length > 0);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
