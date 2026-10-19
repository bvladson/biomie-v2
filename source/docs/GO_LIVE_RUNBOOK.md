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
  Integrações (SUPER_ADMIN). Recorrência: `node .output/worker-ctl.mjs recurring on|off`.
- Recorrência (quando ligada): notas, pedidos, títulos e liquidações dos últimos
  62 dias a cada 30 min; cadastros diários às 06h; reprocessamento do ano aos
  domingos às 05h; fotografia do Plano de Voo às 08h (America/Fortaleza).
- Proteções: cede quando a carga por CPU da máquina passa de 0,75; janelas
  proibidas em `BIOMIE_WORKER_BLACKOUTS` (ex.: manutenção VSB 20/10 19h30–21h);
  limitador do Omie com 61 s entre consultas idênticas, circuito de 30 min no 425,
  pausa da chave em erro de autenticação ou após 5 erros em 30 min.
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
- Troca: `python ops/remote.py ops/27_nginx.py cutover <sha12>`. O site legado é
  guardado em `/opt/biomie-v2/ops/nginx/legacy-site.conf`. Webhooks do Omie
  continuam indo para o legado, que segue sincronizando (rollback aquecido).
- **Reversão** (segundos, sem reconstrução):
  `python ops/remote.py ops/27_nginx.py rollback`. Critérios: erro de
  autenticação, números materialmente incorretos, falha de RLS ou financeiro,
  indisponibilidade grave.
- Nunca parar o `php8.3-fpm`: ele atende outros quatro sites da VPS.

## 7. Reconciliação

`python ops/remote.py ops/26_reconcile.py [YYYY-MM] [YYYY-MM]` compara v2 × RAW
do Omie × legado por empresa e mês, nota a nota, e categoriza diferenças
(`only_v2_licitacao`, `scope_diff`, `channel_split_diff`, `base_diff`, ...).
Relatório completo root-only em `/opt/biomie-v2/ops/reconciliation-*.json`.
