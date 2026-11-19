# Changelog

Todas as mudanças relevantes são documentadas aqui. Formato baseado em
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e
[Semantic Versioning](https://semver.org/lang/pt-BR/).

## [Unreleased]

### Security
- **Fail-closed:** `API_TOKEN` obrigatório em `NODE_ENV=production`; Compose exige o token.
- Rate limit chaveado apenas por identidade autenticada/IP — fecha o bypass via `?token=`.
- Limite próprio de tentativas em `/api/auth/login`.
- `/api/audit` e `/api/baseline` validam alvos locais (`assertSafeAuditRoot`).
- Scripts npm do repositório auditado não são executados por padrão (`AUDIT_ALLOW_NPM_SCRIPTS`); ambiente dos subprocessos é limpo.
- Redação cobre `Bearer`, JWT e secrets sem aspas.
- Faixas IPv6 especiais (6to4, NAT64, Teredo, multicast) documentadas/bloqueadas.
- Tickets SSE vinculados ao IP e com TTL reduzido; CORS por allowlist; `dataDir` removido de `/api/config`.

### Fixed
- Orçamento de IA por execução (auditorias concorrentes não se interferem).
- Verificador usa o sinal de origem do achado, não o primeiro do domínio.
- `untouchedAssertion` é validado no apply, com rollback em violação.
- Re-auditoria preserva as opções originais do run.
- `updateRun` não força status `completed` ao atualizar outros campos.
- Limites de paginação negativos rejeitados (evitava `LIMIT -1`).
- Retries de 4xx não-transitórios eliminados; backoff com teto e jitter.
- Timeout envolvente por auditor; screenshots e varredura de fontes com limites explícitos.
- EventEmitter sem limite de listeners; SSE com limpeza em `error`/`close`.
- Detecção AST de CSS em patches `unified-diff`/`full-file`.
- IDs gerados com `randomUUID()`.
- Portas efêmeras nos testes de API (elimina colisão em paralelo).
- Dashboard: renovação de ticket SSE, `ErrorBoundary`, tratamento de erros, logout, a11y de teclado/ARIA.
- Docker: container não-root, healthcheck parametrizado, `cap_drop`/tmpfs/limites.
- CI: gates de `npm audit high` e Trivy, `permissions` e Compose validado.

### Added
- Testes de regressão: rate limit, redação, paths, `untouchedAssertion`, `applyUnifiedDiff`, origem do sinal, SSE/auth.
- Centralização de magic numbers de configuração e migração `run-options-for-reaudit`.

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
