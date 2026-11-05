// Teste LOCAL do SQL da ops/57_faturamento_check.py (PGlite): roda o mesmo texto que o servidor rodaria.
// Uso: node test57.mjs <source> <57_faturamento_check.py> [sem0051]
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync } from 'node:fs';
import { setup } from './setup.mjs';

const [src, script, mode] = process.argv.slice(2);
const py = readFileSync(script, 'utf8');
const sql = py.slice(py.indexOf('SQL = r"""') + 'SQL = r"""'.length, py.indexOf('"""', py.indexOf('SQL = r"""') + 10));
const db = await PGlite.create({ extensions: { pgcrypto } });
await setup(db, src, mode === 'sem0051' ? ['0051_fact_sales_performance'] : []);
await db.exec(`
do $$
declare c uuid := gen_random_uuid(); c2 uuid := gen_random_uuid(); sa uuid := gen_random_uuid(); ges uuid := gen_random_uuid();
  ven uuid := gen_random_uuid(); s uuid[]; cu uuid[]; pr uuid[]; t uuid := gen_random_uuid(); x uuid;
begin
  insert into auth.users(id, email, created_at) values (sa, 'sa@invalid.example', now() - interval '2 days'),
    (ges, 'ges@invalid.example', now() - interval '1 day'), (ven, 'ven@invalid.example', now());
  insert into public.profiles(id, full_name) values (sa, 'SA'), (ges, 'Gestor'), (ven, 'Vendedor');
  insert into public.user_roles(user_id, role) values (sa, 'SUPER_ADMIN'), (ges, 'GESTOR'), (ven, 'VENDEDOR');
  insert into public.companies(id, name, slug, data_source, revenue_basis) values
    (c, 'Teste 57 A', 't57a', 'OMIE_SHADOW', 'commercial_base'), (c2, 'Teste 57 B', 't57b', 'OMIE_SHADOW', 'goods');
  foreach x in array array[c, c2] loop
    insert into public.channels(company_id, name) values (x, 'varejo'), (x, 'licitacao'), (x, 'outros');
    insert into public.sellers(company_id, name, external_id) select x, 'V ' || g, 'V' || g from generate_series(1, 8) g;
    insert into public.products(company_id, name, category, base_price) select x, 'P ' || g, 'Cat ' || (g % 5), 1 from generate_series(1, 200) g;
    insert into public.customers(company_id, name, state, city) select x, 'C ' || g, 'CE', 'Fortaleza' from generate_series(1, 600) g;
    select array_agg(id order by name) into s from public.sellers where company_id = x;
    select array_agg(id order by name) into cu from public.customers where company_id = x;
    select array_agg(id order by name) into pr from public.products where company_id = x;
    insert into public.invoices(company_id, seller_id, customer_id, number, competence_date, total, source, external_id,
        gross_amount, goods_amount, commercial_base_amount, operation_scope, business_channel, is_biomie_commercial_visible)
      select x, s[1 + g % 8], cu[1 + (g * 7) % 500], 'N' || g, (now() at time zone 'America/Sao_Paulo')::date - (g % 500),
        300 + g % 7, 'omie', 't57-' || g, 300 + g % 7, 300 + g % 7, 290 + g % 7,
        case when g % 41 = 0 then 'remittance' else 'commercial' end,
        case when g % 10 = 0 then 'licitacao' when g % 33 = 0 then 'outros' else 'varejo' end, g % 10 <> 0
      from generate_series(1, 2500) g;
    insert into public.invoice_items(invoice_id, company_id, seller_id, product_id, quantity, total, item_sequence)
      select i.id, x, i.seller_id, pr[1 + (abs(hashtext(i.id::text)) + k) % 200], 1, 40 + k * 13 + (i.total - 300), k
      from public.invoices i, generate_series(1, 1 + abs(hashtext(i.number)) % 4) k where i.company_id = x;
    if x = c then
      insert into public.sales_teams(id, company_id, name) values (t, c, 'Equipe');
      insert into public.sales_team_managers(team_id, user_id, valid_from) values (t, ges, date '2026-01-01');
      insert into public.sales_team_members(team_id, seller_id, valid_from) select t, s[g], date '2026-01-01' from generate_series(1, 3) g;
      update public.sellers set user_id = ven where id = s[5];
      insert into public.user_company_access(user_id, company_id) values (ges, c), (ven, c);
    end if;
  end loop;
end $$;`);
let res;
try {
  res = await db.exec(sql);
} catch (e) {
  console.log(e.message.includes('SKIP-0051') ? 'SKIP como esperado: ' + e.message : 'ERRO: ' + e.message);
  await db.close();
  process.exit(e.message.includes('SKIP-0051') && mode === 'sem0051' ? 0 : 1);
}
const found = {};
for (const r of res) for (const row of r.rows || []) {
  const v = Object.values(row)[0];
  if (typeof v === 'string') for (const tag of ['FC-SUPER', 'FC-GESTOR', 'FC-VENDEDOR']) if (v.startsWith(tag + ' ')) found[tag] = JSON.parse(v.slice(tag.length + 1));
}
for (const [tag, list] of Object.entries(found)) {
  if (!list) { console.log(tag, 'sem pessoa'); continue; }
  for (const c of list) {
    console.log(tag, c.slug, 'clientes novos', c.clientesNovos, '×', c.clientesNovosAnterior, '| plano mês ms', c.msPlanoMes,
      '| ano', c.msPlanoAno, '| listas', c.msPlanoListas);
    for (const w of c.janelas) console.log('   ', w.janela, 'igual', w.igual, 'linhas', w.linhas, '×', w.linhasAnterior, 'soma', w.soma, '×', w.somaAnterior, 'ms nova', w.msNova, 'anterior', w.msAnterior);
  }
}
const after = (await db.query(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname like 'pg_temp%'`)).rows[0].n;
console.log('funções temporárias que sobraram depois do rollback:', after);
await db.close();
