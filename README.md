# AutoCorrecoes

Auditoria e autocorreção de sites (design, backend e código) com o **DeepSeek como fiscalizador independente**.

O sistema separa claramente três decisões:

1. **Auditores determinísticos** coletam sinais objetivos (axe-core, Lighthouse, HTTP, lint, testes, `npm audit`).
2. **Proposer (DeepSeek)** transforma sinais em achados e patches mínimos.
3. **Verifier (DeepSeek, contexto isolado)** confirma ou rejeita o patch **sem ver o raciocínio do Proposer**.
4. **Humano** aprova. Só então o patch é aplicado, com backup, checks locais e **re-auditoria** obrigatória.

> Nada é aplicado sem aprovação. Nenhuma "correção" que esconde o sintoma (`aria-hidden`, `display:none`, `disableRules`, `eslint-disable`, desligar testes/CI) é aceita.

---

## Requisitos

- Node.js **>= 22.5** (usa `node:sqlite` nativo)
- Chave de API da [DeepSeek Platform](https://platform.deepseek.com/api_keys)

---

## Instalação

```bash
npm install
cp .env.example .env
# edite .env e informe DEEPSEEK_API_KEY

# Necessário para auditoria de design (Playwright)
npx playwright install chromium

# Em Linux sem bibliotecas gráficas instaladas (erro "libatk-1.0.so.0"):
npx playwright install-deps chromium
```

Dashboard (interface web):

```bash
cd dashboard && npm install && npm run build && cd ..
```

---

## Uso rápido

```bash
# Auditar site publicado (design + backend)
npm run cli -- audit https://exemplo.com

# Auditar repositório local (código + dependências + checks)
npm run cli -- audit ./meu-projeto

# Coletar sinais sem gastar tokens de IA
npm run cli -- audit https://exemplo.com --no-ai

# Auditar servidor local (hosts privados são bloqueados por padrão)
npm run cli -- audit http://127.0.0.1:3000 --allow-private-hosts

# Gate de CI: relatório SARIF e exit code 1 se houver achado P2 ou pior
node dist/cli/index.js audit https://exemplo.com --no-ai \
  --format sarif --fail-on P2 --output results.sarif

# Ver achados da última execução
npm run cli -- report

# Aprovar e aplicar com re-auditoria
npm run cli -- approve fnd_xxx
npm run cli -- apply --reaudit

# Reverter uma execução
npm run cli -- rollback run_xxx

# Subir API + dashboard
npm run cli -- serve
# abrir http://127.0.0.1:4310
```

Dashboard em modo desenvolvimento (com proxy para a API):

```bash
npm run cli -- serve        # terminal 1
cd dashboard && npm run dev # terminal 2 → http://localhost:5173
```

---

## Modelos DeepSeek

A API é OpenAI-compatible (`https://api.deepseek.com`). Os nomes antigos `deepseek-chat` e `deepseek-reasoner` foram **aposentados em 2026-07-24**.

| Variável | Padrão | Uso |
|---|---|---|
| `DEEPSEEK_MODEL` | `deepseek-flash` | Proposer. Tem **visão** (comparação de screenshots), JSON mode, 1M de contexto. |
| `DEEPSEEK_VERIFY_MODEL` | `deepseek-flash` | Verifier independente. |
| `DEEPSEEK_THINKING` | `false` | Extração estruturada usa thinking desligado (necessário para JSON estável). |
| `DEEPSEEK_REASONING_EFFORT` | `low` | Usado apenas se thinking ligado. Valores: `none`, `low`, `high`, `max`. |
| `AI_BUDGET_USD` | `2` | Teto de gasto por auditoria. `0` desliga o limite. |

O cliente estima custo por token (tarifas de pico), registra cache hits e interrompe a execução ao atingir o teto.

---

## O que é auditado

**Design (URL):** axe-core com tags `wcag2a/2aa/21a/21aa/22aa` em desktop e mobile, contraste, labels, ARIA, imagens quebradas, overflow horizontal, `<html lang>`, `<h1>`, estado interativo (menu/modal), screenshots antes/depois analisados pelo `deepseek-flash` com visão e scores Lighthouse (informativos, nunca gate).

**Backend (URL):** status HTTP, latência p95, headers de segurança (CSP, HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy), `X-Powered-By`, CORS curinga com credenciais, stack traces expostas e métodos mutantes (opcional, desligado por padrão). Por padrão apenas `GET`/`HEAD`.

**Código (path):** git HEAD e árvore suja, `npm run typecheck/lint/test`, `npm audit --audit-level=high`, secrets hardcoded, `console.log`, TODOs e `any` explícito.

> **Limite honesto:** ferramentas automáticas detectam apenas parte dos critérios WCAG. O bucket `incomplete` do axe é registrado como item de revisão humana e **nunca** vira patch. Um relatório verde significa "sem regressões detectáveis", não "conformidade WCAG".

---

## Armazenamento e audit trail

SQLite nativo em `data/autocorrecoes.db` (WAL). Tabelas: `runs`, `signals`, `findings`, `receipts`.

Cada etapa gera um **receipt** com: intenção, comandos executados, incertezas e decisão humana. Spans no formato OTLP são gravados em `data/audit.jsonl` e, se `OTEL_EXPORTER_OTLP_ENDPOINT` estiver definido, exportados via HTTP.

Backups ficam em `data/backups/<runId>/<findingId>/`. Patches para alvos remotos são **exportados** em `data/patches/<runId>/` — o servidor de terceiros nunca é modificado.

---

## Segurança

- Chave apenas em `.env` (nunca no código, nunca enviada ao alvo).
- **Redação de segredos** antes de qualquer trecho do alvo sair do processo (`src/security/redact.ts`), aplicada tanto no auditor quanto no cliente de IA (defesa em profundidade).
- **Proteção SSRF**: hosts loopback/privados/link-local são bloqueados por padrão (`src/security/network.ts`); use `--allow-private-hosts` apenas em testes locais.
- `safeResolve` usa `realpath` para impedir escape por **symlink**.
- Conteúdo de código/HTML/diff tratado como **dado não confiável** e delimitado antes do prompt.
- Anti-supressão cobre `aria-hidden`, `display:none`, `visibility`, `opacity:0`, `pointer-events`, `inert`, `disableRules`, `eslint-disable`, `@ts-*` e desligamento de testes/CI.
- **Migrações versionadas** (`src/storage/migrations.ts`) e escritas transacionais para status + receipts.
- Verifier não recebe raciocínio do Proposer (evita auto-confirmação).
- Anti-supressão bloqueia patches fraudulentos.
- `safeResolve` impede path traversal; `git diff --check` + `npm run typecheck` rodam após cada apply.
- Se os checks falharem, rollback automático e achado marcado como `failed`.
- Dry-run implícito: alvos remotos recebem artefatos, nunca escrita direta.

---

## API REST

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/api/audit` | Inicia auditoria em background (`{ target, type?, domains?, useAI? }`) |
| `GET` | `/api/runs` | Lista execuções |
| `GET` | `/api/runs/:id` | Execução + achados + receipts |
| `GET` | `/api/findings` | Lista achados (`?runId=&status=`) |
| `POST` | `/api/findings/:id/approve` | Aprova |
| `POST` | `/api/findings/:id/reject` | Rejeita |
| `POST` | `/api/apply` | Aplica aprovados (`{ runId?, reaudit? }`) |
| `POST` | `/api/runs/:id/rollback` | Restaura backups |
| `GET` | `/api/events` | Server-Sent Events com progresso |
| `GET` | `/api/metrics` | Contadores (auditorias, achados por severidade, custo de IA, applies) |

> Em pipelines de CI, invoque `node dist/cli/index.js` (ou `npx tsx src/cli/index.ts`) em vez de
> `npm run cli --` — o npm imprime cabeçalhos no stdout e pode corromper relatórios SARIF/JSON.

---

## Avaliação da qualidade da IA

O dataset em `eval/cases.json` mede precisão, recall e bloqueio de patches supressivos:

```bash
EVAL_MOCK=1 npm run eval   # valida o harness sem gastar tokens
npm run eval               # usa DeepSeek real (consome orçamento)
```

O relatório é gravado em `eval/last-report.json`.

## Testes

```bash
npm test
npm run typecheck
npm run build
```

---

## Estrutura

```
src/
  ai/          cliente DeepSeek, schemas Zod, proposer, verifier, prompts
  auditors/    design (Playwright/axe/Lighthouse), backend (HTTP), code (estático)
  patches/     anti-supressão, aplicador de diff, backup/apply/rollback
  pipeline/    orquestrador, dedup por causa, re-auditoria
  storage/     SQLite nativo
  observability/ spans OTLP + JSONL
  server/      Fastify + SSE + estáticos
  cli/         comandos
dashboard/     React + Vite
tests/         node:test
```

Licença MIT.
