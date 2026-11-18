import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "../config/index.js";

const logFile = join(config.dataDir, "audit.jsonl");

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

type Level = "info" | "warn" | "error" | "debug";

function write(level: Level, event: string, data: Record<string, unknown> = {}): void {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event,
    service: "autocorrecoes",
    ...data,
  };
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${JSON.stringify(record)}\n`);
  } catch {
    // Observabilidade nunca deve quebrar a auditoria.
  }
  if (level === "error" || level === "warn") {
    const method = level === "error" ? console.error : console.warn;
    method(`[${event}]`, data.message ?? "");
  }
}

export const logger = {
  info: (event: string, data?: Record<string, unknown>) => write("info", event, data),
  warn: (event: string, data?: Record<string, unknown>) => write("warn", event, data),
  error: (event: string, data?: Record<string, unknown>) => write("error", event, data),
  debug: (event: string, data?: Record<string, unknown>) => write("debug", event, data),
};

/** Spans em JSONL local; a exportação OTLP é feita pelo SDK em otel.ts. */
export async function span<T>(
  name: string,
  fn: () => Promise<T> | T,
  attributes: Record<string, unknown> = {},
): Promise<T> {
  const traceId = attributes.traceId ? String(attributes.traceId) : newTraceId();
  const spanId = newSpanId();
  const started = performance.now();
  write("debug", "span.start", { traceId, spanId, name, attributes });
  try {
    const result = await fn();
    const durationMs = Math.round(performance.now() - started);
    write("info", "span.end", { traceId, spanId, name, durationMs, status: "ok", attributes });
    return result;
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    write("error", "span.end", {
      traceId,
      spanId,
      name,
      durationMs,
      status: "error",
      message: error instanceof Error ? error.message : String(error),
      attributes,
    });
    throw error;
  }
}


