// Gera as respostas REAIS das leituras do Plano de Voo (migração 0050) num banco de exemplo (PGlite),
// para o teste de contrato SQL × TypeScript (src/lib/repositories/flight-plan-v2.repository.test.ts).
// Uso: node fp_dump.mjs <source> <pasta de saída>
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setup } from './setup.mjs';

const src = process.argv[2];
const out = process.argv[3];
mkdirSync(out, { recursive: true });
const db = await PGlite.create({ extensions: { pgcrypto } });
await setup(db, src);

// Ids fixos para o arquivo de exemplo ficar estável.
const ID = {
  adm: '00000000-0000-4000-8000-0000000000a1', ges: '00000000-0000-4000-8000-0000000000a2',
  ven: '00000000-0000-4000-8000-0000000000a3', c: '00000000-0000-4000-8000-0000000000c1',
  s1: '00000000-0000-4000-8000-0000000000b1', s2: '00000000-0000-4000-8000-0000000000b2',
  s3: '00000000-0000-4000-8000-0000000000b3', sl: '00000000-0000-4000-8000-0000000000b4',
};
const TODAY = '2026-11-18';
await db.exec(`
create or replace function public.data_as_of(p_company uuid) returns date language sql stable as $$ select date '${TODAY}' $$;
do $$
declare c uuid := '${ID.c}'; p uuid := gen_random_uuid(); cu1 uuid := gen_random_uuid(); cu2 uuid := gen_random_uuid();
  cu3 uuid := gen_random_uuid(); t1 uuid := gen_random_uuid(); i1 uuid := gen_random_uuid(); i2 uuid := gen_random_uuid();
  i3 uuid := gen_random_uuid(); i4 uuid := gen_random_uuid(); i5 uuid := gen_random_uuid(); o1 uuid := gen_random_uuid();
  q1 uuid := gen_random_uuid();
begin
  insert into auth.users(id, email) values ('${ID.adm}', 'adm@invalid.example'), ('${ID.ges}', 'ges@invalid.example'),
    ('${ID.ven}', 'ven@invalid.example');
  insert into public.profiles(id, full_name) values ('${ID.adm}', 'Admin FP'), ('${ID.ges}', 'Gestor FP'), ('${ID.ven}', 'Vendedora FP');
  insert into public.user_roles(user_id, role) values ('${ID.adm}', 'ADMIN'), ('${ID.ges}', 'GESTOR'), ('${ID.ven}', 'VENDEDOR');
  insert into public.companies(id, name, slug, data_source, revenue_basis) values (c, 'Mag Filial (exemplo)', 'mag-filial', 'OMIE_SHADOW', 'commercial_base');
  insert into public.channels(company_id, name) values (c, 'varejo'), (c, 'licitacao'), (c, 'outros');
  insert into public.user_company_access(user_id, company_id) values ('${ID.adm}', c), ('${ID.ges}', c), ('${ID.ven}', c);
  insert into public.sellers(id, company_id, name, external_id) values ('${ID.s1}', c, 'Ana FP', 'V1'), ('${ID.s2}', c, 'Bruno FP', 'V2'),
    ('${ID.s3}', c, 'Carla FP', 'V3'), ('${ID.sl}', c, 'Licitação', 'L1');
  update public.sellers set user_id = '${ID.ven}' where id = '${ID.s3}';
  insert into public.products(id, company_id, name, category, base_price) values (p, c, 'Cadeira FP', 'Teste', 1);
  insert into public.customers(id, company_id, name, state, city) values (cu1, c, 'Cliente antigo', 'CE', 'Fortaleza'),
    (cu2, c, 'Cliente novo', 'CE', 'Fortaleza'), (cu3, c, 'Órgão público', 'CE', 'Fortaleza');
  insert into public.sales_teams(id, company_id, name) values (t1, c, 'Equipe FP');
  insert into public.sales_team_managers(team_id, user_id, valid_from) values (t1, '${ID.ges}', date '2026-01-01');
  insert into public.sales_team_members(team_id, seller_id, valid_from) values (t1, '${ID.s1}', date '2026-01-01');
  insert into public.invoices(id, company_id, seller_id, customer_id, number, competence_date, total, source, external_id,
    gross_amount, goods_amount, commercial_base_amount, operation_scope, business_channel, is_biomie_commercial_visible) values
    (i1, c, '${ID.s1}', cu1, 'N1', date '2026-11-16', 100, 'omie', 'd-1', 100, 100, 100, 'commercial', 'varejo', true),
    (i2, c, '${ID.s2}', cu2, 'N2', date '2026-11-17', 200, 'omie', 'd-2', 200, 200, 200, 'commercial', 'varejo', true),
    (i3, c, '${ID.sl}', cu3, 'N3', date '2026-11-10', 300, 'omie', 'd-3', 300, 300, 300, 'commercial', 'licitacao', false),
    (i4, c, null, cu2, 'N4', date '2026-11-03', 50, 'omie', 'd-4', 50, 50, 50, 'commercial', 'varejo', true),
    (i5, c, '${ID.s1}', cu1, 'N5', date '2026-10-05', 400, 'omie', 'd-5', 400, 400, 400, 'commercial', 'varejo', true);
  insert into public.invoice_items(invoice_id, company_id, seller_id, product_id, quantity, total, item_sequence) values
    (i1, c, '${ID.s1}', p, 1, 100, 1), (i2, c, '${ID.s2}', p, 1, 200, 1), (i3, c, '${ID.sl}', p, 1, 300, 1),
    (i4, c, null, p, 1, 50, 1), (i5, c, '${ID.s1}', p, 1, 400, 1);
  insert into public.sales_orders(id, company_id, seller_id, customer_id, number, status, order_date, expected_date, total,
    source, operation_scope, stage_code, business_channel) values
    (o1, c, '${ID.s1}', cu1, 'P1', 'open', date '2026-10-29', date '2026-11-12', 1000, 'omie', 'commercial', '20', 'varejo'),
    (q1, c, '${ID.s2}', cu2, 'Q1', 'open', date '2026-10-19', null, 500, 'omie', 'commercial', '10', 'varejo');
  insert into public.sales_order_items(order_id, company_id, seller_id, product_id, quantity, total) values
    (o1, c, '${ID.s1}', p, 1, 1000), (q1, c, '${ID.s2}', p, 1, 500);
  insert into public.sales_targets(company_id, channel_id, seller_id, year, month, level, amount) values
    (c, (select id from public.channels where company_id = c and name = 'varejo'), null, 2026, 11, 'ACTIVE', 1000),
    (c, null, '${ID.s1}', 2026, 11, 'ACTIVE', 300), (c, null, '${ID.s3}', 2026, 11, 'ACTIVE', 250),
    (c, null, '${ID.s1}', 2026, 10, 'ACTIVE', 280);
  insert into public.flight_plan_commits(company_id, seller_id, year, month, amount, note, created_by)
    values (c, '${ID.s1}', 2026, 11, 120, 'Fecha até o dia 25', '${ID.adm}');
end $$;`);

const WINDOWS = JSON.stringify({
  previous: { start: '2026-10-01', end: '2026-10-18' },
  lastYear: { start: '2025-11-01', end: '2025-11-18' },
  trailing3: { start: '2026-08-01', end: '2026-10-31', divisor: 3 },
});
async function as(user, sql) {
  await db.exec(`begin; select set_config('request.jwt.claims', '{"sub":"${user}","role":"authenticated"}', true); set local role authenticated;`);
  try {
    const r = await db.query(sql);
    await db.exec('commit;');
    return Object.values(r.rows[0])[0];
  } catch (e) {
    await db.exec('rollback;');
    throw e;
  }
}
const C = `'${ID.c}'`;
const dump = {
  admin: {
    me: await as(ID.adm, 'select public.flight_plan_v2_me()'),
    dataset: await as(ID.adm, `select public.flight_plan_v2_dataset(${C}, 2026, 11, '${WINDOWS}'::jsonb)`),
    datasetVarejo: await as(ID.adm, `select public.flight_plan_v2_dataset(${C}, 2026, 11, '${WINDOWS}'::jsonb, 'varejo')`),
    year: await as(ID.adm, `select public.flight_plan_v2_year(${C}, 2026)`),
    lists: await as(ID.adm, `select public.flight_plan_v2_target_lists(${C})`),
    targets: await as(ID.adm, `select public.flight_plan_targets_month(${C}, 2026, 11)`),
  },
  gestor: {
    me: await as(ID.ges, 'select public.flight_plan_v2_me()'),
    dataset: await as(ID.ges, `select public.flight_plan_v2_dataset(${C}, 2026, 11, '${WINDOWS}'::jsonb)`),
    targets: await as(ID.ges, `select public.flight_plan_targets_month(${C}, 2026, 11)`),
  },
  vendedor: {
    me: await as(ID.ven, 'select public.flight_plan_v2_me()'),
    dataset: await as(ID.ven, `select public.flight_plan_v2_dataset(${C}, 2026, 11, '${WINDOWS}'::jsonb)`),
  },
};
// Uma gravação de cada tipo, para o histórico ter linhas reais.
await as(ID.adm, `select public.flight_plan_save_targets(${C}, 2026, 11, '[{"scope":"seller","sellerId":"${ID.s1}","level":"BASE","amount":200}]'::jsonb)`);
await as(ID.adm, `select public.flight_plan_set_commit(${C}, '${ID.s1}', 2026, 11, 130, null)`);
dump.admin.history = await as(ID.adm, `select public.flight_plan_history(${C}, null, 50)`);
dump.admin.alertsSync = await as(ID.adm, `select public.flight_plan_sync_alerts(${C}, 2026, 11, array['empresa'],
  '[{"key":"LATE_ORDERS:${ID.c}:empresa:2026-11","subject":"empresa","sellerId":null,"priority":1,"message":"m","evidence":"e"}]'::jsonb)`);
writeFileSync(path.join(out, 'datasets.json'), JSON.stringify({ ids: ID, today: TODAY, ...dump }, null, 1));
console.log('ok', Object.keys(dump.admin.dataset).join(','));
await db.close();
