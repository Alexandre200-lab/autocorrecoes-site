import { EventEmitter } from "node:events";
import type { PipelineEvent } from "./types.js";

class TypedEmitter extends EventEmitter {
  emitEvent(event: PipelineEvent): void {
    this.emit("pipeline", event);
  }

  onEvent(listener: (event: PipelineEvent) => void): () => void {
    this.on("pipeline", listener);
    return () => this.off("pipeline", listener);
  }
}

export const events = new TypedEmitter();
