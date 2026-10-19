# BIOMIE roadmap

## Etapa 1 — Fundação (feito)
- [x] Auth (e-mail/senha, Google, recuperação de senha)
- [x] RBAC server-side + multiempresa + auditoria de papéis
- [x] Banco: dimensões, fatos, metas (BASE/ACTIVE/CHALLENGE), feriados, calendário
- [x] Metric Registry + camada semântica
- [x] Layout, sidebar, filtros globais na URL
- [x] Dados demo (2 empresas, jan/2025 → hoje)
- [x] Cockpit inicial

## Próximas etapas
- [x] Etapa 0: testes de rota corrigidos, sessão real validada (SA/Viewer/Vendedor)
- [x] Plano de Voo (engine, linha de voo, vendedores, drawer, commit, ações, snapshots)
- [x] Snapshot diário agendado (job + reprocessamento admin)
- [x] Seletor de nível de meta ativa na Administração
- [x] data_as_of (demo posicionado na última data)
- [x] Etapa 1.5: bug de login antecipado, link de recuperação expirado, carteira por item/categoria
- [x] Vendas (resumo, evolução, notas, pedidos, itens, drivers, exportação)
- [x] Vendedor 360 (/vendedores/:id)
- [ ] Teste ponta a ponta de logout e troca de senha — aguarda primeira conta real
- [x] Meta: nível central em todas as telas (Cockpit incluído)
- [x] Etapa 3: Equipes + escopo GESTOR, Clientes/Cliente 360, Produtos/Produto 360, drill-down
- [x] Homologação autenticada (Super Admin, Gestor, Vendedor) + correções
- [ ] Atualizar URL do job diário para o endereço publicado (bloqueado: app ainda não publicado)
- [ ] Tela de faixas RFM (futuro)
- [ ] Validação visual autenticada das Etapas 2 e 3 — aguarda primeira conta real
- [ ] Teste de escopo GESTOR com usuário real (teste pronto, opcional: BIOMIE_RLS_E2E=1)
- [x] Etapa 4: Financeiro (recebíveis, aging, títulos, Cliente 360, permissões)
- [ ] Integração Omie (credenciais, sync, jobs) — aguarda credenciais
- [x] Qualidade dos Dados (freshness, pipeline, reconciliação, jobs, saúde)

## Etapa 4.5 + 5 (primeiro marco)
- [ ] Config de ambiente centralizada (APP_ENV/APP_BASE_URL)
- [ ] Scheduler de produção do Plano de Voo
- [ ] Documentar testes pulados
- [ ] docs/BACKUP_AND_RECOVERY.md
- [ ] Credenciais Omie por empresa + testar conexão
- [ ] Framework de sync (OmieClient, RAW, sync runs, checkpoints)
- [ ] Vendedores, Clientes, Produtos → RAW → Canonical + comparação
- [ ] Fonte de dados por empresa (DEMO/OMIE_SHADOW/OMIE) + painel de migração
- [ ] Notas, Pedidos, Financeiro — aguardam aprovação do primeiro marco

## Finalização para handoff ao Codex (plano aprovado 19/10/2026)
- [x] A1 Limitador Omie (global IP + chave/método + concorrência + overrides), 425 = circuit breaker, 429 = backoff, erro permanente sem retry, testes
- [x] A2 Identidade externa, UNIQUE, idempotência, locking de sync, readiness por empresa+entidade+cobertura
- [x] A3 RAW reprocessável (método, hash, página, período, estado); RAW_COMPLETE comprovado por paginação
- [x] P0 Auditoria SECURITY DEFINER/RPC com testes positivos e negativos
- [x] B Notas+itens, Pedidos+itens, Contas a receber+liquidações (Financeiro atual preservado)
- [x] C Backfill from/to (mês como partição) + incremental
- [x] D Central de Integridade
- [x] E Prontidão VPS (env central, cron configurável, processos separados, banco limpo)
- [x] F Testes de contrato + docs (METRICS, SECURITY_RPC, BACKUP, TEST_STATUS, LEGACY_MIGRATION, HANDOFF)

## Bloqueado (fora do alcance aqui)
- [ ] Validar campos transacionais com resposta real do Omie — aguarda chaves das empresas
- [ ] Reapontar agendamento diário para o domínio final — aguarda VPS/publicação (Codex)
