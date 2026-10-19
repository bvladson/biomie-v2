# Auditoria de funções privilegiadas (SECURITY DEFINER / RPC)

Auditado em 19/10/2026 contra o banco real (`pg_proc`).

## Resultado
- Todas as funções SECURITY DEFINER do schema `public` têm `search_path` fixo.
- **Corrigido (migração 0014):** o papel anônimo tinha EXECUTE em ~25 funções privilegiadas. Agora nenhuma função SECURITY DEFINER pode ser executada sem login. `audit_user_roles` (trigger) não pode ser chamada diretamente.
- Testes negativos: `src/test/rpc-security.test.ts` (roda sempre, só com a chave pública).
- Testes positivos/negativos por papel (GESTOR/VENDEDOR/finance): opt-in `BIOMIE_RLS_E2E=1` com service role.

## Matriz
| Função | Quem executa | Verifica empresa | Escopo vendedor | Dados sensíveis |
|---|---|---|---|---|
| get_integration_credentials, ingest_omie_raw, mark_raw_processed, finish_omie_full_sync, promote_omie_gold | só service_role (`is_service_request`) | parâmetro, job confiável | n/a | credenciais/RAW |
| set_integration_credentials, omie_comparison, resolve_omie_match, compute_omie_matches, omie_migration_status, manage_backfill, resolve_integrity_issue, omie_readiness | admin via `integration_admin_assert` | sim | n/a | nunca devolve segredo |
| set_company_data_source | admin; OMIE exige SUPER_ADMIN + "ATIVAR OMIE" + READY | sim | n/a | — |
| run_integrity_checks | admin ou service_role | sim | n/a | — |
| finance_summary, finance_titles_list, finance_customer | autenticado + `finance_assert` (capability) | sim | via `visible_seller_ids` | inadimplência removida sem `finance.view_overdue` |
| finance_title_facts | interno (sem EXECUTE para app) | — | — | — |
| customer_document | autenticado; sempre mascarado | via RLS | sim | CPF/CNPJ mascarado |
| reveal_customer_document | `documents:view_full` + justificativa + audit_log | sim | sim | CPF/CNPJ completo |
| run_reconciliation, quality_job_runs, data_freshness | `quality_assert` | sim | n/a | — |
| set_app_base_url | SUPER_ADMIN ou service_role | n/a | n/a | — |
| accessible_company_ids, visible_*_ids, can_*, has_role, is_admin | autenticado (usadas pelas policies) | — | — | só devolvem IDs do próprio usuário |

## Pendências
- Escopo por canal não existe como regra de negócio hoje; se for criado, entra em `visible_seller_ids`.
- IDs arbitrários: funções que aceitam `p_company` sempre chamam `assert_company_access`/`integration_admin_assert`/`finance_assert`.
