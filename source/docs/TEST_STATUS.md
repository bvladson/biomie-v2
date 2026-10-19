# Status dos testes

- `bunx vitest run` — suíte padrão (inclui cliente Omie, limitador, adapters, segurança anônima das RPCs).
- Testes pulados por padrão (exigem `SUPABASE_SERVICE_ROLE_KEY` e `BIOMIE_RLS_E2E=1`; criam e apagam contas temporárias):
  - `src/test/gestor-scope.test.ts` — GESTOR vê só a própria equipe.
  - `src/test/vendedor-scope.test.ts` — VENDEDOR vê só os próprios dados.
  - 2 testes de permissão em `src/test/finance.test.ts`.
- Devem rodar em CI de homologação antes de cada release.
