# Política de Segurança

## Versões suportadas

| Versão | Suporte |
|---|---|
| 1.x | ✅ Correções de segurança |
| < 1.0 | ❌ Sem suporte |

## Reportando uma vulnerabilidade

**Não abra uma issue pública.** Envie um e-mail privado aos mantenedores com:

- descrição do problema e impacto;
- passos de reprodução (comando, payload ou config);
- versão afetada e ambiente (Node, OS, Docker);
- sugestão de correção, se houver.

Prazo de resposta esperado: até 5 dias úteis. Pedimos 90 dias de divulgação
responsável antes de publicar detalhes.

## Superfície de ataque

- **Alvos auditados são dados não confiáveis.** Todo HTML/código/diff é delimitado
  e tratado como dado antes de entrar no prompt.
- **SSRF:** hosts privados são bloqueados por padrão; redirects são revalidados e
  o IP resolvido é fixado na conexão. Use `--allow-private-hosts` apenas em testes.
- **Segredos:** redigidos antes de sair do processo (`src/security/redact.ts`).
- **Patches:** anti-supressão léxica + AST; backup, checks locais e rollback automático.
- **API:** `API_TOKEN` obrigatório em produção, cookie httpOnly no dashboard,
  tickets de curta duração para SSE e rate limit por identidade.

## Configuração recomendada em produção

```bash
API_TOKEN=$(openssl rand -hex 32)
DEEPSEEK_API_KEY=<chave real>
RATE_LIMIT_MAX=120
WEBHOOK_URL=<opcional>
WEBHOOK_SECRET=$(openssl rand -hex 32)
```

- Não exponha a API diretamente sem HTTPS; o cookie só recebe o atributo `Secure`
  quando a requisição é HTTPS (ou atrás de proxy com `X-Forwarded-Proto: https`).
- `data/` contém relatórios, backups e evidências — trate como dado sensível.
- Rotacione `API_TOKEN` e `DEEPSEEK_API_KEY` periodicamente.
