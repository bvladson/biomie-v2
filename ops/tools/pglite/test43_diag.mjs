// Ensaio LOCAL do diagnóstico de unidades da conferência 43 (ops/43_intel_check.py, 06/11): o motor só analisa
// produtos da leitura de estoque; venda de produto fora da leitura entra no fact_sales e não no motor. O diagnóstico
// (unitsDiff, unitsDiffProducts, unitsDiffOutsideReading) tem de apontar exatamente esse produto, sem mudar o critério.
// Uso: node test43_diag.mjs <source> <43_intel_check.py>
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { setup } from './setup.mjs';

const [src, script] = process.argv.slice(2);
const sql = execFileSync('python', ['-c', `
import pathlib, sys
t = pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')
q = t.split('SQL = r"""', 1)[1].split('"""', 1)[0]
p = t.split('PARAMS = ("""', 1)[1].split('"""', 1)[0]
sys.stdout.write(q.replace('__PARAMS__', p))`, script], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
let failed = 0;
const check = (label, cond, detail) => { if (!cond) failed++; console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${cond ? '' : ' → ' + JSON.stringify(detail)}`); };

const C = '00000000-0000-0000-0000-00000000c043';
const R = '00000000-0000-0000-0000-0000000000a4';
const RUN = '00000000-0000-0000-0000-0000000000b4';
const db = await PGlite.create({ extensions: { pgcrypto } });
await setup(db, src);
await db.exec(`
do $$
declare c uuid := '${C}'; s uuid; cu uuid; p1 uuid; p9 uuid; i1 uuid; i9 uuid;
begin
  insert into public.companies(id, name, slug, data_source, revenue_basis) values (c, 'Empresa 43', 'empresa-43', 'OMIE_SHADOW', 'commercial_base');
  insert into public.channels(company_id, name) values (c, 'varejo'), (c, 'licitacao'), (c, 'outros');
  insert into public.sellers(company_id, name, external_id) values (c, 'Vendedor', 'V1') returning id into s;
  insert into public.customers(company_id, name, state, city) values (c, 'Cliente', 'CE', 'Fortaleza') returning id into cu;
  insert into public.products(company_id, name, category, base_price, source, external_id) values (c, 'Cadeira P1', 'Cat', 1, 'omie', 'P1') returning id into p1;
  insert into public.products(company_id, name, category, base_price, source, external_id) values (c, 'Kit P9', 'Cat', 1, 'omie', 'P9') returning id into p9;
  insert into public.invoices(company_id, seller_id, customer_id, number, competence_date, total, source, external_id,
      gross_amount, goods_amount, commercial_base_amount, operation_scope, business_channel, is_biomie_commercial_visible)
    values (c, s, cu, 'N1', current_date - 10, 300, 'omie', 'e1', 300, 300, 300, 'commercial', 'varejo', true) returning id into i1;
  insert into public.invoices(company_id, seller_id, customer_id, number, competence_date, total, source, external_id,
      gross_amount, goods_amount, commercial_base_amount, operation_scope, business_channel, is_biomie_commercial_visible)
    values (c, s, cu, 'N2', current_date - 1, 200, 'omie', 'e2', 200, 200, 200, 'commercial', 'varejo', true) returning id into i9;
  insert into public.invoice_items(invoice_id, company_id, seller_id, product_id, quantity, total, item_sequence) values
    (i1, c, s, p1, 3, 300, 1), (i9, c, s, p9, 2, 200, 1);
end $$;
insert into private.stock_readings (id, company_id, kind, trigger, status, position_date)
  values ('${R}', '${C}', 'intraday', 'manual', 'complete', current_date);
insert into private.stock_current (company_id, reading_id) values ('${C}', '${R}');
insert into private.stock_positions (reading_id, company_id, omie_product_id, location_code, sku, name, physical_qty, unit_cost)
  values ('${R}', '${C}', 'P1', 'L1', 'S1', 'Cadeira P1', 4, 10);
insert into private.intel_runs (id, trigger, algorithm_version, status, as_of, finished_at)
  values ('${RUN}', 'test', 'intel-teste', 'published', current_date, now());
insert into private.intel_current (company_id, run_id) values ('${C}', '${RUN}');
insert into private.intel_product_metrics (run_id, company_id, omie_product_id, state, priority, metrics) values
  ('${RUN}', '${C}', 'P1', 'saudavel', 10, '{"capital": 40.00, "stock": {"qty": 4}, "sales": {"d365": {"units": 3}}}');
`);

const results = await db.exec(sql);
const first = results.map((r) => r.rows?.[0]).find((r) => r && Object.keys(r).includes('json_agg'));
const companies = typeof first.json_agg === 'string' ? JSON.parse(first.json_agg) : first.json_agg;
const co = companies.find((x) => x.company === 'empresa-43');
check('fact_sales conta as vendas dos dois produtos (3 + 2)', Number(co.units365FactSales) === 5, co.units365FactSales);
check('o motor conta só o da leitura (3)', Number(co.units365Engine) === 3, co.units365Engine);
check('1 produto explica a diferença', co.unitsDiffProducts === 1, co.unitsDiffProducts);
check('diferença fora da leitura = 2 unidades', Number(co.unitsDiffOutsideReading) === 2, co.unitsDiffOutsideReading);
const d = (co.unitsDiff || [])[0] || {};
check('unitsDiff aponta P9: 2 no fact_sales, ausente no motor, fora da leitura',
  d.omie === 'P9' && Number(d.factSales) === 2 && d.engine === null && d.inReading === false, co.unitsDiff);
// Critério de sempre: a conferência continua apontando a diferença (o Python marca ok = false).
check('critério não muda: unidades diferentes', Number(co.units365Engine) !== Number(co.units365FactSales), co);
await db.close();
console.log(failed ? `${failed} FALHA(S)` : 'tudo certo');
process.exit(failed ? 1 : 0);
