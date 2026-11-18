import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: `${process.cwd()}/.env` });

const boolean = z
  .enum(["true", "false", "1", "0", "yes", "no", ""])
  .default("false")
  .transform((v) => v === "true" || v === "1" || v === "yes");

const EnvSchema = z.object({
  DEEPSEEK_API_KEY: z.string().trim().optional(),
  DEEPSEEK_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  DEEPSEEK_MODEL: z.string().min(1).default("deepseek-flash"),
  DEEPSEEK_VERIFY_MODEL: z.string().min(1).default("deepseek-flash"),
  DEEPSEEK_THINKING: boolean,
  // Valores aceitos pela API DeepSeek: none | low | high | max.
  DEEPSEEK_REASONING_EFFORT: z
    .enum(["none", "low", "high", "max"])
    .default("low"),
  AI_BUDGET_USD: z.coerce.number().min(0).default(2),
  DATA_DIR: z.string().min(1).default("./data"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4310),
  HOST: z.string().min(1).default("127.0.0.1"),
  AUDIT_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  PLAYWRIGHT_HEADLESS: boolean.default(true as never),
  PLAYWRIGHT_VIEWPORT: z.string().default("1440x900"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().trim().default(""),
});

export type Config = z.infer<typeof EnvSchema> & {
  dataDir: string;
  apiKeyConfigured: boolean;
};

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  // Config inválida deve falhar cedo, com erro legível.
  console.error("Configuração inválida:", z.prettifyError(parsed.error));
  process.exit(1);
}

const env = parsed.data;

export const config: Config = {
  ...env,
  dataDir: env.DATA_DIR.startsWith("/")
    ? env.DATA_DIR
    : `${process.cwd()}/${env.DATA_DIR.replace(/^\.\//, "")}`,
  apiKeyConfigured: Boolean(env.DEEPSEEK_API_KEY && env.DEEPSEEK_API_KEY.length > 8),
};

export function requireApiKey(): string {
  if (!env.DEEPSEEK_API_KEY) {
    throw new Error(
      "DEEPSEEK_API_KEY não configurada. Copie .env.example para .env e informe sua chave.",
    );
  }
  return env.DEEPSEEK_API_KEY;
}

export function viewport(): { width: number; height: number } {
  const [w, h] = env.PLAYWRIGHT_VIEWPORT.split("x").map(Number);
  return { width: w || 1440, height: h || 900 };
}
