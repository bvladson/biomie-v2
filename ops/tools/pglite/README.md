# Banco local descartável (PGlite) para as migrações e suítes SQL

Não é o portão oficial (esse é `ops/22_test_database.py`, Postgres 17 no servidor); serve para errar cedo.
Precisa de `npm i @electric-sql/pglite@0.5.8` nesta pasta (fica fora do `package.json` do projeto).

- `node run_suites.mjs <source> [filtro]` — todas as migrações + suítes `deploy/db/verify_*.sql` (~20 s).
- `node fp_dump.mjs <source> <source>/src/lib/repositories/__fixtures__` — regrava as respostas reais das
  leituras do Plano de Voo usadas pelo teste de contrato `flight-plan-v2.repository.test.ts`.
- `node check56.mjs <source> ../../56_plano_voo_check.py` — ensaio do SQL da conferência do Plano de Voo.
