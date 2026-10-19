# BIOMIE — Auditoria de lacunas e plano de finalização para handoff ao Codex

Nada de produção será executado (VPS, backfill real, cutover). Nada já homologado será reconstruído.

## 1. Matriz de lacunas (conferida no código, migrações 0000–0013 e testes)


| Área                                                                      | Implementado         | Parcial                                                    | Ausente                                    | Precisa correção                  |
| ------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------- | ------------------------------------------ | --------------------------------- |
| Fundação, RLS, RBAC, auditoria, CPF/CNPJ mascarado, filtros na URL        | X                    | &nbsp;                                                     | &nbsp;                                     | &nbsp;                            |
| Plano de Voo, Vendas, Vendedor 360, Clientes, Produtos, Equipes           | X                    | &nbsp;                                                     | &nbsp;                                     | &nbsp;                            |
| Financeiro (recebíveis, aging, proteção de inadimplência)                 | X (dados demo)       | &nbsp;                                                     | &nbsp;                                     | &nbsp;                            |
| Qualidade dos Dados                                                       | &nbsp;               | X (sem sincronizações Omie, sem divergências por registro) | &nbsp;                                     | &nbsp;                            |
| Omie: Vendedores / Clientes / Produtos                                    | RAW + Canonical      | Gold não promovido, nunca executado com chave real         | &nbsp;                                     | Readiness baseado só em "sync OK" |
| Omie: Notas fiscais + itens                                               | &nbsp;               | &nbsp;                                                     | X                                          | &nbsp;                            |
| Omie: Pedidos + itens                                                     | &nbsp;               | &nbsp;                                                     | X                                          | &nbsp;                            |
| Omie: Contas a receber, movimentos, liquidações                           | &nbsp;               | &nbsp;                                                     | X                                          | &nbsp;                            |
| Contas a pagar                                                            | fora do escopo atual | &nbsp;                                                     | &nbsp;                                     | &nbsp;                            |
| Rate limit Omie (240/min por chave+método, 4 simultâneas, 425/429)        | &nbsp;               | X (retry/backoff genérico)                                 | limite por chave/método, circuit breaker   | &nbsp;                            |
| Backfill por mês (pausar/retomar/cancelar)                                | &nbsp;               | &nbsp;                                                     | X                                          | &nbsp;                            |
| Incremental com janela de sobreposição                                    | &nbsp;               | &nbsp;                                                     | X                                          | &nbsp;                            |
| Identidade externa única + testes de idempotência                         | &nbsp;               | X (vendors/customers/products)                             | itens com sequência                        | &nbsp;                            |
| Central de Integridade (divergências com status/justificativa)            | &nbsp;               | &nbsp;                                                     | X                                          | &nbsp;                            |
| Fatos sem dimensão ("Sem vendedor/Sem cliente")                           | &nbsp;               | X                                                          | &nbsp;                                     | &nbsp;                            |
| Auditoria de SECURITY DEFINER / RPCs                                      | &nbsp;               | X                                                          | relatório formal                           | &nbsp;                            |
| Preparação VPS (env central, URL do cron, processos web/worker/scheduler) | &nbsp;               | &nbsp;                                                     | X                                          | URL de preview fixa no cron       |
| Testes Omie (cliente, adapters, contrato do pipeline)                     | &nbsp;               | &nbsp;                                                     | X                                          | &nbsp;                            |
| Documentação (métricas, backup, testes pulados, handoff)                  | &nbsp;               | X (HANDOFF_CODEX)                                          | METRICS, BACKUP, TEST_STATUS, SECURITY_RPC | &nbsp;                            |


## 2. Fases de execução (nesta ordem)

**Fase A — Base de confiabilidade Omie**

- Limitador por empresa + App Key + método (240/min, 4 simultâneas), tratamento de 425/429, circuit breaker.
- Readiness novo: PENDING → SYNCING → RAW_COMPLETE → CANONICAL_COMPLETE → GOLD_COMPLETE → RECONCILING → READY / DEGRADED / ERROR, calculado a partir de última execução, contagens esperadas vs recebidas, freshness e divergências.
- RAW com método, hash, página, período solicitado e estado de processamento; reprocessamento RAW → Canonical sem chamar o Omie.

**Fase B — Fatos transacionais P0** (cada um com RAW, Canonical, chave única, checkpoint, reconciliação, freshness)

- Notas fiscais + itens (chave: empresa + nota + sequência do item), contrato único de faturamento (bruto, mercadorias, frete, seguro, outras despesas).
- Pedidos + itens.
- Contas a receber + movimentos/liquidações.
- Promoção para Gold apenas em empresas em OMIE_SHADOW/OMIE; DEMO intocado. Endpoints Omie marcados "não confirmado" até o Codex validar com a API real.

**Fase C — Backfill e incremental**

- Fila de backfill por mês/empresa/entidade com pausar, retomar, cancelar e repetir.
- Incremental com janela de sobreposição, só onde o filtro de data da API estiver confirmado.

**Fase D — Central de Integridade** (evolução de Qualidade dos Dados)

- Saúde por empresa/entidade, freshness, progresso do backfill, sincronizações Omie.
- Divergências por registro: severidade, motivo, primeira/última ocorrência, status, justificativa, resolução.
- Checagens de integridade: fato sem cliente/vendedor, item sem produto, duplicidade, cruzamento entre empresas, documento sem itens, liquidação sem título.

**Fase E — Segurança e prontidão para VPS**

- Revisão de todas as funções privilegiadas (acesso à empresa, IDs arbitrários, inadimplência, CPF/CNPJ).
- Configuração de ambiente centralizada, URL do cron configurável, sem endereços de preview fixos; entradas separadas para web, worker e scheduler.
- Teste de banco limpo (todas as migrações aplicadas do zero).

**Fase F — Testes e documentação para o Codex**

- Testes: cliente Omie (retry, 425/429, página vazia/incompleta, redação de segredos), adapters, idempotência, contrato do pipeline, readiness.
- Docs: METRICS.md, SECURITY_RPC.md, BACKUP_AND_RECOVERY.md, TEST_STATUS.md, LEGACY_MIGRATION.md (metas e dados próprios do MariaDB) e HANDOFF_CODEX.md atualizado com passo a passo VPS.
- Build, typecheck, testes, lint e ZIP final.

## Detalhes técnicos

- Novas migrações a partir de 0014; nenhuma migração existente é editada.
- Adapters novos ficam só em `src/lib/omie/adapters.ts`; fórmulas de faturamento continuam no registry.
- Telas nunca leem RAW nem chamam o Omie; segredos nunca vão ao navegador.
- Trabalho grande: será entregue em fases, com build e testes verdes ao fim de cada uma.

&nbsp;

&nbsp;

Auditoria aprovada. A direção está correta e pode seguir para a implementação, preservando tudo que já está homologado.

Antes de iniciar, incorpore estes ajustes ao plano:

1. O rate limiter deve considerar simultaneamente o teto global de 960 req/min por IP e o limite de 240 req/min por IP + App Key + método, além da concorrência máxima e dos limites especiais de métodos. Os limites internos devem permanecer configuráveis e abaixo do teto.
2. Trate HTTP 425 como abertura de circuit breaker para aquela combinação de App Key + método, sem retry agressivo. Trate 429 com backoff exponencial + jitter. Erros permanentes de payload não devem entrar em retry infinito.
3. Antes de implementar notas, pedidos e financeiro, conclua identidade externa, UNIQUE constraints, idempotência, sync_runs/checkpoints e locking de concorrência.
4. Backfill deve aceitar intervalo `from/to`. Mês será uma estratégia de particionamento, não uma limitação estrutural.
5. Eleve a auditoria de SECURITY DEFINER/RPCs para P0 antes da homologação. Verifique `search_path`, EXECUTE grants, company scope, seller scope, channel scope e dados financeiros/documentais, com testes positivos e negativos.
6. Readiness deve existir por empresa + entidade + cobertura temporal. `READY` exige RAW + Canonical + Gold + reconciliação, não apenas conclusão do sync.
7. `RAW_COMPLETE` precisa ser comprovado pela paginação/metadados do método e persistência concluída, não apenas por página vazia.
8. O módulo Financeiro atual deve ser preservado; o que falta é substituir os dados demo pela pipeline Omie real.

Com esses ajustes incorporados, pode seguir na ordem planejada, sempre executando build, typecheck e testes relacionados após cada fase.

Não acessar VPS, não executar backfill real, não alterar produção e não realizar cutover nesta etapa.