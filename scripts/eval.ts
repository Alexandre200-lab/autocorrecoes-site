/**
 * Harness de avaliação da qualidade do fiscalizador.
 * Uso:
 *   npm run eval            → usa DeepSeek real (consome orçamento)
 *   EVAL_MOCK=1 npm run eval → usa provider determinístico (valida o harness)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { propose } from "../src/ai/proposer.js";
import { verify } from "../src/ai/verifier.js";
import { deepSeekProvider, type AiProvider } from "../src/ai/provider.js";
import { getBudget, resetBudget, type CompletionArgs } from "../src/ai/client.js";
import { newId, store } from "../src/storage/index.js";
import type { AuditRun, Domain, RawSignal } from "../src/shared/types.js";

interface EvalCase {
  id: string;
  description: string;
  domain: Domain;
  ruleId: string;
  expectedFinding: boolean;
  expectedSeverity?: string;
  expectSuppressionBlocked?: boolean;
  requiresHuman?: boolean;
}

const cases = JSON.parse(
  readFileSync(join(process.cwd(), "eval", "cases.json"), "utf8"),
) as EvalCase[];

const mockProvider: AiProvider = {
  name: "eval-mock",
  async complete(args: CompletionArgs) {
    const system = args.system;
    if (system.includes("revisor independente")) {
      return JSON.stringify({
        valid: true,
        reason: "Mock: evidência suficiente.",
        confidence: "high",
        suppressionDetected: false,
        recommendedStatus: "verified",
      });
    }
    const rule = /### Sinal 1 \[([^\]]+)\]/.exec(args.user)?.[1] ?? "UNKNOWN";
    const testCase = cases.find((c) => c.ruleId === rule);
    if (!testCase || (!testCase.expectedFinding && !testCase.expectSuppressionBlocked)) {
      return JSON.stringify({ findings: [] });
    }
    const suppression = Boolean(testCase.expectSuppressionBlocked);
    return JSON.stringify({
      findings: [
        {
          sourceRuleId: rule,
          signalIndex: 1,
          domain: testCase.domain,
          severity: "P3",
          title: `Achado de teste ${rule}`,
          observedBehavior: "Comportamento observado no sinal determinístico.",
          impact: "Impacto representativo para avaliação do fiscalizador.",
          evidence: `evidência de ${rule}`,
          suggestedFix: suppression ? "Ocultar elementoproblemático" : "Corrigir a causa raiz.",
          confidence: "high",
          checksRun: [],
          checksSuggested: [],
          uncertainty: "Caso sintético de avaliação.",
          patch: {
            format: "css-rule",
            files: ["style.css"],
            content: suppression ? ".erro { display: none; }" : ".erro { color: #b00; }",
            riskNotes: [],
            untouchedAssertion: ["demais estilos"],
          },
        },
      ],
    });
  },
};

function makeRun(testCase: EvalCase): AuditRun {
  const signal: RawSignal = {
    domain: testCase.domain,
    ruleId: testCase.ruleId,
    title: `Sinal ${testCase.ruleId}`,
    message: "Sinal sintético do dataset de avaliação.",
    severity: "P3",
    url: testCase.domain === "code" ? undefined : "https://example.com",
    path: testCase.domain === "code" ? "app.js" : undefined,
    evidence: `evidência determinística de ${testCase.ruleId}`,
    metadata: testCase.requiresHuman ? { requiresHuman: true } : undefined,
  };
  const run: AuditRun = {
    id: newId("eval"),
    targetType: testCase.domain === "code" ? "path" : "url",
    target: testCase.domain === "code" ? process.cwd() : "https://example.com",
    startedAt: new Date().toISOString(),
    status: "completed",
    signals: [signal],
    checksRun: [],
    checksNotRun: [],
  };
  store.createRun(run);
  store.insertSignal(run.id, signal);
  return run;
}

async function main(): Promise<void> {
  const provider = process.env.EVAL_MOCK === "1" ? mockProvider : deepSeekProvider;
  resetBudget();
  const results: Array<Record<string, unknown>> = [];
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let blocksOk = 0;
  let blocksTotal = 0;

  for (const testCase of cases) {
    const run = makeRun(testCase);
    const findings = await propose(run, `Caso: ${testCase.description}`, provider);
    for (const finding of findings) await verify(finding, run, provider);
    const produced = findings.length > 0;

    if (testCase.expectedFinding && produced) truePositives += 1;
    if (testCase.expectedFinding && !produced) falseNegatives += 1;
    if (!testCase.expectedFinding && produced) falsePositives += 1;
    if (testCase.expectSuppressionBlocked) {
      blocksTotal += 1;
      if (!produced) blocksOk += 1;
    }

    results.push({
      id: testCase.id,
      expected: testCase.expectedFinding,
      produced,
      accepted: findings.filter((f) => f.status === "verified").length,
      correct: produced === testCase.expectedFinding,
    });
    console.log(
      `${produced === testCase.expectedFinding ? "OK  " : "FALHA"} ${testCase.id}: ` +
        `esperado=${testCase.expectedFinding} produzido=${produced}`,
    );
  }

  const precision = truePositives / (truePositives + falsePositives || 1);
  const recall = truePositives / (truePositives + falseNegatives || 1);
  const minPrecision = Number(process.env.EVAL_MIN_PRECISION ?? 0.7);
  const minRecall = Number(process.env.EVAL_MIN_RECALL ?? 0.7);
  const passed = precision >= minPrecision && recall >= minRecall;
  const report = {
    generatedAt: new Date().toISOString(),
    provider: provider.name,
    promptVersion: "1.2.0",
    cases: results,
    precision: Number(precision.toFixed(3)),
    recall: Number(recall.toFixed(3)),
    suppressionBlocks: `${blocksOk}/${blocksTotal}`,
    thresholds: { precision: minPrecision, recall: minRecall },
    passed,
    costUsd: Number(getBudget().spentUsd.toFixed(6)),
  };
  const dir = join(process.cwd(), "eval");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "last-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `\nPrecisão: ${report.precision} (mín ${minPrecision}) | ` +
      `Recall: ${report.recall} (mín ${minRecall}) | ` +
      `Supressões bloqueadas: ${report.suppressionBlocks} | Custo: $${report.costUsd}`,
  );
  console.log(`Relatório: eval/last-report.json`);
  if (!passed) {
    console.error("Gate de qualidade da IA FALHOU. Ajuste prompts/modelo antes de publicar.");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
