# Changelog

Todas as mudanças relevantes são documentadas aqui. Formato baseado em
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e
[Semantic Versioning](https://semver.org/lang/pt-BR/).

## [Unreleased]

### Added
- ESLint (`npm run lint`) e gate de lint no CI.
- Métrica de acurácia de severidade no harness de eval.
- Documentação de governança: `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `LICENSE`.

### Changed
- README reestruturado com arquitetura, referências completas e troubleshooting.
- `.env.example` sem placeholder de chave válida, evitando falso "configurado".
- `npm start` inicia o servidor.
- Limpeza periódica dos mapas de tickets SSE e rate limit.

## [1.0.0] - 2026-11-18

### Added
- Auditores determinísticos de design (Playwright/axe-core/Lighthouse), backend (HTTP)
  e código (lint/test/npm audit/padrões estáticos).
- Fiscalização em duas etapas com DeepSeek: Proposer e Verifier independente.
- Pipeline de aprovação humana, backup, rollback, checks pós-apply e re-auditoria.
- Anti-supressão léxica e semântica (PostCSS + Babel AST).
- Redação de segredos, proteção SSRF com validação de redirects e IP fixado,
  e `safeResolve` com `realpath`.
- CLI completa (`audit`, `report`, `runs`, `approve`, `reject`, `apply`, `rollback`,
  `baseline`, `diff`, `jobs`, `retry`, `serve`, `doctor`).
- API Fastify com Swagger, SSE com replay, auth (cookie/Bearer/ticket), rate limit
  e métricas.
- Dashboard React/Vite com aprovação visual, diff, baseline e tendências.
- Fila durável com retry/backoff/dead-letter, agendamento e webhook de P1 novo.
- Migrações versionadas do SQLite, audit trail com receipts e OpenTelemetry.
- Dataset de eval com gate de precisão/recall e workflow de qualidade de IA.
- Dockerfile multi-stage e docker-compose.

[Unreleased]: https://github.com/Alexandre200-lab/autocorrecoes-site/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Alexandre200-lab/autocorrecoes-site/releases/tag/v1.0.0
