import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { config } from "../config/index.js";
import { logger } from "./index.js";

/** SDK oficial: ativo apenas quando OTEL_EXPORTER_OTLP_ENDPOINT está definido. */
let sdk: NodeSDK | null = null;

export function startOtel(): void {
  if (sdk || !config.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  try {
    const endpoint = config.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "");
    sdk = new NodeSDK({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "autocorrecoes" }),
      traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      instrumentations: [
        getNodeAutoInstrumentations({
          "@opentelemetry/instrumentation-fs": { enabled: false },
        }),
      ],
    });
    sdk.start();
    logger.info("otel.started", { endpoint });
  } catch (error) {
    logger.warn("otel.failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function stopOtel(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    // shutdown é best-effort
  } finally {
    sdk = null;
  }
}
