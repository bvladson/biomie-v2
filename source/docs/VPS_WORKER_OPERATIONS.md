# Worker e pipeline Omie na VPS

O worker é um processo separado do servidor web. Ele chama as rotas internas de jobs com autenticação; as telas continuam lendo somente Canonical/Gold. As fórmulas e o contrato de faturamento de `METRICS.md` não foram alterados por este hardening.

## Execução

Fonte: `bun scripts/worker.ts`. Em imagem Node, empacotar com `bun build scripts/worker.ts --target=node --format=esm --outfile=.output/worker.mjs` e executar `node .output/worker.mjs`.

O processo começa pelo primeiro tick imediatamente e aguarda cada chamada terminar antes do próximo tick. Usar apenas uma instância do scheduler. Reiniciar automaticamente quando o processo sair, com intervalo entre reinícios; enviar SIGTERM para desligamento. O proxy da web deve permitir 300 segundos nas rotas internas de jobs. A aplicação mantém um limite de 120 segundos por chamada Omie, contando throttle, tentativas, backoff e leitura do corpo.

| Variável do worker          | Padrão / uso                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `APP_BASE_URL`              | obrigatória; endereço interno da web, por exemplo `http://web:3000`, sem credenciais/query/fragmento          |
| `BIOMIE_JOB_TOKEN`          | obrigatório; mesmo token scheduler guardado em `private.job_secrets`; segredo somente no ambiente do servidor |
| `BIOMIE_WORKER_INTERVAL_MS` | `60000`; pausa entre ticks concluídos                                                                         |
| `BIOMIE_JOB_TIMEOUT_MS`     | `240000`; inclui resposta HTTP completa; intervalo permitido 1000–600000                                      |
| `BIOMIE_SNAPSHOT_HOUR`      | `8`; hora no fuso configurado                                                                                 |
| `BIOMIE_SNAPSHOT_TIME_ZONE` | `UTC`; 08:00 UTC equivale a 05:00 em São Paulo/Fortaleza                                                      |

O `APP_BASE_URL` da **web** pode continuar sendo a URL HTTPS pública; o ambiente do **worker** usa o endereço interno. `private.app_settings.app_base_url`, configurado com `set_app_base_url`, continua representando o endereço HTTPS público. Não colocar o token no código, linha de comando, navegador ou logs.

Na web, `OMIE_GLOBAL_PER_MINUTE`, `OMIE_KEY_METHOD_PER_MINUTE` e `OMIE_MAX_CONCURRENT` configuram o limitador compartilhado no processo. Os padrões são 800, 200 e 3. Esses limites são por processo; escalar a web horizontalmente requer orçamento compartilhado ou reduzir limites por réplica. Os leases impedem repetir uma entidade, mas não substituem um limitador distribuído por IP.

## Migrações e exclusão mútua

Aplicar todas as migrações aditivas operacionais antes de iniciar o worker. O código usa:

- `acquire_omie_worker_lease` / `release_omie_worker_lease`: apenas service role; lease global para backfill e lease por empresa + entidade, inclusive nos passos manuais. TTL padrão de 900 segundos, recuperável após queda de processo.
- `replace_flight_plan_snapshot`: substituição por empresa/data em uma transação; uma falha de inserção conserva o snapshot anterior.
- `replace_omie_canonical_items`: substituição atômica dos itens somente dos documentos da página, incluindo uma lista de itens vazia.

As rotas exigem bearer válido, inclusive na rede interna. Configuração inválida ou RPC de lock ausente falha explicitamente. Não executar simultaneamente o scheduler externo e o pg_cron da mesma tarefa: conferir os agendamentos migrados, pois o pacote original contém uma URL de preview no cron inicial. Os leases protegem colisões acidentais; deve haver uma única autoridade de agendamento.

## Checkpoint e retry

O checkpoint transacional versão 2 mantém partição, próxima página, total de páginas, registros esperados/recebidos e prova de cada mês. Uma página só avança depois de RAW, Canonical, marcação de processamento e checkpoint persistidos. Repetir uma página após uma falha é seguro pelas chaves únicas e substituição atômica de itens.

Checkpoints antigos sem contagens mensais são reexecutados desde o começo do período, com o mesmo run, para obter provas reais. Nenhuma paginação incompleta promove Gold. Campos canônicos inválidos mantêm RAW para inspeção e impedem a promoção. Alterações nos totais de paginação durante a coleta exigem reiniciar a carga; a UI mostra a divergência em vez de inventar cobertura.

Falhas transitórias de rede/timeout/429 retornam ao mesmo checkpoint com espera persistida e backoff, até 8 tentativas consecutivas sem progresso. HTTP 425 abre o circuito chave+método e aguarda pelo menos 5 minutos. Credenciais recusadas, mapeamento inválido ou erro permanente encerram o job como FAILED para intervenção. A fila procura outros jobs enquanto uma tentativa aguarda o horário de retry. Retomar uma execução não a considera abandonada apenas porque começou há mais de 15 minutos.

Se o processo cair depois de concluir o run e antes de concluir o backfill, o próximo tick recupera o resultado persistido e marca a fila DONE. PAUSED/CANCELLED não é sobrescrito pelo fechamento de um passo que já estava em andamento. Um pause interrompe os próximos passos; a página atual pode terminar.

## Snapshot diário

O scheduler marca o dia somente após sucesso. Se iniciar depois da hora configurada, executa o snapshot pendente do dia; se falhar, tenta novamente no tick seguinte. Após um reinício pode repetir o snapshot do mesmo dia; a operação é idempotente e transacional. A data analítica continua vindo de `data_as_of(company)`, sem trocar o contrato de datas por relógio da VPS.

## Antes de habilitar uma empresa real

Os adapters transacionais continuam explicitamente `confirmed: false`; os nomes de campos ainda precisam ser comparados com respostas reais de cada método, conforme `OMIE_TRANSACTIONAL_MAPPING.md`. A validação deve ser feita em homologação/OMIE_SHADOW, com uma página por método. Não transformar a ausência de cStatus em autorização fiscal: somente evidência positiva autoriza receita; cancelamento e denegação têm estados separados.

Sincronizar Vendedores → Clientes → Produtos; depois Notas/Pedidos → Contas a receber → Liquidações. Acompanhar runs, checkpoints, contagens, integridade e `omie_readiness`. Uma conexão bem-sucedida não comprova dados READY. Declarar uma empresa como OMIE somente após cobertura, Canonical/Gold, integridade e reconciliação ao centavo aprovadas.

Não interpretar um job DONE como aprovação financeira: WARNING pode indicar dados não promovidos ou divergências. O critério de prontidão é `omie_readiness`, somado à validação dos campos transacionais.

## Observação e recuperação

Logs do scheduler contêm data UTC, nome da rota, status HTTP, status do job e duração; não imprimem corpo de resposta, bearer ou credenciais Omie. Monitorar ausência de ticks, HTTP 401/5xx, FAILED consecutivo, leases presos por mais que o TTL, jobs sem progresso e atualizações de freshness.

Em falha permanente: corrigir a causa, conferir RAW e a execução correspondente, depois retomar explicitamente o job pela interface. Não apagar RAW, não limpar tabelas para esconder uma divergência e não alterar os checkpoints manualmente. Em desastre de banco, restaurar conforme `BACKUP_AND_RECOVERY.md`; interromper o scheduler durante a restauração e iniciá-lo somente depois das migrações e segredos recuperados.

Validação automatizada sem rede: `vitest run src/lib/omie src/lib/jobs/scheduler.test.ts`, TypeScript e ESLint. Os testes cobrem paginação persistida, ausência de evidência fiscal, timeout do corpo HTTP, Retry-After, execução sem sobreposição, fuso explícito e retry de snapshot. Não provam os formatos reais dos endpoints Omie nem substituem a homologação dos adapters.
