import { logger } from "../observability/index.js";
import { runAudit } from "../pipeline/index.js";
import { events } from "../shared/events.js";
import { notifyNewCritical } from "./notify.js";
import { store } from "../storage/index.js";
import type { Job } from "../shared/types.js";

/** Worker durável: jobs ficam no SQLite e sobrevivem a restart do processo. */

const MAX_CONCURRENT = 2;
const MAX_BACKOFF_MS = 5 * 60_000;
let active = 0;
let timer: NodeJS.Timeout | null = null;
const inFlight = new Set<Promise<void>>();

function jitter(ms: number): number {
  return Math.min(ms, MAX_BACKOFF_MS) + Math.floor(Math.random() * 250);
}

async function execute(job: Job): Promise<void> {
  active += 1;
  events.emitEvent({ type: "job:started", jobId: job.id });
  try {
    const outcome = await runAudit(job.target, job.options);
    store.updateJob(job.id, { status: "done", runId: outcome.run.id });
    events.emitEvent({ type: "job:finished", jobId: job.id, runId: outcome.run.id });
    // Notificação é efeito colateral: uma falha aqui não pode reprocessar uma
    // auditoria já concluída (e paga).
    try {
      await notifyNewCritical(outcome.run);
    } catch (error) {
      logger.warn("worker.notify.failed", {
        jobId: job.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const maxAttempts = job.maxAttempts ?? 3;
    if (job.attempts < maxAttempts) {
      const delayMs = jitter(2 ** job.attempts * 1000);
      const nextRunAt = new Date(Date.now() + delayMs).toISOString();
      store.updateJob(job.id, { status: "queued", error: message, nextRunAt });
      events.emitEvent({
        type: "job:retry",
        jobId: job.id,
        attempt: job.attempts,
        nextRunAt,
      });
      logger.warn("worker.job.retry", { jobId: job.id, attempt: job.attempts, delayMs });
    } else {
      store.updateJob(job.id, { status: "failed", error: message, deadLetter: true });
      events.emitEvent({ type: "job:failed", jobId: job.id, message });
      logger.error("worker.job.dead_letter", { jobId: job.id, message });
    }
  } finally {
    active -= 1;
  }
}

function tick(): void {
  while (active < MAX_CONCURRENT) {
    const job = store.claimNextJob();
    if (!job) break;
    const task = execute(job);
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
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

/** Aguarda os jobs em voo antes de encerrar o processo (graceful shutdown). */
export async function drainWorker(timeoutMs = 30_000): Promise<void> {
  stopWorker();
  const deadline = Date.now() + timeoutMs;
  while (inFlight.size > 0 && Date.now() < deadline) {
    await Promise.allSettled([...inFlight]);
  }
  if (inFlight.size > 0) {
    logger.warn("worker.drain.timeout", { pending: inFlight.size });
  }
}
