import assert from "node:assert/strict";
import test from "node:test";
import { events } from "../src/shared/events.js";
import { newId, store } from "../src/storage/index.js";
import type { DeliveredEvent, Job } from "../src/shared/types.js";

function makeJob(): Job {
  return {
    id: newId("job"),
    target: "https://example.com",
    options: { useAI: false },
    status: "queued",
    attempts: 0,
    createdAt: new Date().toISOString(),
  };
}

test("fila durável: claim, recuperação e conclusão", () => {
  const job = makeJob();
  store.enqueueJob(job);
  const claimed = store.claimNextJob();
  assert.equal(claimed?.id, job.id);
  assert.equal(claimed?.status, "running");
  assert.equal(store.claimNextJob(), null);

  assert.equal(store.recoverJobs(), 1);
  const recovered = store.claimNextJob();
  assert.equal(recovered?.id, job.id);

  store.updateJob(job.id, { status: "done", runId: "run_teste" });
  const done = store.getJob(job.id);
  assert.equal(done?.status, "done");
  assert.equal(done?.runId, "run_teste");
});

test("retry respeita nextRunAt e dead-letter pode ser reaberta", () => {
  const job = makeJob();
  store.enqueueJob(job);
  const claimed = store.claimNextJob();
  assert.equal(claimed?.id, job.id);

  const future = new Date(Date.now() + 60_000).toISOString();
  store.updateJob(job.id, { status: "queued", nextRunAt: future });
  assert.equal(store.claimNextJob(), null, "job agendado para o futuro não deve ser reclamado");

  store.updateJob(job.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(store.claimNextJob()?.id, job.id);

  store.updateJob(job.id, { status: "failed", deadLetter: true });
  assert.equal(store.claimNextJob(), null, "dead-letter não deve ser reclamada");
  assert.equal(store.listJobs(50, true).some((item) => item.id === job.id), true);

  assert.equal(store.retryJob(job.id), true);
  assert.equal(store.claimNextJob()?.id, job.id);
});

test("eventos persistidos com replay filtrado por afterId", () => {
  const runId = newId("run");
  const first = events.emitEvent({ type: "run:started", runId, target: "https://example.com" });
  const second = events.emitEvent({ type: "audit:finished", runId, signals: 0 });

  const stored = store.listEvents({ runId });
  assert.ok(stored.length >= 2);
  assert.ok(stored.some((event) => event.id === first.eventId));

  const received: DeliveredEvent[] = [];
  const unsubscribe = events.onEvent(
    (event) => received.push(event),
    { runId, afterId: first.eventId },
  );
  unsubscribe();

  assert.ok(received.some((event) => event.eventId === second.eventId));
  assert.ok(!received.some((event) => event.eventId === first.eventId));
});
