"""sales_kpis atual × rápido (0046) nos dados reais da cópia biomie_v2_hml — SÓ na homologação.

    python ops/remote.py ops/46_sales_kpis_compare.py <release> [--minutos=40] --esperar

Numa transação só, desfeita no fim (nada fica na cópia):
1. guarda a definição atual de public.sales_kpis (hash do texto e permissões) e cria uma cópia dela, sem
   mudança, num esquema temporário: é a referência;
2. aplica a migração 0046 da release exatamente como está no arquivo;
3. como Super admin (o caminho das telas): cada empresa nos períodos das telas, sem filtro, compara o
   JSON inteiro (como texto) e mede o tempo das duas versões (o novo roda 2 vezes, vale a segunda);
4. filtros reais: os 2 maiores de canal, filial, vendedor, UF, cidade e categoria em 12 meses, e duas
   combinações, no mês anterior e nos últimos 12 meses (só comparação, 1 vez cada);
5. vendedores restritos de verdade (até 3), cada um com o próprio acesso;
6. aplica o retorno (down) da release e confere que a definição voltou idêntica (hash e permissões).
Depois, à parte: índice candidato (empresa, cliente, data) criado na cópia, medido e APAGADO (sempre,
mesmo com erro). Para de abrir casos novos depois de --minutos (padrão 40) e diz quantos fez.
Sem nomes de pessoas na saída (vendedores e usuários aparecem por posição).
"""
import json
import pathlib
import subprocess
import sys
import time

BASE = pathlib.Path('/opt/biomie-v2')
COMPOSE = ['docker', 'compose', '--env-file', str(BASE / 'shared/stack.env'), '-f', str(BASE / 'compose.yml')]
DB = 'biomie_v2_hml'
SIG = "'public.sales_kpis(uuid,date,date,uuid,uuid,uuid,text,text,text)'::regprocedure"
TMP_INDEX = 'sk_cmp_tmp_inv_cust'



def psql(sql, timeout=4000):
    p = subprocess.run(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', DB, '-At',
                                  '-v', 'ON_ERROR_STOP=1'], input=sql, capture_output=True, text=True,
                       timeout=timeout)
    if p.returncode:
        raise RuntimeError(p.stderr[-2500:])
    return p.stdout


def last_json(out):
    lines = [line for line in out.splitlines() if line.startswith('{')]
    return json.loads(lines[-1]) if lines else None


PERIODS = """(values
  ('mes_atual', date_trunc('month', current_date)::date, current_date),
  ('mes_anterior', (date_trunc('month', current_date) - interval '1 month')::date, (date_trunc('month', current_date) - interval '1 day')::date),
  ('mesmo_mes_ano_passado', (date_trunc('month', current_date) - interval '1 year')::date, (current_date - interval '1 year')::date),
  ('ultimos_3_meses', (date_trunc('month', current_date) - interval '3 month')::date, (date_trunc('month', current_date) - interval '1 day')::date),
  ('ultimos_12_meses', (date_trunc('month', current_date) - interval '12 month')::date, (date_trunc('month', current_date) - interval '1 day')::date),
  ('ano_atual', date_trunc('year', current_date)::date, current_date),
  ('um_dia', current_date - 1, current_date - 1),
  ('tudo', '-infinity'::date, 'infinity'::date)) as p(period, s, e)"""

SUPER_CLAIMS = """select set_config('request.jwt.claims', json_build_object('sub',
  (select user_id from public.user_roles where role = 'SUPER_ADMIN' order by user_id limit 1), 'role', 'authenticated')::text, true);"""

# Uma chamada medida, com o erro guardado em vez de abortar (subtransação).
CALL = """
create function sk_cmp.call(p_new boolean, c sk_cmp.cases, out txt text, out err text, out ms numeric)
language plpgsql volatile security invoker set search_path = public as $f$
declare t0 timestamptz := clock_timestamp();
begin
  begin
    if p_new then
      txt := public.sales_kpis(c.company_id, c.s, c.e, c.ch, c.br, c.se, c.st, c.ci, c.ca)::text;
    else
      txt := sk_cmp.sales_kpis_ref(c.company_id, c.s, c.e, c.ch, c.br, c.se, c.st, c.ci, c.ca)::text;
    end if;
  exception when others then err := sqlstate || ' ' || sqlerrm;
  end;
  ms := round(extract(epoch from clock_timestamp() - t0) * 1000);
end $f$;
"""

RUN = """
do $$
declare
  r sk_cmp.cases; o record; n1 record; n2 record; v_deadline timestamptz := current_setting('sk.deadline')::timestamptz;
begin
  for r in select * from sk_cmp.cases where phase = any(string_to_array(current_setting('sk.phases'), ',')) order by id loop
    exit when clock_timestamp() > v_deadline;
    if r.as_user is not null then
      perform set_config('request.jwt.claims', json_build_object('sub', r.as_user, 'role', 'authenticated')::text, true);
    end if;
    if r.phase = 'A' then
      select * into n1 from sk_cmp.call(true, r);   -- aquece
    end if;
    select * into o from sk_cmp.call(false, r);
    select * into n2 from sk_cmp.call(true, r);
    insert into sk_cmp.res values (r.id, o.txt is not distinct from n2.txt and o.err is not distinct from n2.err,
      o.ms, n2.ms, case when o.txt is distinct from n2.txt then o.txt end, case when o.txt is distinct from n2.txt then n2.txt end,
      o.err, n2.err);
  end loop;
end $$;
"""

def build_main(MIG, DOWN, MINUTES):
    return f"""
begin;
set local max_parallel_workers_per_gather = 0;
set local statement_timeout = '3700s';
create schema sk_cmp;
create table sk_cmp.meta(k text primary key, v text);
insert into sk_cmp.meta values
  ('def_md5', md5(pg_get_functiondef({SIG}))),
  ('acl', coalesce((select proacl::text from pg_proc where oid = {SIG}), ''));
do $$ begin
  execute replace(pg_get_functiondef({SIG}), 'FUNCTION public.sales_kpis(', 'FUNCTION sk_cmp.sales_kpis_ref(');
end $$;
-- 0046 exatamente como no arquivo da release
{MIG}
create table sk_cmp.cases(id serial primary key, phase text, company_id uuid, company text, period text, s date, e date,
  filter text, ch uuid, br uuid, se uuid, st text, ci text, ca text, as_user uuid);
create table sk_cmp.res(case_id int, equal boolean, old_ms numeric, new_ms numeric, old_txt text, new_txt text,
  old_err text, new_err text);
{CALL}
-- A: períodos das telas, sem filtro
insert into sk_cmp.cases(phase, company_id, company, period, s, e, filter)
select 'A', c.id, c.slug, p.period, p.s, p.e, 'sem_filtro' from public.companies c cross join {PERIODS}
where not c.is_demo order by c.slug, p.period;
-- B: os 2 maiores valores reais de cada filtro em 12 meses e duas combinações
create table sk_cmp.top as
with base as (
  select i.company_id, i.channel_id, i.branch_id, i.seller_id, cu.state, cu.city, i.total
  from public.invoices i join public.customers cu on cu.id = i.customer_id
  join public.companies c on c.id = i.company_id and not c.is_demo
  where i.competence_date >= current_date - 365 and i.status = 'authorized'),
dims as (
  select company_id, 'canal' dim, channel_id::text val, sum(total) t from base where channel_id is not null group by 1, 2, 3
  union all select company_id, 'filial', branch_id::text, sum(total) from base where branch_id is not null group by 1, 2, 3
  union all select company_id, 'vendedor', seller_id::text, sum(total) from base where seller_id is not null group by 1, 2, 3
  union all select company_id, 'uf', state, sum(total) from base group by 1, 2, 3
  union all select company_id, 'cidade', city, sum(total) from base group by 1, 2, 3
  union all select i.company_id, 'categoria', p.category, sum(it.total)
    from public.invoices i join public.invoice_items it on it.invoice_id = i.id and it.company_id = i.company_id
    join public.products p on p.id = it.product_id join public.companies c on c.id = i.company_id and not c.is_demo
    where i.competence_date >= current_date - 365 and i.status = 'authorized' group by 1, 2, 3)
select company_id, dim, val, row_number() over (partition by company_id, dim order by t desc, val) rn from dims;
delete from sk_cmp.top where rn > 2;
insert into sk_cmp.cases(phase, company_id, company, period, s, e, filter, ch, br, se, st, ci, ca)
select 'B', t.company_id, c.slug, p.period, p.s, p.e, t.dim || '#' || t.rn,
  case when t.dim = 'canal' then t.val::uuid end, case when t.dim = 'filial' then t.val::uuid end,
  case when t.dim = 'vendedor' then t.val::uuid end, case when t.dim = 'uf' then t.val end,
  case when t.dim = 'cidade' then t.val end, case when t.dim = 'categoria' then t.val end
from sk_cmp.top t join public.companies c on c.id = t.company_id cross join {PERIODS}
where p.period in ('mes_anterior', 'ultimos_12_meses') order by c.slug, p.period, t.dim, t.rn;
insert into sk_cmp.cases(phase, company_id, company, period, s, e, filter, ch, se)
select 'B', a.company_id, c.slug, p.period, p.s, p.e, 'canal#1+vendedor#1', a.val::uuid, b.val::uuid
from sk_cmp.top a join sk_cmp.top b on b.company_id = a.company_id and b.dim = 'vendedor' and b.rn = 1
join public.companies c on c.id = a.company_id cross join {PERIODS}
where a.dim = 'canal' and a.rn = 1 and p.period in ('mes_anterior', 'ultimos_12_meses');
insert into sk_cmp.cases(phase, company_id, company, period, s, e, filter, st, ca)
select 'B', a.company_id, c.slug, p.period, p.s, p.e, 'uf#1+categoria#1', a.val, b.val
from sk_cmp.top a join sk_cmp.top b on b.company_id = a.company_id and b.dim = 'categoria' and b.rn = 1
join public.companies c on c.id = a.company_id cross join {PERIODS}
where a.dim = 'uf' and a.rn = 1 and p.period in ('mes_anterior', 'ultimos_12_meses');
-- C: vendedores restritos de verdade (até 3), com o próprio acesso
insert into sk_cmp.cases(phase, company_id, company, period, s, e, filter, as_user)
select 'C', a.company_id, c.slug, p.period, p.s, p.e, 'vendedor_restrito#' || u.n, u.user_id
from (select user_id, row_number() over (order by user_id) n from (
        select distinct ur.user_id from public.user_roles ur
        where ur.role in ('VENDEDOR', 'GESTOR') and public.is_seller_restricted(ur.user_id)
          and exists (select 1 from public.sellers s where s.user_id = ur.user_id)) x) u
join public.user_company_access a on a.user_id = u.user_id
join public.companies c on c.id = a.company_id and not c.is_demo
cross join {PERIODS}
where u.n <= 3 and p.period in ('mes_atual', 'mes_anterior', 'ultimos_12_meses')
  and exists (select 1 from public.sellers s where s.user_id = u.user_id and s.company_id = a.company_id);
grant usage on schema sk_cmp to authenticated;
grant select, insert on all tables in schema sk_cmp to authenticated;
grant execute on all functions in schema sk_cmp to authenticated;
select set_config('sk.deadline', (clock_timestamp() + interval '{MINUTES} minutes')::text, true);
{SUPER_CLAIMS}
set local role authenticated;
select set_config('sk.phases', 'A,B', true);
{RUN}
select set_config('sk.phases', 'C', true);
{RUN}
reset role;
-- 6: o retorno devolve a definição idêntica
{DOWN}
insert into sk_cmp.meta values
  ('def_md5_down', md5(pg_get_functiondef({SIG}))),
  ('acl_down', coalesce((select proacl::text from pg_proc where oid = {SIG}), ''));
select json_build_object(
  'asOf', (select json_object_agg(c.slug, (select max(i.competence_date) from public.invoices i where i.company_id = c.id))
           from public.companies c where not c.is_demo),
  'cases', (select json_object_agg(phase, n) from (select phase, count(*) n from sk_cmp.cases group by 1) x),
  'run', (select json_object_agg(phase, json_build_object('compared', n, 'equal', eq, 'errorsOld', eo, 'errorsNew', en))
          from (select k.phase, count(*) n, count(*) filter (where r.equal) eq, count(r.old_err) eo, count(r.new_err) en
                from sk_cmp.res r join sk_cmp.cases k on k.id = r.case_id group by 1) x),
  'mismatches', (select coalesce(json_agg(json_build_object('company', k.company, 'period', k.period, 'filter', k.filter,
                   'phase', k.phase, 'old', r.old_txt, 'new', r.new_txt, 'oldErr', r.old_err, 'newErr', r.new_err)), '[]')
                 from (select * from sk_cmp.res where not equal order by case_id limit 30) r join sk_cmp.cases k on k.id = r.case_id),
  'errorsEqual', (select coalesce(json_agg(json_build_object('company', k.company, 'period', k.period, 'filter', k.filter,
                   'err', r.old_err)), '[]')
                  from (select * from sk_cmp.res where equal and old_err is not null order by case_id limit 10) r
                  join sk_cmp.cases k on k.id = r.case_id),
  'timingA', (select json_agg(json_build_object('company', k.company, 'period', k.period, 'oldMs', r.old_ms, 'newMs', r.new_ms)
                order by k.company, k.period)
              from sk_cmp.res r join sk_cmp.cases k on k.id = r.case_id where k.phase = 'A'),
  'timingB', (select json_object_agg(company, json_build_object('oldMsSum', o, 'newMsSum', nn, 'cases', n)) from (
                select k.company, sum(r.old_ms) o, sum(r.new_ms) nn, count(*) n from sk_cmp.res r
                join sk_cmp.cases k on k.id = r.case_id where k.phase = 'B' group by 1) x),
  'deadlineReached', clock_timestamp() > current_setting('sk.deadline')::timestamptz,
  'downRestoresIdentical', (select (select v from sk_cmp.meta where k = 'def_md5') = (select v from sk_cmp.meta where k = 'def_md5_down')
                             and (select v from sk_cmp.meta where k = 'acl') = (select v from sk_cmp.meta where k = 'acl_down'))
)::text;
rollback;
"""

def build_index_timing(MIG):
    return f"""
begin;
set local max_parallel_workers_per_gather = 0;
set local statement_timeout = '1800s';
{MIG}
create temp table d(company text, period text, ms numeric) on commit drop;
grant all on d to authenticated;
{SUPER_CLAIMS}
set local role authenticated;
do $$
declare c record; p record; t0 timestamptz; k jsonb;
begin
  for c in select id, slug from public.companies where not is_demo order by slug loop
    for p in select * from {PERIODS} loop
      k := public.sales_kpis(c.id, p.s, p.e);
      t0 := clock_timestamp();
      k := public.sales_kpis(c.id, p.s, p.e);
      insert into d values (c.slug, p.period, round(extract(epoch from clock_timestamp() - t0) * 1000));
    end loop;
  end loop;
end $$;
reset role;
select json_build_object('timing', (select json_agg(d order by company, period) from d),
  'indcheckxmin', (select indcheckxmin from pg_index where indexrelid = 'public.{TMP_INDEX}'::regclass))::text;
rollback;
"""

def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if not args:
        raise SystemExit(__doc__)
    short = args[0]
    minutes = next((int(a.split('=', 1)[1]) for a in sys.argv if a.startswith('--minutos=')), 40)
    rel = BASE / 'releases' / short
    mig = (rel / 'drizzle/migrations/0046_sales_kpis_fast.sql').read_text(encoding='utf-8')
    down = (rel / 'deploy/db/rollback/0046_sales_kpis_fast.down.sql').read_text(encoding='utf-8')
    started = time.time()
    report = {'db': DB, 'release': short, 'minutes': minutes, 'parallel': 0}
    # A referência tem de ser o sales_kpis que está na produção: se a cópia já recebeu a 0046 (ex.: o trem
    # subiu antes), a comparação seria do rápido com ele mesmo. Confere o texto da função nos dois bancos.
    md5 = f'select md5(pg_get_functiondef({SIG}));'
    prod = subprocess.run(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', 'biomie_v2', '-At',
                                     '-c', 'begin read only; ' + md5 + ' commit;'],
                          capture_output=True, text=True, timeout=120).stdout.split()
    copy = psql(md5).split()
    pick = lambda tokens: next((t for t in tokens if len(t) == 32), None)  # noqa: E731
    report['referenceIsProduction'] = pick(prod) is not None and pick(prod) == pick(copy)
    if not report['referenceIsProduction']:
        report['skipped'] = 'o sales_kpis da cópia não é o da produção (a cópia já tem outra versão): refaça a cópia'
        print(json.dumps(report, indent=1, ensure_ascii=False))
        return
    try:
        report['compare'] = last_json(psql(build_main(mig, down, minutes)))
    except RuntimeError as exc:
        report['compareError'] = str(exc)
    report['compareSeconds'] = round(time.time() - started)
    # Índice candidato: criado na cópia, medido e apagado sempre (também se a medida falhar).
    t1 = time.time()
    try:
        psql(f'drop index if exists public.{TMP_INDEX}; '
             f'create index {TMP_INDEX} on public.invoices (company_id, customer_id, competence_date);', timeout=900)
        report['candidateIndex'] = last_json(psql(build_index_timing(mig)))
    except RuntimeError as exc:
        report['candidateIndexError'] = str(exc)
    finally:
        psql(f'drop index if exists public.{TMP_INDEX};', timeout=900)
        report['candidateIndexDropped'] = psql(f"select to_regclass('public.{TMP_INDEX}') is null;").strip().endswith('t')
    report['indexSeconds'] = round(time.time() - t1)
    report['seconds'] = round(time.time() - started)
    print(json.dumps(report, indent=1, ensure_ascii=False))


if __name__ == '__main__':
    main()
