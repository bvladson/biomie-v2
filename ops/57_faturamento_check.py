"""Faturamento 0051 (desempenho): definição NOVA × ANTERIOR na CÓPIA da homologação — mesmas linhas e tempo.

    python ops/remote.py ops/57_faturamento_check.py --esperar

Só na cópia (biomie_v2_hml), depois das migrações; se a 0051 não estiver aplicada nela, devolve skipped.
Numa transação DESFEITA no fim (rollback), cria em pg_temp as definições anteriores de invoice_item_amounts e
fact_sales (texto exato da 0021, embutido abaixo) e compara, em cada empresa real:
- como o Super admin mais antigo (mesmo caminho das telas): fact_sales do ano até hoje, do mês e dos últimos
  365 dias — mesmas linhas (md5 do conjunto ordenado), mesma contagem e soma; tempo de cada versão nas mesmas
  janelas (3 chamadas alternadas, mediana); "clientes novos" do mês no Plano de Voo × referência anterior;
  tempo das leituras do Plano (mês, ano, listas);
- como um Gestor com equipe e um Vendedor ligado (os mais antigos, se existirem): mesmas linhas no ano.
Sem nomes de pessoas na saída. statement_timeout 15 min, sem paralelismo.
"""
import json
import pathlib
import subprocess
import sys

BASE = pathlib.Path('/opt/biomie-v2')
COMPOSE = ['docker', 'compose', '--env-file', str(BASE / 'shared/stack.env'), '-f', str(BASE / 'compose.yml')]
DB = 'biomie_v2_hml'

SQL = r"""
begin;
set local statement_timeout = '900s';
set local max_parallel_workers_per_gather = 0;
do $$ begin
  if not exists (select 1 from private.vps_schema_migrations where name like '0051_fact_sales_performance%') then
    raise exception 'SKIP-0051: a 0051 não está aplicada nesta cópia';
  end if;
end $$;

create function pg_temp.ref_amounts(p_company uuid,p_start date,p_end date)
returns table(item_id uuid,invoice_id uuid,amount numeric)
language sql stable security invoker set search_path=public as $$
  with original as (
    select it.id item_id,i.id invoice_id,it.total original_amount,i.total header_amount,
      public.company_revenue_basis(i.company_id)='commercial_base'
        and i.status=any(public.revenue_valid_statuses())
        and public.invoice_revenue_eligible(i.company_id,i.operation_scope,i.business_channel,i.is_biomie_commercial_visible) use_commercial,
      sum(it.total) over(partition by i.id) original_sum,
      row_number() over(partition by i.id order by it.item_sequence nulls last,it.id) item_position,
      count(*) over(partition by i.id) item_count
    from public.invoices i join public.invoice_items it on it.invoice_id=i.id and it.company_id=i.company_id
    where i.company_id=p_company and i.competence_date between p_start and p_end
  ), rounded as (
    select original.*,case when use_commercial
      then public.round_commercial_item(header_amount,original_amount,original_sum)
      else original_amount end provisional_amount from original
  )
  select item_id,invoice_id,provisional_amount+case
    when use_commercial and item_position=item_count
      then header_amount-sum(provisional_amount) over(partition by invoice_id)
    else 0 end from rounded
$$;

create function pg_temp.ref_fact_sales(p_company uuid,p_start date,p_end date,p_channel uuid default null,p_branch uuid default null,
  p_seller uuid default null,p_state text default null,p_city text default null,p_category text default null)
returns table(invoice_id uuid,competence_date date,seller_id uuid,customer_id uuid,product_id uuid,category text,state text,city text,qty numeric,amount numeric)
language sql stable security invoker set search_path=public as $$
  select i.id,i.competence_date,i.seller_id,i.customer_id,it.product_id,p.category,c.state,c.city,it.quantity,a.amount
  from pg_temp.ref_amounts(p_company,p_start,p_end) a
  join public.invoices i on i.id=a.invoice_id
  join public.invoice_items it on it.id=a.item_id
  join public.products p on p.id=it.product_id
  join public.customers c on c.id=i.customer_id
  where i.company_id=p_company and i.status=any(public.revenue_valid_statuses())
    and public.invoice_revenue_eligible(i.company_id,i.operation_scope,i.business_channel,i.is_biomie_commercial_visible)
    and (p_channel is null or i.channel_id=p_channel)
    and (p_branch is null or i.branch_id=p_branch)
    and (p_seller is null or i.seller_id=p_seller)
    and (p_state is null or c.state=p_state)
    and (p_city is null or c.city=p_city)
    and (p_category is null or p.category=p_category)
$$;

create function pg_temp.ref_new_customers(p_company uuid, p_start date, p_cut date) returns bigint
language sql stable as $f$
  with cur as (select distinct customer_id from pg_temp.ref_fact_sales(p_company, p_start, p_cut)),
  prior as (
    select distinct i.customer_id from public.invoices i
    where i.company_id = p_company and i.competence_date < p_start
      and i.customer_id in (select customer_id from cur)
      and i.status = any(public.revenue_valid_statuses())
      and public.invoice_revenue_eligible(i.company_id, i.operation_scope, i.business_channel, i.is_biomie_commercial_visible))
  select count(*) from cur where customer_id not in (select customer_id from prior)
$f$;

create function pg_temp.check_fs(p_full boolean) returns jsonb
language plpgsql as $f$
declare
  c record; w record; out jsonb := '[]'; rows jsonb; t0 timestamptz; i int;
  ms_new numeric[]; ms_ref numeric[]; h_new text; h_ref text; n_new bigint; n_ref bigint; s_new numeric; s_ref numeric;
  today date; st date; v_pm date; v_py date; d int; y int; m int; win jsonb; v jsonb; nc_new bigint; nc_ref bigint;
  ms_ds numeric[]; ms_year numeric; ms_lists numeric;
begin
  for c in select id, slug from public.companies
           where not is_demo and public.can_access_company(auth.uid(), id) order by slug loop
    today := public.data_as_of(c.id);
    st := date_trunc('month', today)::date;
    rows := '[]';
    for w in select * from (values ('ano', date_trunc('year', today)::date, today), ('mes', st, today),
                                   ('365', today - 365, today)) x(k, s, e)
             where p_full or x.k = 'ano' loop
      select md5(string_agg(x::text, ',' order by x::text)), count(*), coalesce(sum(x.amount), 0)
        into h_new, n_new, s_new from public.fact_sales(c.id, w.s, w.e) x;
      select md5(string_agg(x::text, ',' order by x::text)), count(*), coalesce(sum(x.amount), 0)
        into h_ref, n_ref, s_ref from pg_temp.ref_fact_sales(c.id, w.s, w.e) x;
      ms_new := '{}';
      ms_ref := '{}';
      if p_full then
        for i in 1..3 loop
          t0 := clock_timestamp();
          perform count(*), sum(x.amount) from pg_temp.ref_fact_sales(c.id, w.s, w.e) x;
          ms_ref := ms_ref || round(extract(epoch from clock_timestamp() - t0) * 1000);
          t0 := clock_timestamp();
          perform count(*), sum(x.amount) from public.fact_sales(c.id, w.s, w.e) x;
          ms_new := ms_new || round(extract(epoch from clock_timestamp() - t0) * 1000);
        end loop;
      end if;
      rows := rows || jsonb_build_object('janela', w.k, 'de', w.s, 'ate', w.e, 'igual', h_new is not distinct from h_ref,
        'linhas', n_new, 'linhasAnterior', n_ref, 'soma', s_new, 'somaAnterior', s_ref,
        'msNova', to_jsonb(ms_new), 'msAnterior', to_jsonb(ms_ref));
    end loop;
    d := extract(day from today)::int;
    y := extract(year from today)::int;
    m := extract(month from today)::int;
    v_pm := (st - interval '1 month')::date;
    v_py := (st - interval '1 year')::date;
    win := jsonb_build_object(
      'previous', jsonb_build_object('start', v_pm, 'end', least(v_pm + (d - 1), st - 1)),
      'lastYear', jsonb_build_object('start', v_py, 'end', least(v_py + (d - 1), (v_py + interval '1 month - 1 day')::date)),
      'trailing3', jsonb_build_object('start', (st - interval '3 months')::date, 'end', st - 1, 'divisor', 3));
    ms_ds := '{}';
    for i in 1..(case when p_full then 3 else 1 end) loop
      t0 := clock_timestamp();
      v := public.flight_plan_v2_dataset(c.id, y, m, win);
      ms_ds := ms_ds || round(extract(epoch from clock_timestamp() - t0) * 1000);
    end loop;
    nc_new := (v->'totals'->>'newCustomers')::bigint;
    nc_ref := pg_temp.ref_new_customers(c.id, st, today);
    ms_year := null;
    ms_lists := null;
    if p_full then
      t0 := clock_timestamp();
      perform public.flight_plan_v2_year(c.id, y);
      ms_year := round(extract(epoch from clock_timestamp() - t0) * 1000);
      t0 := clock_timestamp();
      perform public.flight_plan_v2_target_lists(c.id);
      ms_lists := round(extract(epoch from clock_timestamp() - t0) * 1000);
    end if;
    out := out || jsonb_build_object('slug', c.slug, 'hoje', today, 'janelas', rows,
      'clientesNovos', nc_new, 'clientesNovosAnterior', nc_ref, 'msPlanoMes', to_jsonb(ms_ds),
      'msPlanoAno', ms_year, 'msPlanoListas', ms_lists);
  end loop;
  return out;
end $f$;
grant execute on function pg_temp.ref_amounts(uuid, date, date),
  pg_temp.ref_fact_sales(uuid, date, date, uuid, uuid, uuid, text, text, text),
  pg_temp.ref_new_customers(uuid, date, date), pg_temp.check_fs(boolean) to authenticated;

select set_config('fc.super', coalesce((select r.user_id::text from public.user_roles r join auth.users u on u.id = r.user_id
  where r.role = 'SUPER_ADMIN' and u.email not like 'smoke-%' order by u.created_at limit 1), ''), true);
select set_config('fc.gestor', coalesce((select r.user_id::text from public.user_roles r join auth.users u on u.id = r.user_id
  where r.role = 'GESTOR' and u.email not like 'smoke-%'
    and exists (select 1 from public.sales_team_managers g where g.user_id = r.user_id and g.valid_to is null)
  order by u.created_at limit 1), ''), true);
select set_config('fc.vendedor', coalesce((select s.user_id::text from public.sellers s join auth.users u on u.id = s.user_id
  join public.user_roles r on r.user_id = s.user_id and r.role = 'VENDEDOR'
  where u.email not like 'smoke-%' order by u.created_at limit 1), ''), true);

select set_config('request.jwt.claims', json_build_object('sub', current_setting('fc.super'), 'role', 'authenticated')::text, true);
set local role authenticated;
select 'FC-SUPER ' || pg_temp.check_fs(true)::text;
reset role;

select set_config('request.jwt.claims', json_build_object('sub', nullif(current_setting('fc.gestor'), ''), 'role', 'authenticated')::text, true);
set local role authenticated;
select 'FC-GESTOR ' || case when auth.uid() is null then 'null' else pg_temp.check_fs(false)::text end;
reset role;

select set_config('request.jwt.claims', json_build_object('sub', nullif(current_setting('fc.vendedor'), ''), 'role', 'authenticated')::text, true);
set local role authenticated;
select 'FC-VENDEDOR ' || case when auth.uid() is null then 'null' else pg_temp.check_fs(false)::text end;
reset role;
rollback;
"""

if DB != 'biomie_v2_hml':
    raise SystemExit('só na cópia da homologação')
p = subprocess.run(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', DB, '-At', '-v', 'ON_ERROR_STOP=1'],
                   input=SQL, capture_output=True, text=True, timeout=3600)
if p.returncode:
    if 'SKIP-0051' in p.stderr:
        print(json.dumps({'database': DB, 'skipped': 'a 0051 não está aplicada nesta cópia', 'ok': None}, ensure_ascii=False))
        raise SystemExit(0)
    raise SystemExit(p.stderr[-1500:])
found = {}
for line in p.stdout.splitlines():
    for tag in ('FC-SUPER', 'FC-GESTOR', 'FC-VENDEDOR'):
        if line.startswith(tag + ' '):
            found[tag] = json.loads(line[len(tag) + 1:])
med = lambda xs: sorted(xs)[len(xs) // 2] if xs else None  # noqa: E731
problems = []
people = {'super': found.get('FC-SUPER'), 'gestor': found.get('FC-GESTOR'), 'vendedor': found.get('FC-VENDEDOR')}
if not people['super']:
    problems.append('sem resultado do Super admin')
for who, companies in people.items():
    for c in companies or []:
        for w in c['janelas']:
            if not w['igual'] or w['linhas'] != w['linhasAnterior'] or w['soma'] != w['somaAnterior']:
                problems.append(f"{who} {c['slug']} {w['janela']}: linhas {w['linhas']}×{w['linhasAnterior']}, "
                                f"soma {w['soma']}×{w['somaAnterior']}, md5 igual {w['igual']}")
            w['medianaNovaMs'], w['medianaAnteriorMs'] = med(w['msNova']), med(w['msAnterior'])
        if c['clientesNovos'] != c['clientesNovosAnterior']:
            problems.append(f"{who} {c['slug']}: clientes novos {c['clientesNovos']}×{c['clientesNovosAnterior']}")
        c['medianaPlanoMesMs'] = med(c['msPlanoMes'])
print(json.dumps({'database': DB, 'ok': not problems, 'problems': problems, **people}, ensure_ascii=False, indent=1))
