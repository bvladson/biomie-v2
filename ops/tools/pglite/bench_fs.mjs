// Medição LOCAL (PGlite, dados sintéticos) do custo de fact_sales e das leituras do Plano de Voo.
// Uso: node bench_fs.mjs <source> [notas=6000]
// Compara: atual × candidata (regras da empresa uma vez por combinação) × candidata + "clientes novos" por EXISTS.
// Cada variante tem de devolver exatamente o mesmo resultado (checksum de fact_sales e JSON das leituras).
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup } from './setup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = process.argv[2];
const N = +(process.argv[3] || 6000);
const NCU = +(process.argv[4] || 2000); // clientes distintos que compram (recorrência)
const db = await PGlite.create({ extensions: { pgcrypto } });
await setup(db, src);

const ID = { adm: '00000000-0000-4000-8000-0000000000a1', ges: '00000000-0000-4000-8000-0000000000a2',
  c: '00000000-0000-4000-8000-0000000000c1' };
const TODAY = '2026-11-05';
await db.exec(`create or replace function public.data_as_of(p_company uuid) returns date language sql stable as $$ select date '${TODAY}' $$;`);

const nn = await db.query(`select column_name, is_nullable from information_schema.columns
  where table_schema='public' and table_name='invoices'
    and column_name in ('status','operation_scope','business_channel','is_biomie_commercial_visible','customer_id') order by 1`);
console.log('invoices nullability:', nn.rows.map((r) => `${r.column_name}=${r.is_nullable}`).join(' '));

const t0 = Date.now();
await db.exec(`
do $$
declare c uuid := '${ID.c}'; adm uuid := '${ID.adm}'; ges uuid := '${ID.ges}'; s uuid[]; cu uuid[]; pr uuid[];
  t uuid := gen_random_uuid();
begin
  insert into auth.users(id, email) values (adm, 'adm@invalid.example'), (ges, 'ges@invalid.example');
  insert into public.profiles(id, full_name) values (adm, 'Admin'), (ges, 'Gestor');
  insert into public.user_roles(user_id, role) values (adm, 'ADMIN'), (ges, 'GESTOR');
  insert into public.companies(id, name, slug, data_source, revenue_basis) values (c, 'Bench', 'bench', 'OMIE_SHADOW', 'commercial_base');
  insert into public.channels(company_id, name) values (c, 'varejo'), (c, 'licitacao'), (c, 'outros');
  insert into public.user_company_access(user_id, company_id) values (adm, c), (ges, c);
  insert into public.sellers(company_id, name, external_id) select c, 'Vendedor ' || lpad(g::text, 2, '0'), 'V' || g from generate_series(1, 30) g;
  insert into public.products(company_id, name, category, base_price) select c, 'Produto ' || g, 'Cat ' || (g % 20), 1 from generate_series(1, 1600) g;
  insert into public.customers(company_id, name, state, city) select c, 'Cliente ' || g, 'CE', 'Fortaleza' from generate_series(1, 8000) g;
  select array_agg(id order by name) into s from public.sellers where company_id = c;
  select array_agg(id order by name) into cu from public.customers where company_id = c;
  select array_agg(id order by name) into pr from public.products where company_id = c;
  insert into public.sales_teams(id, company_id, name) values (t, c, 'Equipe');
  insert into public.sales_team_managers(team_id, user_id, valid_from) values (t, ges, date '2026-01-01');
  insert into public.sales_team_members(team_id, seller_id, valid_from) select t, s[g], date '2026-01-01' from generate_series(1, 10) g;
  -- ~13 meses de notas (01/10/2025 a 05/11/2026) + 2 anos de histórico ralo (clientes antigos).
  insert into public.invoices(company_id, seller_id, customer_id, number, competence_date, total, source, external_id,
      gross_amount, goods_amount, commercial_base_amount, operation_scope, business_channel, is_biomie_commercial_visible)
    select c, case when g % 50 = 0 then null else s[1 + (g % 30)] end, cu[1 + ((g * 7919) % ${NCU})], 'N' || g,
      case when g % 4 = 0 then date '2023-10-01' + (g % 730) else date '2025-10-01' + (g % 401) end,
      300 + (g % 7), 'omie', 'b-' || g, 300 + (g % 7), 300 + (g % 7), 290 + (g % 7),
      case when g % 41 = 0 then 'remittance' else 'commercial' end,
      case when g % 10 = 0 then 'licitacao' when g % 33 = 0 then 'outros' else 'varejo' end,
      g % 10 <> 0
    from generate_series(1, ${N}) g;
  insert into public.invoice_items(invoice_id, company_id, seller_id, product_id, quantity, total, item_sequence)
    select i.id, c, i.seller_id, pr[1 + ((abs(hashtext(i.id::text)) + k * 17) % 1600)], 1 + k % 3, 40 + k * 13 + (i.total - 300), k
    from public.invoices i, generate_series(1, 1 + abs(hashtext(i.number)) % 5) k where i.company_id = c;
  insert into public.sales_orders(company_id, seller_id, customer_id, number, status, order_date, expected_date, total,
      source, operation_scope, stage_code, business_channel)
    select c, s[1 + (g % 30)], cu[1 + ((g * 31) % 8000)], 'P' || g, 'open', date '${TODAY}' - (g % 60),
      date '${TODAY}' - (g % 60) + 20, 1000 + (g % 13), 'omie', 'commercial', case when g % 3 = 0 then '10' else '20' end, 'varejo'
    from generate_series(1, 700) g;
  insert into public.sales_order_items(order_id, company_id, seller_id, product_id, quantity, total)
    select o.id, c, o.seller_id, pr[1 + ((abs(hashtext(o.id::text)) + k) % 1600)], 1, o.total / 2
    from public.sales_orders o, generate_series(1, 2) k where o.company_id = c;
end $$;
analyze;`);
const vol = (await db.query(`select (select count(*) from public.invoices)::int inv, (select count(*) from public.invoice_items)::int items,
  (select count(*) from public.invoices where competence_date between '2026-01-01' and '${TODAY}')::int inv_ytd`)).rows[0];
console.log(`dados: ${JSON.stringify(vol)} em ${((Date.now() - t0) / 1000).toFixed(1)} s`);

async function as(role, user, sql) {
  const claims = role === 'service_role' ? '{"role":"service_role"}' : `{"sub":"${user}","role":"authenticated"}`;
  await db.exec(`begin; select set_config('request.jwt.claims', '${claims}', true); set local role ${role};`);
  try {
    const r = await db.query(sql);
    await db.exec('commit;');
    return r.rows[0] ? Object.values(r.rows[0])[0] : null;
  } catch (e) {
    await db.exec('rollback;');
    throw e;
  }
}
async function timed(role, user, sql, n = 3) {
  const ms = [];
  let out;
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    out = await as(role, user, sql);
    ms.push(Math.round(performance.now() - t));
  }
  ms.sort((a, b) => a - b);
  return { ms: ms[Math.floor(n / 2)], all: ms, out };
}

const C = `'${ID.c}'`;
const WINDOWS = JSON.stringify({
  previous: { start: '2026-10-01', end: '2026-10-05' },
  lastYear: { start: '2025-11-01', end: '2025-11-05' },
  trailing3: { start: '2026-08-01', end: '2026-10-31', divisor: 3 },
});
const Q = {
  fs10: `select count(*)::text || ' / ' || sum(amount)::text from public.fact_sales(${C}, '2026-01-01', '${TODAY}')`,
  fsSum: `select md5(string_agg(x::text, ',' order by x::text)) from public.fact_sales(${C}, '2025-10-01', '${TODAY}') x`,
  fsVarejo: `select md5(string_agg(x::text, ',' order by x::text)) from public.fact_sales(${C}, '2026-01-01', '${TODAY}',
    (select id from public.channels where company_id = ${C} and name = 'varejo')) x`,
  dataset: `select public.flight_plan_v2_dataset(${C}, 2026, 11, '${WINDOWS}'::jsonb)::text`,
  year: `select public.flight_plan_v2_year(${C}, 2026)::text`,
  lists: `select public.flight_plan_v2_target_lists(${C})::text`,
};

async function run(label, roles = [['authenticated', ID.adm]]) {
  const res = {};
  for (const [role, user] of roles) {
    const tag = role === 'service_role' ? 'sem RLS' : user === ID.ges ? 'gestor' : 'admin';
    const r = {};
    r.fs10 = await timed(role, user, Q.fs10);
    r.fsSum = await as(role, user, Q.fsSum);
    r.fsVarejo = await as(role, user, Q.fsVarejo);
    if (role !== 'service_role') {
      r.dataset = await timed(role, user, Q.dataset);
      r.year = await timed(role, user, Q.year);
      r.lists = await timed(role, user, Q.lists);
    }
    res[tag] = r;
    console.log(`${label.padEnd(34)} ${tag.padEnd(8)} fact_sales 10 meses ${String(r.fs10.ms).padStart(6)} ms (${r.fs10.out})` +
      (r.dataset ? ` | dataset ${r.dataset.ms} ms | ano ${r.year.ms} ms | listas ${r.lists.ms} ms` : ''));
  }
  return res;
}

const roles = [['authenticated', ID.adm], ['authenticated', ID.ges], ['service_role', null]];
const v0 = await run('ATUAL', roles);

await db.exec(readFileSync(path.join(here, 'cand_fact_sales.sql'), 'utf8'));
const v1 = await run('CANDIDATA (regras 1x)', roles);

// "Clientes novos" por EXISTS (para no 1º achado), com e sem índice (company_id, customer_id, competence_date).
const mig = readFileSync(path.join(src, 'drizzle/migrations/0050_flight_plan_v2.sql'), 'utf8').replace(/\r\n/g, '\n');
const start = mig.indexOf('create or replace function public.flight_plan_v2_dataset(');
const end = mig.indexOf('\nend $$;', start) + '\nend $$;'.length;
const fn = mig.slice(start, end);
const OLD_PB = `  ), prior_buyers as (
    select distinct i.customer_id from public.invoices i
    where i.company_id = p_company and i.competence_date < v_start
      and i.customer_id in (select customer_id from cur)
      and i.status = any(public.revenue_valid_statuses())
      and public.invoice_revenue_eligible(i.company_id, i.operation_scope, i.business_channel, i.is_biomie_commercial_visible)
  ), sr as (`;
const NEW_PB = `  ), cur_customers as materialized (
    select distinct customer_id from cur where customer_id is not null
  ), prior_buyers as (
    select cc.customer_id from cur_customers cc
    where exists (select 1 from public.invoices i
      where i.company_id = p_company and i.customer_id = cc.customer_id and i.competence_date < v_start
        and i.status = any(public.revenue_valid_statuses())
        and public.invoice_revenue_eligible(i.company_id, i.operation_scope, i.business_channel, i.is_biomie_commercial_visible))
  ), sr as (`;
if (!fn.includes(OLD_PB)) throw new Error('trecho prior_buyers não encontrado na 0050');
// Sem o índice, o EXISTS levou 18 s na 1ª medição (02:50): só faz sentido com o índice.
await db.exec('create index invoices_company_customer_date_idx on public.invoices(company_id, customer_id, competence_date); analyze public.invoices;');
await db.exec(fn.replace(OLD_PB, NEW_PB));
const v3 = await run('  … + índice (empresa, cliente, data)', roles.slice(0, 2));
const LAT_PB = `  ), cur_customers as materialized (
    select distinct customer_id from cur where customer_id is not null
  ), prior_buyers as (
    select cc.customer_id from cur_customers cc
    cross join lateral (select 1 from public.invoices i
      where i.company_id = p_company and i.customer_id = cc.customer_id and i.competence_date < v_start
        and i.status = any(public.revenue_valid_statuses())
        and public.invoice_revenue_eligible(i.company_id, i.operation_scope, i.business_channel, i.is_biomie_commercial_visible)
      limit 1) hit
  ), sr as (`;
await db.exec(fn.replace(OLD_PB, LAT_PB));
const v4 = await run('  … LATERAL limit 1 + índice', roles.slice(0, 2));

// Igualdade: cada variante tem de devolver exatamente o mesmo que a atual.
const diffs = [];
for (const [name, v] of [['candidata', v1], ['exists+índice', v3], ['lateral+índice', v4]]) {
  for (const tag of Object.keys(v)) {
    const a = v0[tag], b = v[tag];
    for (const k of ['fsSum', 'fsVarejo']) if (a[k] !== b[k]) diffs.push(`${name}/${tag}/${k}`);
    for (const k of ['fs10', 'dataset', 'year', 'lists']) if (a[k] && b[k] && a[k].out !== b[k].out) diffs.push(`${name}/${tag}/${k}`);
  }
}
const nc = JSON.parse(v0.admin.dataset.out).totals;
console.log(`totais do mês (admin): ${JSON.stringify(nc)}`);
console.log(diffs.length ? `DIFERENÇAS: ${diffs.join(', ')}` : 'IGUALDADE: todas as variantes devolveram exatamente o mesmo resultado');
await db.close();
