# Contribuindo

Obrigado por contribuir com o AutoCorrecoes. Este documento descreve o fluxo mínimo
para uma mudança ser aceita.

## Pré-requisitos

- Node.js >= 22.5 (`node:sqlite` nativo)
- `npm ci` na raiz e em `dashboard/`
- `npx playwright install chromium` (necessário para testes de design)

## Fluxo

1. Crie um branch a partir de `main`: `git checkout -b feat/minha-mudanca`.
2. Faça a mudança com testes. Novos comportamentos precisam de teste automatizado.
3. Rode a validação local completa:

```bash
npm run lint
npm run typecheck
npm test
npm run eval:mock
npm run build
npm --prefix dashboard run build
```

4. Abra um PR descrevendo **problema**, **mudança**, **risco** e **como testar**.

## Convenções

- Commits no padrão Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`.
- Código e mensagens em português; nomes de identificadores em inglês.
- Nunca comite `.env`, credenciais ou `data/`.
- Mudanças em prompts de IA devem atualizar `PROMPT_VERSION`, o dataset
  `eval/cases.json` (se aplicável) e o CHANGELOG.
- Mudanças no schema do SQLite exigem uma nova migração em
  `src/storage/migrations.ts` — nunca edite uma migração já publicada.

## Segurança

Não abra issues públicas para vulnerabilidades. Siga `SECURITY.md`.

## Áreas que costumam precisar de revisão extra

- `src/security/` (SSRF, redaction, anti-supressão)
- `src/patches/` (aplicação de patches, backup/rollback)
- `src/ai/` (prompts, contratos Zod, custo)
- `src/server/` (auth, fila, agendamento)
