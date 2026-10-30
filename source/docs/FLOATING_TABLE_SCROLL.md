# Rolagem horizontal flutuante no Biomie V2

## Causa e correção

A listagem de curvas em **Estoque → Posições** usa o componente React `Table`,
cujo wrapper já oferece rolagem horizontal. Antes desta alteração, o controle
nativo permanecia no final das linhas. O registro de assets da aplicação PHP
não participa do carregamento desta aplicação React/TanStack Start.

O shell autenticado agora monta `GlobalFloatingTableScroll`, que inicia o
controlador somente depois da hidratação. A barra acompanha a borda inferior
da área visível da tabela e sincroniza proporcionalmente os dois controles.
Ela desaparece quando a barra nativa está acessível ou não existe overflow.

O controlador observa dimensões, conteúdo dinâmico, rolagem e mudanças de
viewport. Drawers e modais recebem seu controle dentro do próprio escopo de
foco. Os limites consideram os ancestrais que realmente recortam o conteúdo,
incluindo containing blocks de elementos fixos e modais no top layer.

As tabelas e seus wrappers **não são movidos, substituídos ou recriados pelo
controlador**. Assim, a atualização de filtros e o desmonte condicional das
tabelas continuam sob responsabilidade do React. O cleanup cancela RAF,
desconecta observadores, remove listeners e restaura os atributos próprios.

## Arquivos de aplicação

- `src/lib/floating-table-scroll.ts`: controlador tipado, geometria,
  sincronização, teclado/ARIA e ciclo de vida.
- `src/components/layout/GlobalFloatingTableScroll.tsx`: integração por
  `useEffect`, compatível com SSR e StrictMode.
- `src/routes/_authenticated/_shell.tsx`: montagem global nas páginas autenticadas.
- `src/styles/floating-table-scroll.css`: estilos isolados usando os tokens V2.
- `src/styles.css`: importação global do CSS.

Não há mudanças em `PositionsPage`, consultas, contratos, regras de curvas,
filtros de negócio, permissões, Omie, worker ou migrações.

O comportamento automático cobre tabelas de dados com containers horizontais
existentes. Menus, navegação e carrosséis não recebem controles adicionais.
Configuração opcional:

```html
<section data-biomie-floating-scroll="off">...</section>
<div data-biomie-floating-scroll="on" data-biomie-floating-scroll-label="Colunas do relatório">
  ...
</div>
<footer data-biomie-floating-scroll-obstacle>...</footer>
```

O opt-in exige um container com overflow horizontal real. Os novos componentes
devem utilizar `Table` ou manter um wrapper horizontal próprio.

## Base e verificação

Esta correção foi preparada na branch `fix/v2-floating-scroll-prod`, partindo do
commit **1240466bf0c310f3f60ecdf18cfdad3b51f4af73**, identificado por leitura
da configuração da release ativa na VPS em 30/10/2026. Os arquivos de tabela,
shell e posições dessa base foram comparados com os hashes da release ativa.
Atualizações pendentes de outras branches não foram incluídas.

Validação local:

- TypeScript completo: aprovado (`tsc --noEmit -p tsconfig.json`).
- ESLint e Prettier dos arquivos de aplicação alterados: aprovados.
- Build de cliente e servidor: aprovado. Os valores Supabase usados no build
  local são fictícios e apontam para loopback; esse build não é um pacote de produção.
- Suítes unitárias existentes: **311 testes aprovados**, 19 ignorados por
  condições preexistentes; nenhuma chamada ao banco ou Omie.
- A suíte `rpc-security.test.ts` não está incluída nesse resultado unitário:
  requer um backend configurado e, sem variáveis Supabase, falha durante a
  coleta ao criar o cliente mesmo no `describe.skip`. A primeira execução
  completa registrou essa limitação; o código de segurança foi preservado.
- A regressão de navegador usa a **PositionsPage, Table, CSS e Radix Sheet
  reais**, com 82 linhas sintéticas. Apenas os limites de dados, rota e título
  recebem substitutos no servidor de fixture, sem alterar a aplicação.

Reprodução e evidências: `ops/browser/floating-scroll-v2/README.md`.

O teste local não equivale a uma sessão autenticada em produção. A autorização
de publicação e a ativação da release são etapas separadas. A alteração não
introduz dependências de produção nem exige migração de banco.

## Publicação da correção

Antes da ativação, conferir novamente o commit da release ativa. Se ele tiver
mudado, portar apenas os arquivos desta correção para a nova base e repetir as
verificações necessárias; não substituir mudanças posteriores pelo snapshot antigo.

A publicação deve construir a imagem com a configuração pública do ambiente e
atualizar somente o serviço web, mantendo banco, worker e integrações. Guardar
a referência da imagem anterior permite reverter somente o web se a saúde ou
a validação autenticada da tela falhar. O build local com valores fictícios não
deve ser usado como artefato de produção.

Não utilizar automaticamente `ops/21_activate_release.py` para esta mudança de
interface: essa rotina também aplica migrações e pausa o worker. Esses efeitos
não fazem parte desta correção.
