# BIOMIE v2 — BI comercial multiempresa, em produção

Segunda geração da plataforma de inteligência comercial do Grupo MAG sobre o ERP **Omie**.
No ar desde **19/10/2026**, atendendo 5 empresas. Substituiu a
[v1 em PHP](../biomie-v1) sem interrupção da operação.

O repositório tem duas metades que são igualmente o produto:

| Pasta | O que é |
| --- | --- |
| `source/` | A aplicação: TanStack Start + React + PostgreSQL + um motor de inteligência em Python |
| `ops/` | A operação: 36 scripts que publicam, validam, fotografam e revertem a produção |

## A aplicação

**Stack:** TanStack Start (SSR), React 19, TypeScript, Tailwind, PostgreSQL com PostgREST,
Drizzle para migrations, Python para o motor de inteligência, Docker na VPS.

**340 arquivos TypeScript · 52 migrations · 48 arquivos de teste**

### Telas

Cockpit · Plano de Voo · Vendas · Vendedores (e Vendedor 360°) · Clientes (e Cliente 360°) ·
Produtos (e Produto 360°) · Estoque com curvas ABC e reposição · Financeiro · Qualidade dos
Dados · Integrações · Administração · Assistente MAG AI.

### Decisões de arquitetura

- **Autorização no banco, não na tela.** RLS do PostgreSQL com helpers
  (`can_access_company`, `can_view_seller`, `is_admin`). As permissões do `src/domain/rbac.ts`
  são apenas dica de interface — se a UI errar, o banco ainda recusa.
- **Agregação em funções semânticas** (`fact_sales`, `sales_aggregate`, `cockpit_summary`),
  todas `SECURITY INVOKER`, para que a RLS valha também na analítica.
- **Uma definição por métrica.** `src/domain/metrics/registry.ts` é a única fonte; razões
  derivadas só em `compute.ts`. Nenhuma fórmula dentro de componente.
- **Escrita sensível por função `SECURITY DEFINER` não exposta** (`flight_plan_internal`),
  alcançada só por wrappers auditados — toda escrita cai no `audit_log`.
- **"Hoje" vem do banco.** `public.data_as_of(company)` é a única origem da data corrente na
  analítica; nenhuma tela chama `new Date()`. Isso torna testes e SSR determinísticos.
- **Filtros globais na URL**, validados por schema no layout autenticado: todo recorte é um
  link que se compartilha.

### Motor de inteligência (Python)

`source/intelligence/biomie_intel` — diagnóstico de estoque, previsão de demanda, curvas,
reposição e estados, servido por API própria em container separado. Roda a análise diária
agendada e publica o resultado para as 5 empresas.

### Assistente MAG AI

Assistente conversacional sobre os dados da operação, ligado a um
[LLM local na mesma VPS](../mag-ai) — sem enviar dado comercial para nuvem de terceiros.
Entrega fatos do período, história, tendência e três cenários de previsão. Liberado por
degraus de papel (hoje: Super Admin), com desligamento instantâneo por flag.

## A operação

Esta é a parte que normalmente não aparece num portfólio, e é onde está metade do trabalho.
Cada script de `ops/` é um passo nomeado e repetível:

```
21_activate_release.py    publica uma release e religa o worker
22_test_database.py       suíte contra a cópia de homologação
24_probe.py               sonda de saúde antes e depois
25_load.py                carga do Omie (pausar / retomar)
28_backup.py              backup cifrado para fora do servidor
29_smoke.py               teste de fumaça com navegador real
41_homolog.py             clona a produção para a cópia e valida ali primeiro
49_release_ativa.py       responde "o que está no ar agora?"
50_foto_producao.py       retrato antes/depois — o portão de comparação
59_assistente.py          liga/desliga a IA sem publicar release
janela_testes.py          recusa operações pesadas em horário comercial
```

**A regra que organiza tudo:** nada entra em produção sem diagnóstico, impacto medido, teste
na cópia e caminho de volta escrito antes. `50_foto_producao.py` tira um retrato da produção
antes da mudança e outro depois; se os números não baterem, a ativação não acontece.

## Branches

Este repositório preserva o fluxo real de trabalho: cada funcionalidade e cada correção têm
sua branch, com o nome do que resolvem. `main` aponta para a linhagem em produção (assistente
e previsões). O estado importado no corte de 19/10/2026 está em `importacao-19-10-2026`.

## Sobre esta cópia pública

O endereço real da VPS foi trocado pelo IP de documentação `203.0.113.10` (RFC 5737) e o
identificador da instância por `srv-vps`. Foram removidos os logs de instalação (continham
metas de faturamento da empresa) e as capturas de tela do cockpit (continham a lista nominal
da equipe de vendas). Nenhuma credencial foi versionada em nenhum momento.

---

## Autoria

Projeto meu — concepção, arquitetura, implementação, implantação e operação em produção.
Durante o desenvolvimento usei assistentes de IA (Codex e Claude) como ferramenta de apoio;
a condução e as decisões técnicas são minhas.
