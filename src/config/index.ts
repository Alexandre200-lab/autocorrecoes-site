import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: `${process.cwd()}/.env` });

const boolString = z
  .enum(["true", "false", "1", "0", "yes", "no", ""])
  .transform((value) => value === "true" || value === "1" || value === "yes");

const EnvSchema = z.object({
  DEEPSEEK_API_KEY: z.string().trim().optional(),
  /** Token de acesso à API/dashboard. Vazio = modo desenvolvimento sem auth. */
  API_TOKEN: z.string().trim().optional(),
  DEEPSEEK_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  DEEPSEEK_MODEL: z.string().min(1).default("deepseek-flash"),
  DEEPSEEK_VERIFY_MODEL: z.string().min(1).default("deepseek-flash"),
  /** Segunda verificação independente (modelo diferente) para achados P1. */
  DEEPSEEK_CONSENSUS_P1: boolString.default(false),
  DEEPSEEK_THINKING: boolString.default(false),
  // Valores aceitos pela API DeepSeek: none | low | high | max.
  DEEPSEEK_REASONING_EFFORT: z.enum(["none", "low", "high", "max"]).default("low"),
  AI_BUDGET_USD: z.coerce.number().min(0).default(2),
  DATA_DIR: z.string().min(1).default("./data"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4310),
  HOST: z.string().min(1).default("127.0.0.1"),
  AUDIT_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  /** Requisições por minuto por cliente na API (0 desliga). */
  RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(120),
  PLAYWRIGHT_HEADLESS: boolString.default(true),
  PLAYWRIGHT_VIEWPORT: z.string().default("1440x900"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().trim().default(""),
  /** Webhook opcional acionado quando aparece um achado P1 novo. */
  WEBHOOK_URL: z.string().trim().default(""),
  WEBHOOK_SECRET: z.string().trim().default(""),
});

export type Config = z.infer<typeof EnvSchema> & {
  dataDir: string;
  apiKeyConfigured: boolean;
};

/** Fábrica pura: permite testar configurações alternativas sem variáveis globais. */
export function createConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Configuração inválida: ${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;
  // Cada arquivo de teste roda em um processo filho; isolamos o SQLite por PID
  // para evitar "database is locked" quando o runner executa em paralelo.
  const isTest = Boolean(source.NODE_TEST_CONTEXT || source.NODE_ENV === "test");
  return {
    ...env,
    dataDir: isTest
      ? `${process.cwd()}/data/test-${process.pid}`
      : env.DATA_DIR.startsWith("/")
        ? env.DATA_DIR
        : `${process.cwd()}/${env.DATA_DIR.replace(/^\.\//, "")}`,
    apiKeyConfigured: Boolean(env.DEEPSEEK_API_KEY && env.DEEPSEEK_API_KEY.length > 8),
  };
}

export const config: Config = createConfig();

export function requireApiKey(cfg: Config = config): string {
  if (!cfg.DEEPSEEK_API_KEY) {
    throw new Error(
      "DEEPSEEK_API_KEY não configurada. Copie .env.example para .env e informe sua chave.",
    );
  }
  return cfg.DEEPSEEK_API_KEY;
}

export function viewport(cfg: Config = config): { width: number; height: number } {
  const [w, h] = cfg.PLAYWRIGHT_VIEWPORT.split("x").map(Number);
  return { width: w || 1440, height: h || 900 };
}
