import { logger } from "../observability/index.js";
import { runAudit } from "../pipeline/index.js";
import { events } from "../shared/events.js";
import { store } from "../storage/index.js";
import type { Job } from "../shared/types.js";

/** Worker durável: jobs ficam no SQLite e sobrevivem a restart do processo. */

const MAX_CONCURRENT = 2;
let active = 0;
let timer: NodeJS.Timeout | null = null;

async function execute(job: Job): Promise<void> {
  active += 1;
  events.emitEvent({ type: "job:started", jobId: job.id });
  try {
    const outcome = await runAudit(job.target, job.options);
    store.updateJob(job.id, { status: "done", runId: outcome.run.id });
    events.emitEvent({ type: "job:finished", jobId: job.id, runId: outcome.run.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.updateJob(job.id, { status: "failed", error: message });
    events.emitEvent({ type: "job:failed", jobId: job.id, message });
    logger.error("worker.job.failed", { jobId: job.id, message });
  } finally {
    active -= 1;
  }
}

function tick(): void {
  while (active < MAX_CONCURRENT) {
    const job = store.claimNextJob();
    if (!job) break;
    void execute(job);
  }
}

export function startWorker(intervalMs = 500): void {
  const recovered = store.recoverJobs();
  if (recovered > 0) logger.info("worker.recovered", { jobs: recovered });
  if (timer) return;
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  logger.info("worker.started", { maxConcurrent: MAX_CONCURRENT });
}

export function stopWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
