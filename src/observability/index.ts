import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "../config/index.js";

const logFile = join(config.dataDir, "audit.jsonl");
const otlpEndpoint = config.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "");

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

/** Span JSONL compatível com o modelo OTLP; exportação best-effort se configurada. */
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
    void exportOtlp(name, traceId, spanId, durationMs, "OK", attributes);
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
    void exportOtlp(name, traceId, spanId, durationMs, "ERROR", attributes);
    throw error;
  }
}

async function exportOtlp(
  name: string,
  traceId: string,
  spanId: string,
  durationMs: number,
  status: string,
  attributes: Record<string, unknown>,
): Promise<void> {
  if (!otlpEndpoint) return;
  try {
    await fetch(`${otlpEndpoint}/v1/traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceSpans: [
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: "autocorrecoes" } }] },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId,
                    spanId,
                    name,
                    startTimeUnixNano: String(Date.now() * 1_000_000),
                    endTimeUnixNano: String((Date.now() + durationMs) * 1_000_000),
                    status: { code: status },
                    attributes: Object.entries(attributes)
                      .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
                      .map(([key, value]) => ({
                        key,
                        value:
                          typeof value === "number"
                            ? { intValue: String(value) }
                            : typeof value === "boolean"
                              ? { boolValue: value }
                              : { stringValue: String(value) },
                      })),
                  },
                ],
              },
            ],
          },
        ],
      }),
    });
  } catch {
    // Exportação remota é opcional.
  }
}
