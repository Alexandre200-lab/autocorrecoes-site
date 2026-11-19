import { config, requireApiKey } from "../config/index.js";
import { logger } from "../observability/index.js";
import { recordAi } from "../observability/metrics.js";
import { redactSecrets } from "../security/redact.js";
import type { BudgetState } from "../shared/types.js";

/**
 * Cliente OpenAI-compatible para a API DeepSeek.
 * Base URL: https://api.deepseek.com  (modelos: deepseek-flash, deepseek-v4-pro)
 * Documentação: https://api-docs.deepseek.com
 */

const DEFAULT_BUDGET_KEY = "default";
/** Orçamento por execução: auditorias concorrentes não podem zerar uma à outra. */
const budgets = new Map<string, BudgetState>();

function freshBudget(limitUsd: number): BudgetState {
  return {
    spentUsd: 0,
    limitUsd,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
  };
}

function budgetFor(key: string): BudgetState {
  let state = budgets.get(key);
  if (!state) {
    state = freshBudget(config.AI_BUDGET_USD);
    budgets.set(key, state);
  }
  return state;
}

export function resetBudget(
  limitUsd = config.AI_BUDGET_USD,
  key = DEFAULT_BUDGET_KEY,
): void {
  budgets.set(key, freshBudget(limitUsd));
}

export function getBudget(key = DEFAULT_BUDGET_KEY): BudgetState {
  return { ...budgetFor(key) };
}

// Tarifas de pico (valores conservadores) em USD por 1M tokens.
const PRICE_INPUT_CACHE_MISS = 0.3;
const PRICE_INPUT_CACHE_HIT = 0.006;
const PRICE_OUTPUT = 1.2;

export class BudgetExceededError extends Error {
  constructor(limit: number) {
    super(`Limite de gasto de $${limit.toFixed(2)} atingido. Ajuste AI_BUDGET_USD no .env.`);
    this.name = "BudgetExceededError";
  }
}

export interface CompletionArgs {
  system: string;
  user: string;
  model?: string;
  json?: boolean;
  thinking?: boolean;
  maxTokens?: number;
  traceId?: string;
  label?: string;
  /** data URLs de imagens para modelos com visão (deepseek-flash). */
  images?: string[];
}

function estimateCost(usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}): number {
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return (
    ((Math.max(0, prompt - cached) / 1_000_000) * PRICE_INPUT_CACHE_MISS) +
    ((cached / 1_000_000) * PRICE_INPUT_CACHE_HIT) +
    ((completion / 1_000_000) * PRICE_OUTPUT)
  );
}

function sanitize(text: string): string {
  // Remove caracteres de controle que poderiam confundir delimitadores de prompt.
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff exponencial limitado, com jitter e suporte a Retry-After numérico ou HTTP-date. */
function retryDelay(retryAfter: string | null, attempt: number): number {
  const capMs = 30_000;
  let delay = Math.min(1000 * 2 ** attempt, capMs);
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      delay = Math.min(seconds * 1000, capMs);
    } else {
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) delay = Math.min(Math.max(0, date - Date.now()), capMs);
    }
  }
  return delay + Math.floor(Math.random() * 250);
}

function isTransient(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof Error &&
      ["TimeoutError", "AbortError"].includes(error.name))
  );
}

export async function complete(args: CompletionArgs): Promise<string> {
  const budget = budgetFor(args.traceId ?? DEFAULT_BUDGET_KEY);
  if (budget.limitUsd > 0 && budget.spentUsd >= budget.limitUsd) {
    throw new BudgetExceededError(budget.limitUsd);
  }

  const key = requireApiKey();
  const thinking = args.thinking ?? config.DEEPSEEK_THINKING;
  // Redação defensiva: mesmo que um auditor esqueça de redatar, o segredo não sai.
  const systemText = redactSecrets(sanitize(args.system));
  const userText = redactSecrets(sanitize(args.user));
  const userContent: unknown = args.images?.length
    ? [
        { type: "text", text: userText },
        ...args.images.map((url) => ({ type: "image_url", image_url: { url } })),
      ]
    : userText;

  const body: Record<string, unknown> = {
    model: args.model ?? config.DEEPSEEK_MODEL,
    messages: [
      { role: "system", content: systemText },
      { role: "user", content: userContent },
    ],
    stream: false,
    thinking: { type: thinking ? "enabled" : "disabled" },
    max_tokens: args.maxTokens ?? 4096,
  };

  // reasoning_effort só faz sentido em thinking mode (a API rejeita alguns
  // combinados com tool_choice/JSON estrito quando thinking está ligado).
  if (thinking) body.reasoning_effort = config.DEEPSEEK_REASONING_EFFORT;
  if (!thinking) body.temperature = 0;
  if (args.json) body.response_format = { type: "json_object" };

  const url = `${config.DEEPSEEK_BASE_URL.replace(/\/$/, "")}/chat/completions`;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Revalida o teto a cada tentativa: retries não podem estourar o orçamento.
    if (budget.limitUsd > 0 && budget.spentUsd >= budget.limitUsd) {
      throw new BudgetExceededError(budget.limitUsd);
    }
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.AUDIT_TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = await response.text();
        const error = new Error(`DeepSeek HTTP ${response.status}: ${text.slice(0, 500)}`);
        // 4xx diferentes de 408/429 são erros do chamador: nunca devem ser retentados.
        const retryable =
          response.status === 408 || response.status === 429 || response.status >= 500;
        if (!retryable || attempt === 2) throw error;
        lastError = error;
        await sleep(retryDelay(response.headers.get("retry-after"), attempt));
        continue;
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      if (!content.trim()) throw new Error("DeepSeek retornou conteúdo vazio.");

      const usage = data.usage ?? {};
      const cost = estimateCost(usage);
      budget.promptTokens += usage.prompt_tokens ?? 0;
      budget.completionTokens += usage.completion_tokens ?? 0;
      budget.cachedTokens += usage.prompt_tokens_details?.cached_tokens ?? 0;
      budget.spentUsd += cost;
      recordAi(
        { prompt: usage.prompt_tokens ?? 0, completion: usage.completion_tokens ?? 0 },
        cost,
      );

      logger.info("ai.completion", {
        label: args.label ?? "completion",
        model: body.model,
        costUsd: Number(cost.toFixed(6)),
        totalUsd: Number(budget.spentUsd.toFixed(6)),
        traceId: args.traceId,
      });
      return content;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (isTransient(error) && attempt < 2) {
        await sleep(retryDelay(null, attempt));
        continue;
      }
      throw lastError;
    }
  }

  logger.error("ai.completion.failed", {
    label: args.label ?? "completion",
    message: lastError?.message,
  });
  throw lastError ?? new Error("Falha desconhecida ao chamar DeepSeek.");
}
