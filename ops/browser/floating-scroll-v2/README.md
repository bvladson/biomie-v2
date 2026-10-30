# Regressão de rolagem no BIOMIE V2

Este teste abre a **`PositionsPage.tsx` real** da versão React, com seu componente
`Table`, campos, colunas e 82 linhas. Usa o CSS real do projeto e o componente
global de rolagem. A fixture roda em `127.0.0.1`, com Vite isolado, sem iniciar o
servidor da aplicação ou acessar banco, Supabase, autenticação, Omie ou produção.

Apenas as fronteiras de roteamento, API e módulo de título/layout são substituídas
pelo plugin da fixture. A API é `createMockApi` já existente no projeto, com dados
sintéticos. As configurações e stubs ficam em `ops/browser/`, fora do bundle da
aplicação. O modo `StrictMode` está ativado.

## Execução

Requer as dependências de desenvolvimento instaladas em `source/node_modules`,
Node 24 e Playwright 1.64.1 com seu Chromium correspondente. Playwright é somente
uma ferramenta externa de teste e não foi acrescentado às dependências da aplicação.

Na raiz da pasta de trabalho:

```powershell
$env:PLAYWRIGHT_MODULE = 'C:\caminho\ferramentas-de-teste\node_modules\playwright'
node --test --test-reporter=tap ops/browser/floating-scroll-v2.test.cjs
```

As capturas são gravadas por padrão em `ops/logs/floating-scroll-v2/`, ignorado
pelo Git. `FLOATING_SCROLL_ARTIFACTS` permite escolher outro diretório. Para
registrar também o TAP, redirecione a saída para
`ops/logs/floating-scroll-v2-results.tap`. Uma captura isolada não prova aprovação;
o resultado é o do runner.

## Verificações

- Página real no meio das 82 linhas, com o scrollbar nativo ainda mais de 500 px
  abaixo da tela. A barra adicional permanece visível e sincronizada; o controle
  alcança a coluna real **Pendente** sem chegar à última linha.
- Matriz de 1920×1080, 1366×768 e 900×600 com zoom **CSS** de 100%, 125% e 150%.
- Arraste do thumb nativo por `page.mouse` até a última coluna e de volta ao
  início. Chromium executa sem `--hide-scrollbars`; o teste exige gutter visível.
- Busca da página com resposta assíncrona, remoção/remontagem condicional pelo
  React, `StrictMode`, limpeza e remontagem do controlador. A tabela permanece
  sob o pai criado pelo React; a substituição legítima do subtree durante o
  carregamento é permitida.
- Barra nativa acessível e tabela sem overflow não recebem controles duplicados.
- `Sheet` real do Radix: portal dentro do diálogo/foco, rolagem interna e barra
  acima do rodapé de ações; teclado End e fechamento por Escape.
- Janela mobile 390×844: teclado e evento wheel horizontal.
- Renderização SSR do componente global real por `renderToString`, em Node sem
  `window` ou `document`, retorna conteúdo vazio sem exceção.
- Zoom **nativo de aba**, separado do zoom CSS: 100%, 125% e 150% na janela
  1366×768, mais 150% em 900×600. Uma extensão MV3 temporária chama
  `chrome.tabs.setZoom/getZoom`; os testes confirmam a alteração do DPR e viewport,
  mantendo zoom CSS e `visualViewport.scale` em 1. O perfil temporário é removido
  apenas após validar sua localização e prefixo.

O resultado esperado são **20 verificações aprovadas**: 15 casos principais,
quatro subcenários de zoom nativo e o teste que os contém. Esta contagem é a do
runner Node, que inclui o teste pai.

Execução local em **30/10/2026**, Chromium **156.0.8078.4** no Windows:
**20 aprovadas, 0 falhas, 0 ignoradas**, em aproximadamente 69 segundos.
TAP: `ops/logs/floating-scroll-v2-results.tap`.

## Limites

Esta fixture não valida autenticação, RLS, cálculos, importação, permissões ou
dados reais. O roteamento é substituído somente dentro do teste; a aplicação não
recebe modo de acesso sem autenticação. Navegação autenticada em homologação e
ergonomia com mouse/trackpad ou dispositivo móvel físico continuam distintas
destes testes. A execução registrada para esta correção usa Chromium no Windows;
resultados anteriores da base PHP em Firefox/WebKit não validam o V2.

Referências do mecanismo de zoom nativo:
[Chrome tabs.setZoom](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-setZoom)
e [extensões no Playwright](https://playwright.dev/docs/chrome-extensions).
