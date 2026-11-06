# Banco local descartável (PGlite) para as migrações e suítes SQL

Não é o portão oficial (esse é `ops/22_test_database.py`, Postgres 17 no servidor); serve para errar cedo.
Precisa de `npm i @electric-sql/pglite@0.5.8` nesta pasta (fica fora do `package.json` do projeto).

- `node run_suites.mjs <source> [filtro]` — todas as migrações + suítes `deploy/db/verify_*.sql` (~20 s).
- `node fp_dump.mjs <source> <source>/src/lib/repositories/__fixtures__` — regrava as respostas reais das
  leituras do Plano de Voo usadas pelo teste de contrato `flight-plan-v2.repository.test.ts`.
- `node check56.mjs <source> ../../56_plano_voo_check.py` — ensaio do SQL da conferência do Plano de Voo.
- `node bench_fs.mjs <source> [notas] [clientes]` — mede fact_sales e as leituras do Plano de Voo com dados sintéticos:
  atual × candidata da 0051 (`cand_fact_sales.sql`) × "clientes novos" por EXISTS com índice; exige resultado idêntico.
- `node test57.mjs <source> ../../57_faturamento_check.py [sem0051]` — ensaio do SQL da conferência 57 (faturamento
  nova × anterior). `../gen_57.py <source> ../../57_faturamento_check.py` regera a 57 a partir do texto da 0021.
- `node test58.mjs <source> ../../58_desfazer_0051.py` — ensaio do retorno da 0051: desfaz, confere que o banco
  fica igual ao de antes da 0051, reaplica e roda a suíte de equivalência.
- `node test_suppliers_undo.mjs <source> ../../40_stock.py` — ensaio do SQL do `40_stock.py suppliers-undo` (desfazer
  da importação de fornecedores): ensaio sem mudança, desfazer de uma empresa só, prazos/principal/vínculos manuais
  intactos, repetição sem efeito e recusas (importação aberta, diária ligada, empresa inexistente).
- `node test43_diag.mjs <source> ../../43_intel_check.py` — ensaio do diagnóstico de unidades da conferência 43:
  venda de produto fora da leitura de estoque aparece em unitsDiff (o critério da conferência não muda).
- `python ../test_noturno_plano.py <worktree>` — fluxo de decisão de noturno.plano/ativar_plano com o servidor
  simulado (homologação, 57, 58, foto, retornos).
