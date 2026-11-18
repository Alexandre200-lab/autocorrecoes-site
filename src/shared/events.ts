import { EventEmitter } from "node:events";
import { store } from "../storage/index.js";
import type { DeliveredEvent, PipelineEvent } from "./types.js";

export interface EventFilter {
  runId?: string;
  /** Replay de eventos posteriores a este id (ej.: último evento recebido pelo cliente). */
  afterId?: number;
}

class TypedEmitter extends EventEmitter {
  emitEvent(event: PipelineEvent): DeliveredEvent {
    const stored = store.insertEvent({
      runId: "runId" in event ? event.runId : undefined,
      type: event.type,
      payload: event as unknown as Record<string, unknown>,
    });
    const delivered: DeliveredEvent = {
      ...event,
      eventId: stored.id,
      createdAt: stored.createdAt,
    };
    this.emit("pipeline", delivered);
    return delivered;
  }

  /**
   * Inscreve no fluxo ao vivo e, quando há filtro, faz replay do histórico persistido.
   * O cliente deve deduplicar por eventId (o replay pode cruzar com eventos ao vivo).
   */
  onEvent(listener: (event: DeliveredEvent) => void, filter?: EventFilter): () => void {
    const wrapped = (event: DeliveredEvent): void => listener(event);
    this.on("pipeline", wrapped);

    if (filter?.runId || filter?.afterId) {
      for (const stored of store.listEvents({
        runId: filter?.runId,
        afterId: filter?.afterId,
        limit: 300,
      })) {
        listener({
          ...stored.payload,
          eventId: stored.id,
          createdAt: stored.createdAt,
        } as DeliveredEvent);
      }
    }

    return () => this.off("pipeline", wrapped);
  }
}

export const events = new TypedEmitter();
