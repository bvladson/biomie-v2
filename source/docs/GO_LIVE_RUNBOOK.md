# BIOMIE v2 — Runbook de produção (VPS 179.197.238.57)

Este documento descreve como a v2 é implantada, operada e revertida. Os comandos
rodam no PC de operação, na raiz da pasta de deploy, e chegam à VPS por SSH.

## 1. Versão rastreável

- O repositório git da pasta de deploy é a fonte de verdade. Tag do estado
  recebido do deploy anterior: `received-20261019`.
- `python ops/upload_release.py [commit]` envia **exatamente** `<commit>:source`
  (git archive, nunca a árvore de trabalho) para `/opt/biomie-v2/releases/<sha12>/`
  com `RELEASE.json`.
- `python ops/remote.py ops/21_activate_release.py <sha12> [--start-worker]`:
  1. aponta `stack.env` para a release (`RELEASE_ID`, `SOURCE_DIR`, `BIOMIE_GIT_COMMIT`);
  2. faz `pg_dump` verificado antes de qualquer migração (`/var/backups/biomie-v2/pre-migrate-*`);
  3. aplica as migrações (com checksum; migração já aplicada nunca é editada);
  4. esconde as empresas DEMO e deixa o worker **pausado**;
  5. constrói `biomie-v2-web:<sha12>` e confere o rótulo `org.opencontainers.image.revision`;
  6. recria web (e worker) e espera ficarem saudáveis.
- Testes antes de ativar: `npx vitest run`, `tsc -p tsconfig.scripts.json`,
  `eslint`, e `python ops/remote.py ops/22_test_database.py <sha12>` (cria
  `biomie_v2_test`, aplica todas as migrações do zero, roda as suítes SQL e apaga).
  O banco de produção nunca é usado para testes.

## 2. Segredos

- `shared/stack.env` (0600, root): senhas do Postgres, segredo JWT, chaves anon e
  service, token de jobs e `BIOMIE_CREDENTIALS_KEY`. `deploy/vps/stackctl.py` gera e
  altera sem imprimir valores (só impressões digitais).
- Rotação do segredo JWT: `python ops/remote.py ops/20_rotate_and_harden.py <sha12>`
  (invalida as chaves antigas; a chave anon fica embutida no bundle, então a
  próxima ativação precisa reconstruir a imagem).
- O gateway tem dois servidores: **público** (127.0.0.1:3140, único alvo do nginx
  do domínio) recusa a chave de serviço e a administração do GoTrue; **interno**
  (127.0.0.1:3141) só para web, worker e operação.
- Credenciais do Omie: cifradas no servidor (AES-256-GCM, chave fora do banco,
  texto cifrado amarrado à empresa e ao campo). A tabela só aceita `enc:v1:`.
  `ops/23_credentials.py` recifra, valida e testa as conexões.
- Testes nunca gravam credenciais em arquivo. As contas do teste de fumaça
  (`ops/29_smoke.py`) nascem com senha em memória e são apagadas no fim.

## 3. Worker (única fonte de chamadas ao Omie)

- Serviço `worker` do compose. A tela só enfileira cargas (`manage_backfill`).
- Controle: `python ops/remote.py ops/25_load.py pause|resume|status`, ou na tela
  Integrações (SUPER_ADMIN). Recorrência: `python ops/remote.py ops/25_load.py recurring on|off`
  (ligada desde a virada de 19/10/2026).
- Recorrência (quando ligada): notas, pedidos, títulos e liquidações dos últimos
  62 dias nos minutos 21 e 51 de cada hora (`BIOMIE_RECURRING_TX_MINUTES`, as
  janelas livres do legado; um horário perdido espera o próximo). Contas a receber
  sempre trazem também os títulos com emissão futura (uma partição extra de 730
  dias). Cadastros diários às 06h; reprocessamento do ano aos domingos às 05h;
  fotografia do Plano de Voo às 08h (America/Fortaleza). Cadastros e reprocessamento
  semanal consultam a fila antes de enfileirar, então um reinício não repete o lote do dia.
- Se o Omie muda o total de registros de um mês no meio da paginação (títulos
  criados durante o expediente), a carga relê aquele mês desde a página 1, até 3
  vezes, respeitando os 61 s entre consultas idênticas; só então falha, sem
  afirmar cobertura. O próximo ciclo recorrente refaz o período.
- Toda nova tentativa de chamada ao Omie aparece no log do worker
  (`omie retry call=... kind=... wait_ms=...`, mensagem já mascarada).
- Durante um ciclo recorrente a prontidão mostra `DEGRADED` para as entidades com
  job na fila; ela volta a `READY` quando o ciclo termina (minutos).
- Proteções: cede quando a carga por CPU da máquina passa de 0,75; janelas
  proibidas em `BIOMIE_WORKER_BLACKOUTS` (ex.: manutenção VSB 20/10 19h30–21h);
  limitador do Omie com 61 s entre consultas idênticas, circuito de 30 min no 425,
  pausa da chave em erro de autenticação ou após 5 erros em 30 min.
- "Já existe uma requisição desse método sendo executada": nova tentativa após
  20 s (conta no orçamento de erros) e pausa mínima de 2 s entre o fim de uma
  chamada e a próxima do mesmo método na mesma chave (`OMIE_MIN_METHOD_GAP_MS`).
  O legado usa os mesmos aplicativos: sincronização comercial a cada 15 min e
  financeira 7 min depois.
- Ajuste fino: `python ops/remote.py ops/25_load.py tune CHAVE=VALOR` (só chaves
  não secretas listadas no stackctl).

## 4. Regras de negócio implementadas

- **Empresa = autorização, canal = filtro.** Concessões antigas de varejo/licitação
  viraram histórico e não escondem dados (migração 0031).
- **Canal pela regra oficial do vendedor** (29/09/2026): override manual > cliente
  do grupo (`outros`, fora dos números) > código do vendedor "Licitação" > nome
  normalizado `LICITACAO` > varejo. Observação, projeto, tipo de cliente e canal
  padrão da empresa nunca classificam. O motivo fica em `channel_reason`.
- **Faturamento comercial** = bruto − frete − outras despesas − seguro (IPI fica),
  calculado do payload do Omie.
- **Notas não autorizadas** (data de inutilização, pedido devolvido/cancelado ou
  sem evidência de autorização) ficam visíveis como "Não autorizada" e nunca
  entram na receita (mesma regra do legado `FiscalSupport`).
- **Pedidos**: operação pelo CFOP dos itens; sem CFOP reconhecido o pedido é
  preservado, fica fora da carteira e aparece na Central de Integridade.
- **Operação pelo CFOP** (padrões da carga real de 2026, mesma decisão do override
  manual do legado nas NFs 1285/1286): venda para entrega futura conta uma vez,
  no faturamento (5922/6922); a remessa da entrega (5116/5117/6116/6117) é
  remessa. Remessa por conta e ordem (5923/6923), transferências
  (5151/5152/5409/6151/6152/6409) e 5904 são remessa. Venda com itens de
  bonificação (5910/6910) segue venda. Outras saídas (5949/6949) e notas que
  misturam venda com remessa ficam pendentes, preservadas e visíveis.
- **Financeiro** (carga real de 19/10/2026): o Recebido é o valor de cada baixa
  (`resumo.nValPago`); um depósito que quita vários títulos conta uma vez.
  Desconto, juros e multa da baixa ajustam o saldo na data da baixa, e a baixa só
  de desconto fecha o título. Impostos retidos pelo cliente (`retem_X = S`: IR,
  PIS, COFINS, CSLL, ISS, INSS) não ficam em aberto. Título RECEBIDO no Omie sem
  baixa importada mantém o saldo e aparece como pendência MEDIUM. Causa encontrada
  em 20/10/2026: baixa lançada no Omie com o ano errado na data de pagamento
  (2002, 2025), anterior à emissão do título; a carga busca baixas por data de
  pagamento a partir de 2026. Corrigida a data no Omie, o reprocessamento de
  domingo importa a baixa e fecha o título.
- **Metas**: período sem meta cadastrada aparece como "Meta não cadastrada para o
  período", nunca como R$ 0. A v2 não tem tela de metas; depois da virada a tela do
  legado não é mais acessível, então metas novas são carregadas por script.
- **Metas**: Compromisso do legado = meta Ativa; Superação = Desafio; Excelência e
  Nível 4 ficam arquivados. A meta do Cockpit é a soma das metas por vendedor; as
  metas mensais por empresa do legado (MAG Filial varejo R$ 350 mil) estão
  arquivadas, não exibidas.

## 5. Backup e restauração

- Diário 03h20: `/opt/biomie-v2/bin/backup.py run` (cron `/etc/cron.d/biomie-v2-backup`).
  Pacote = pg_dump + papéis + stack.env + gateway + compose + nginx + RELEASE.json,
  cifrado com gpg AES256 antes de sair do processo; cópia externa em
  `backups/biomie-v2-db` (mesmo destino do legado), sha256 conferido, 30 dias.
- Semanal domingo 03h50: restauração real da cópia externa mais nova num
  PostgreSQL temporário sem rede (`backup.py restore-test --offsite`).
- **Senha dos backups**: `/opt/biomie-v2/shared/backup.passphrase` e uma cópia
  fora da VPS (PC de operação, pasta `Documents/BIOMIE-v2-SEGREDOS`). Guarde-a no
  cofre de senhas: sem ela nenhum backup externo pode ser restaurado.
- Restauração completa:
  1. `gpg -d` do pacote com a senha → `tar -xf`;
  2. `psql` com `globals.sql` (papéis) num PostgreSQL 17 limpo;
  3. `pg_restore -d biomie_v2 database.dump`;
  4. recolocar `stack.env`, `gateway.conf`, `compose.yml` em `/opt/biomie-v2/` e
     a release de `RELEASE.json`; `docker compose up -d`.

## 6. Troca de endereço e reversão

- Endurecimento antes da troca: `python ops/remote.py ops/27_nginx.py harden <sha12>`
  (log só de caminho, limites por IP, CSP; `/supabase/auth/v1/token` 10/min por IP).
- Antes e depois da troca: `python ops/remote.py ops/32_cutover_record.py <rotulo>`
  grava em `/opt/biomie-v2/ops/cutover-record-*.json` (root) o commit, a release, a
  imagem, as migrações, os containers, as impressões digitais das configurações
  (nunca o conteúdo), o estado do nginx, os backups e o worker.
- Troca: `python ops/remote.py ops/27_nginx.py cutover <sha12>`. O site legado é
  guardado em `/opt/biomie-v2/ops/nginx/legacy-site.conf`. Webhooks do Omie
  continuam indo para o legado, que segue sincronizando (rollback aquecido).
  Depois do reload o script confere, com novas tentativas por alguns segundos:
  login da v2 com CSP, webhook chegando ao PHP sem redirecionamento, favorito
  antigo com 302, API 200 e jobs 404. Se algo falhar, ele reverte sozinho.
  `27_nginx.py verify` repete essas checagens sem mudar nada.
- Lição da virada de 19/10/2026: um `location ^~ /biomie/` encerra a busca por
  regex e encobre o webhook do Omie (`/biomie/webhooks/omie/...` recebia 302).
  Revertido em 1,5 min, sem webhook perdido; a configuração usa prefixo comum.
- Virada concluída em 19/10/2026 18:29 com a release `f085e2fa93be`; teste de
  fumaça público (administrador e usuário comum) aprovado.
- **Reversão** (segundos, sem reconstrução):
  `python ops/remote.py ops/27_nginx.py rollback`. Critérios: erro de
  autenticação, números materialmente incorretos, falha de RLS ou financeiro,
  indisponibilidade grave.
- Teste de fumaça: `python ops/29_smoke.py [--pre-cutover]` cria um administrador
  e um usuário comum temporários (senhas só em memória), percorre as telas,
  confere a recusa das telas de administrador para o usuário comum e apaga as
  contas. Toda a saída passa por máscara de tokens, cookies e chaves.
- Nunca parar o `php8.3-fpm`: ele atende outros quatro sites da VPS.

## 7. Reconciliação

`python ops/remote.py ops/26_reconcile.py [YYYY-MM] [YYYY-MM]` compara v2 × RAW
do Omie × legado por empresa e mês, nota a nota, e categoriza diferenças
(`only_v2_licitacao`, `scope_diff`, `status_diff`, `channel_split_diff`,
`channel_universe_diff`, `base_diff`, ...). A soma das categorias tem de bater
com a diferença total de cada empresa, ao centavo.
Relatório completo root-only em `/opt/biomie-v2/ops/reconciliation-*.json`.
Títulos são comparados pela mesma base do legado: mês de emissão, posição de hoje.

## 8. Reprocessamento a partir do RAW (sem chamar o Omie)

Quando uma regra muda, reaplique-a ao RAW guardado em vez de baixar de novo:

1. `python ops/remote.py ops/25_load.py pause` e aguarde o estado `PAUSED` em
   `25_load.py status` (o passo em andamento termina antes);
2. `python ops/remote.py ops/31_reprocess.py <empresa|all> <invoices|orders|receivables|settlements|all>`
3. `python ops/remote.py ops/25_load.py resume`

O script recusa rodar com o worker ativo ou com sincronização em andamento. Cada
entidade é recanonicalizada, promovida ao Gold e verificada. Cada período cujo RAW
já tinha paginação comprovada ganha uma execução `REPROCESS`, que atualiza
prontidão e cobertura. Registros que a regra atual não converte não são
certificados (status WARNING).

## 9. Artefatos sensíveis na VPS

`python ops/remote.py ops/33_cleanup_sensitive.py [--dry-run]` apaga com `shred`
os JSON de importação já usados (`legacy-export`, `legacy-canonical`,
`omie-validation*`) e só roda com backup local e externo verificado com menos de
6 horas. Mantém `legacy-map.json` e o backup do legado da virada. Lista outros
candidatos para revisão, sem apagar.

## 11. Admin 2.0 (usuários, acessos, calendário, auditoria e Minha conta)

Branch `feature/admin-2`, migração `0040_admin_users` (somente acréscimos; `0039` fica para as metas).

- **Onde ficam as regras:** esquema `admin_internal` (SECURITY DEFINER, `search_path` fixo, fora do
  esquema exposto pela API); a API só enxerga invólucros SECURITY INVOKER em `public` (`admin_*`, `my_*`).
  Toda função usa `auth.uid()`: a auditoria e o gatilho de `user_roles` registram o autor real.
- **Serviço de login** (criar conta, link, senha temporária, bloqueio, exclusão): só no servidor
  (`admin-users.repository.server.ts`, chave de serviço). O banco confere antes e registra depois;
  conta criada sem configuração é apagada e bloqueio sem registro é desfeito.
- **Decisões aplicadas:** D1 link de uso único (24 h, padrão do serviço de login) e senha temporária
  como alternativa (troca obrigatória, prazo de 72 h, marca em `app_metadata`); D2 Admin cria só nas
  empresas dele e com papéis operacionais, e só o Super admin altera papel de quem já existe; D3 a
  tela recomenda bloquear; D4 logins de vendedor um a um. D5 (feriados por empresa) segue pendente.
- **Portões antes de publicar:** `22_test_database` (suíte `verify_admin_users.sql`), testes e build
  locais. **Depois de ativar:** `29_smoke.py` (regressão) e `29_smoke.py --admin` (convite aberto em
  navegador limpo até o Cockpit, senha temporária forçando a troca, bloqueio, exclusão, Admin da
  empresa sem papéis de administração e sem outra empresa, Vendedor barrado e Minha conta aberta).
- **Retorno:** ativar a release anterior. A `0040` pode ficar: só acrescenta objetos que a versão
  anterior não usa (a restrição de feriados aceita os 26 nacionais existentes).
- **Sessões:** encerrar sessões e bloquear removem a renovação na hora; o acesso já emitido vale até
  1 hora (`GOTRUE_JWT_EXP`). A tela avisa isso.


## 12. Estoque (posição do Omie, curvas e simulação de liquidação)

Branch `feature/estoque` (sobre a `feature/admin-2`), migração `0041_stock` (somente acréscimos).
Telas do pacote do Lovable em `src/estoque`, ligadas ao servidor por `src/estoque/api/server-client.ts`;
os dados de exemplo (`src/estoque/dev/mock-api.ts`) ficam só para os testes.

- **Onde ficam as regras:** esquema `stock_internal` (SECURITY DEFINER, `search_path` fixo); a API só
  enxerga `stock_*` e `my_features` (SECURITY INVOKER). Custo (CMC) segue a regra do Financeiro, curva
  com quem decide compras, VIEWER sem acesso. Permissões extras no Admin 2.0: `stock.view_cost`,
  `stock.classify`, `stock.export`. Curva, cenário, pedido de leitura e liberação vão para a Auditoria.
- **Leitura:** só o worker chama o Omie (`ListarLocaisEstoque` + `ListarPosEstoque`, 100 por página,
  até 20.000 posições por empresa). Agenda 07:40, 12:40 e 17:40 + fechamento 23:50 (histórico de
  400 dias; leituras do dia saem quando chega a próxima). Só vira a posição exibida a leitura com
  páginas e total conferidos; total que muda no meio, posição repetida ou parada de mais de 30 min
  recomeçam do zero; bloqueio 425 espera 30 min; credencial recusada encerra sem tocar na posição
  publicada. Uma falha do estoque nunca interrompe as cargas existentes.
- **Estado depois da migração:** módulo `off` (menu escondido; o Super admin abre pela URL) e leitura
  desligada. Nada chama o Omie até o passo 3.
- **Padrões adotados para as decisões em aberto** (mudam só no banco, sem nova tela): curva por
  produto na empresa; cenários por usuário (até 5); vendedor só com quantidades; leitura 3 vezes ao
  dia mais o fechamento.
- **Ativação (cada passo com o autorizo do responsável):**
  1. Release com a `0041` (ativação normal; antes, `22_test_database` com `verify_stock.sql`).
  2. `python ops/remote.py ops/40_stock.py probe <empresa>` nas 5 empresas: formato e conversão, nada
     gravado.
  3. `40_stock.py reading on` e esperar o próximo horário (ou `40_stock.py refresh <empresa>`);
     `40_stock.py status` mostra o andamento.
  4. `40_stock.py validate`: posições, unidades e total a custo por empresa e por local, e 20 produtos
     fixos. **Portão:** bater com o relatório de posição de estoque do Omie na mesma data.
  5. `29_smoke.py --stock` (modo off): telas pela URL como Super admin, card no Produto 360, celular.
  6. `40_stock.py mode pilot` → `29_smoke.py --stock --stock-mode pilot` → `mode on` →
     `29_smoke.py --stock --stock-mode on` (gestor com menu, vendedor sem custo nem simulação).
- **Retorno:** `40_stock.py mode off` (o menu some; dados, curvas e cenários ficam) e, se preciso,
  `reading off`. A release anterior funciona com a `0041` aplicada, porque ela só acrescenta objetos.
