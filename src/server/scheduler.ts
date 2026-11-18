import { logger } from "../observability/index.js";
import { loadProjectConfig } from "../config/project.js";
import { resolveLocalTarget } from "../auditors/url.js";
import { events } from "../shared/events.js";
import { newId, store } from "../storage/index.js";
import type { Job } from "../shared/types.js";

/** Agenda auditorias recorrentes conforme .autocorrecoes.yml de cada alvo conhecido. */

let timer: NodeJS.Timeout | null = null;

function tick(): void {
  for (const { target, targetType } of store.listDistinctTargets(100)) {
    try {
      const root = targetType === "path" ? resolveLocalTarget(target) : process.cwd();
      const project = loadProjectConfig(root);
      if (!project.schedule.enabled) continue;
      const since = new Date(Date.now() - project.schedule.everyMinutes * 60_000).toISOString();
      if (store.hasRecentJob(target, since)) continue;

      const job: Job = {
        id: newId("job"),
        target,
        options: { project },
        status: "queued",
        attempts: 0,
        createdAt: new Date().toISOString(),
      };
      store.enqueueJob(job);
      events.emitEvent({ type: "job:queued", jobId: job.id, target });
      logger.info("scheduler.enqueued", { target, jobId: job.id });
    } catch (error) {
      logger.warn("scheduler.skipped", {
        target,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function startScheduler(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  logger.info("scheduler.started", { intervalMs });
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
