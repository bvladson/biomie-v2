# Publicação da rolagem horizontal — 30/10/2026

Publicação diretamente em produção autorizada pelo usuário nesta data.

- Release anterior: `1240466bf0c310f3f60ecdf18cfdad3b51f4af73`.
- Release ativa: **`cb9aeeb065395c0d9c039e262908e897eb74e711`**.
- Imagem: `biomie-v2-web:cb9aeeb06539`, revisão conferida.
- Site: `https://biomie.magmoveiscorporativos.com.br`.
- Apenas o serviço **web** foi recriado. Banco, worker, auth, rest e gateway
  preservaram seus IDs e imagens; o compose do host também foi preservado.
- Nenhuma migração, importação, recálculo ou alteração de curvas foi executada.

## Verificação

Além dos 20 casos locais de navegador e dos 311 testes unitários registrados em
`FLOATING_TABLE_SCROLL.md`, foram executadas verificações autenticadas no preview
privado e depois no endereço público, com a mesma imagem:

- MAG Filial, curva A, visão por produto: **82 linhas reais**.
- Barra flutuante visível em `y=740`, altura 24, no viewport 1366×768;
  a tabela ainda se estendia até muito abaixo da tela.
- Arraste do thumb até a coluna **Pendente**, com `scrollLeft=505` de máximo 505,
  seguido do retorno ao início.
- Sincronização nativa e teclado End/Home aprovados.
- Zero erros de navegador, servidor, CSP ou transporte.
- As contas temporárias foram removidas pelo UID/e-mail exatos, com confirmação
  de zero registros restantes de conta, perfil, concessões e sessões.

Os relatórios JSON e capturas ficam, sem credenciais, na worktree
`biomie-v2-scroll-20261030/ops/logs/`. O recibo final é
`ui-production-receipt-20261030.json`. A saúde do web e os IDs dos demais serviços
foram conferidos novamente após a limpeza do preview e do builder dedicado.

## Preservação e atualização posterior

O commit de interface `b64d95c` foi incorporado nesta branch como **`cdb333a`**,
preservando as melhorias que ainda não foram publicadas. TypeScript da branch
atualizada foi aprovado.

Havia um processo de ativação do candidato antigo `2bd5c7c701c4` aguardando janela,
com o rollback anterior `1240466bf0c3` já guardado em memória. Esse candidato não
contém a barra. O processo foi encerrado **antes** de pausar worker, migrar banco
ou iniciar sua ativação, para não remover a correção já publicada. O motivo está
registrado em `ops/logs/noturno/20261030-ativacao-2bd5c7c701c4/resumo.json`;
os artefatos de validação anteriores foram preservados.

Essa ativação pendente requer um novo candidato com a correção de interface e
suas verificações próprias. Não retomar o candidato antigo sobre esta release.

A rotina `ops/noturno.py` agora relê a versão ativa depois da espera e executa
`ops/51_ui_release_guard.py` antes de pausar o worker. A proteção foi conferida
na VPS por leitura: o candidato antigo `2bd5c7c701c4` foi identificado como
incompatível, e a release ativa `cb9aeeb06539` preserva a integração global.
Nenhuma dessas conferências altera serviços ou banco.

O snapshot privado dos ponteiros anteriores e a imagem anterior foram mantidos
para retorno. Na worktree de publicação, o retorno explícito, se necessário,
usa `ops/51_publish_ui.py rollback cb9aeeb06539 1240466bf0c310f3f60ecdf18cfdad3b51f4af73`
através de `ops/remote.py`; essa operação não foi executada na produção saudável.
