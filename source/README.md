# BIOMIE v2 — aplicação

Camada de aplicação do [BIOMIE v2](../README.md): as telas, as funções de servidor, o
esquema do banco e o motor de inteligência. A operação (publicar, validar, fotografar e
reverter a produção) fica em [`../ops`](../ops).

## Stack

TanStack Start com SSR · React 19 · TypeScript · Tailwind · PostgreSQL com PostgREST ·
Drizzle para as migrations · Python no motor de inteligência · Docker na VPS.

## Estrutura

| Caminho | Conteúdo |
| --- | --- |
| `src/routes/` | Rotas; tudo sob `_authenticated/_shell` herda sessão e filtros globais |
| `src/domain/metrics/` | **Única** definição de cada métrica (`registry.ts`) e as razões derivadas (`compute.ts`) |
| `src/domain/flight-plan/` | Motor do Plano de Voo: as fórmulas vivem aqui, não nas telas |
| `src/lib/*.functions.ts` | Funções de servidor; delegam acesso a dados aos repositórios |
| `src/lib/repositories/` | Camada fina sobre as funções semânticas do Postgres |
| `src/estoque/`, `src/admin/` | Estoque (curvas, reposição) e Administração |
| `drizzle/migrations/` | 52 migrations versionadas, de `0001` a `0052` |
| `intelligence/` | Motor Python: diagnóstico, previsão, curvas, reposição |
| `tests/`, `src/test/` | Suítes de unidade, contrato e navegador |

As regras de arquitetura que o código precisa obedecer — autorização por RLS, agregação em
funções `SECURITY INVOKER`, origem única de cada métrica, `data_as_of` como única fonte de
"hoje" — estão em [`AGENTS.md`](AGENTS.md).

## Rodar localmente

```sh
bun install
bun run dev
```

Precisa de um Postgres alcançável e das variáveis descritas em `.env.example`. Testes:
`bun run test`. Verificação de tipos: `bun run typecheck`.

> As migrations alteram o esquema. Nunca aponte uma migration para o banco de produção: o
> fluxo é sempre cópia de homologação primeiro, com `../ops/41_homolog.py`.
