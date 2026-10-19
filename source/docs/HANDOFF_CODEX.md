# BIOMIE — Handoff para o Codex (implantação na VPS)

## Sistema
TanStack Start v1 (React 19, Vite 7), Tailwind v4, Postgres com RLS. Regras: `AGENTS.md` + `src/*/AGENTS.md` (ler antes de mudar código).
Pronto e homologado (dados DEMO): Cockpit, Plano de Voo, Vendas, Vendedor 360, Clientes/Cliente 360, Produtos/Produto 360, Financeiro, Qualidade dos Dados, RBAC/Equipes, auditoria, exportações.

## Pipeline Omie (código pronto, NÃO executado com chave real)
OMIE → RAW (`raw_omie_*`, reprocessável) → CANONICAL (`canonical_*`) → GOLD (sellers/customers/products/invoices/sales_orders/financial_titles com `source='omie'` + `external_id`) → telas.
- Cadastros: `src/lib/omie/sync.server.ts`. Fatos (notas+itens, pedidos+itens, contas a receber, liquidações): `src/lib/omie/sync-tx.server.ts`.
- Formato Omie só em `src/lib/omie/adapters.ts`. Campos transacionais **não confirmados** — ver `docs/OMIE_TRANSACTIONAL_MAPPING.md`.
- Limites: `src/lib/omie/rate-limiter.ts` (global, chave+método, concorrência, overrides; 425 abre circuito; 429 backoff).
- Idempotência: UNIQUE (empresa, fonte, external_id) em todas as camadas; itens por (documento, sequência).
- Lock: um RUNNING por empresa+entidade (índice único). Checkpoint por mês/página.
- Readiness: `omie_readiness(company)` — READY só com RAW comprovado + Canonical + Gold + sem divergência grave + < 36h.
- Gold só é promovido em empresa real com fonte OMIE_SHADOW/OMIE. DEMO nunca é tocado.
- Central de Integridade: Qualidade dos Dados e Integrações (prontidão, backfill, divergências, execuções).
- Backfill: `manage_backfill` (from/to; mês é partição) + worker `/api/public/jobs/omie-backfill`.

## Banco
Migrações em `drizzle/migrations/0000…0015` — aplicar em ordem num banco limpo. Não editar as aplicadas.
Depois de publicar: `select public.set_app_base_url('https://<dominio>');`.
Atenção: o agendamento pg_cron da migração 0003 ainda aponta para a URL de preview. Na VPS, preferir o processo `scripts/worker.ts` (abaixo) ou recriar o cron apontando para o domínio.

## Serviços na VPS
| Processo | Comando | Função |
|---|---|---|
| web | `bun run build && node .output/server/index.mjs` (ou adapter Node do TanStack Start) | telas + server functions + rotas `/api/public/jobs/*` |
| worker/scheduler | `bun scripts/worker.ts` | chama backfill a cada minuto e snapshot diário 08:00 UTC |
| webhook worker | não necessário agora (Omie via polling); se adotado, usar idempotência por `external_id` + hash |

Env: `APP_ENV`, `APP_BASE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `BIOMIE_JOB_TOKEN` (= `private.job_secrets` 'scheduler'), opcionais `OMIE_*` (ver `src/lib/env.server.ts`).
Código específico Cloudflare: build alvo Workers em `vite.config.ts`; para Node, trocar o preset de deploy do TanStack Start. Sem URLs Lovable no código da aplicação (só no `previewAuthStorage.ts` gerado, inofensivo fora do preview).

## Ordem de implantação
1. Banco de homologação limpo → migrações → `bunx vitest run`.
2. Cadastrar App Key/Secret das 5 empresas na tela Integrações; Testar conexão.
3. Fonte = OMIE_SHADOW; sincronizar Vendedores → Clientes → Produtos.
4. Validar uma página de cada método transacional contra `OMIE_TRANSACTIONAL_MAPPING.md`; ajustar adapters.
5. Backfill por período (ex.: 2024-01-01 → hoje) de notas, pedidos, contas a receber; depois liquidações.
6. Central de Integridade: todas as entidades READY, divergências resolvidas com justificativa; reconciliação ao centavo com relatórios do Omie e do BIOMIE antigo.
7. Migrar dados próprios do MariaDB (`docs/LEGACY_MIGRATION.md`).
8. Cutover: "ATIVAR OMIE" por empresa; backup final do MariaDB; desligar legado.

## Documentos
`METRICS.md`, `SECURITY_RPC.md`, `BACKUP_AND_RECOVERY.md`, `TEST_STATUS.md`, `LEGACY_MIGRATION.md`, `OMIE_FINANCIAL_MAPPING.md`, `OMIE_TRANSACTIONAL_MAPPING.md`.

## Regras invioláveis
Telas nunca chamam o Omie nem leem RAW; credenciais nunca vão ao navegador/logs; DEMO nunca é apagado; divergências visíveis, nunca ajustadas; fórmulas só no registry/engines.
