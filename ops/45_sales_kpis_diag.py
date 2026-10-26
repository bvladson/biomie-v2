"""Diagnóstico de desempenho de sales_kpis (prioridade 1 dos pareceres) — SÓ na cópia biomie_v2_hml.

    python ops/remote.py ops/45_sales_kpis_diag.py [--planos] --esperar

Mede, como um usuário logado (Super admin da cópia, mesmo caminho das telas), por empresa e período:
- sales_kpis inteiro;
- as partes: vendas do período (fact_sales), primeira compra de cada cliente em TODO o histórico (a
  parte "newCustomers") e pedidos (fact_orders lê todos os pedidos e só depois filtra o período);
- tamanhos (linhas de vendas no histórico e pedidos).
Cada medida roda 2 vezes (fria e quente). Com --planos, guarda os planos das consultas internas de uma
chamada representativa (auto_explain com ANALYZE) para achar o nó mais caro.
Só leitura; a cópia roda sem paralelismo (1 núcleo por consulta), como manda a janela de testes.
"""
import json
import pathlib
import subprocess
import sys

BASE = pathlib.Path('/opt/biomie-v2')
COMPOSE = ['docker', 'compose', '--env-file', str(BASE / 'shared/stack.env'), '-f', str(BASE / 'compose.yml')]
DB = 'biomie_v2_hml'


def psql(sql, timeout=3600):
    p = subprocess.run(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', DB, '-At',
                                  '-v', 'ON_ERROR_STOP=1'], input=sql, capture_output=True, text=True,
                       timeout=timeout)
    if p.returncode:
        raise SystemExit(p.stderr[-1500:])
    return p.stdout, p.stderr


MEASURE = r"""
begin;
set local max_parallel_workers_per_gather = 0;
-- o bloco inteiro é uma instrução só: 30 min para ele (cada consulta medida é limitada pelo desenho)
set local statement_timeout = '1800s';
select set_config('request.jwt.claims', json_build_object('sub',
  (select user_id from public.user_roles where role = 'SUPER_ADMIN' limit 1), 'role', 'authenticated')::text, true);
create temp table diag(company text, period text, part text, run int, ms numeric, rows bigint) on commit drop;
grant all on diag to authenticated;
set local role authenticated;
do $$
declare
  c record; p record; t0 timestamptz; n bigint; k jsonb; i int;
  periods jsonb := jsonb_build_array(
    jsonb_build_object('name', 'mes_atual', 's', date_trunc('month', current_date)::date, 'e', current_date),
    jsonb_build_object('name', 'mes_fechado', 's', (date_trunc('month', current_date) - interval '1 month')::date,
                       'e', (date_trunc('month', current_date) - interval '1 day')::date),
    jsonb_build_object('name', '90_dias', 's', current_date - 89, 'e', current_date),
    jsonb_build_object('name', '12_meses', 's', current_date - 364, 'e', current_date));
begin
  for c in select id, slug from public.companies where not is_demo order by slug loop
    for i in 1..2 loop
      t0 := clock_timestamp();
      select count(*) into n from (select customer_id, min(competence_date)
        from public.fact_sales(c.id, '-infinity'::date, 'infinity'::date) group by 1) x;
      insert into diag values (c.slug, 'historico', 'primeira_compra_por_cliente', i,
        round(extract(epoch from clock_timestamp() - t0) * 1000), n);
      t0 := clock_timestamp();
      select count(*) into n from public.fact_sales(c.id, '-infinity'::date, 'infinity'::date);
      insert into diag values (c.slug, 'historico', 'linhas_de_venda', i,
        round(extract(epoch from clock_timestamp() - t0) * 1000), n);
      t0 := clock_timestamp();
      select count(*) into n from public.fact_orders(c.id, null, null, null, null, null, null);
      insert into diag values (c.slug, 'historico', 'pedidos_todos', i,
        round(extract(epoch from clock_timestamp() - t0) * 1000), n);
    end loop;
    for p in select * from jsonb_to_recordset(periods) as x(name text, s date, e date) loop
      for i in 1..2 loop
        t0 := clock_timestamp();
        k := public.sales_kpis(c.id, p.s, p.e);
        insert into diag values (c.slug, p.name, 'sales_kpis', i,
          round(extract(epoch from clock_timestamp() - t0) * 1000), coalesce((k->>'invoices')::bigint, 0));
        t0 := clock_timestamp();
        select count(*) into n from public.fact_sales(c.id, p.s, p.e);
        insert into diag values (c.slug, p.name, 'vendas_do_periodo', i,
          round(extract(epoch from clock_timestamp() - t0) * 1000), n);
        t0 := clock_timestamp();
        select count(distinct order_id) into n from public.fact_orders(c.id, null, null, null, null, null, null)
          where status <> 'cancelled' and order_date between p.s and p.e;
        insert into diag values (c.slug, p.name, 'pedidos_do_periodo', i,
          round(extract(epoch from clock_timestamp() - t0) * 1000), n);
      end loop;
    end loop;
  end loop;
end $$;
reset role;
select coalesce(json_agg(d order by d.company, d.period, d.part, d.run), '[]') from diag d;
commit;
"""

PLANS = r"""
load 'auto_explain';
set auto_explain.log_min_duration = 0;
set auto_explain.log_analyze = on;
set auto_explain.log_buffers = on;
set auto_explain.log_nested_statements = on;
set auto_explain.log_level = notice;
set max_parallel_workers_per_gather = 0;
set statement_timeout = '300s';
begin;
select set_config('request.jwt.claims', json_build_object('sub',
  (select user_id from public.user_roles where role = 'SUPER_ADMIN' limit 1), 'role', 'authenticated')::text, true);
set local role authenticated;
select length(public.sales_kpis((select id from public.companies where slug = 'mag-filial'),
  current_date - 364, current_date)::text);
commit;
"""

out, _ = psql(MEASURE)
rows = json.loads(' '.join(line for line in out.splitlines() if line not in ('BEGIN', 'COMMIT', 'SET', 'LOAD')
                           and not line.startswith(('{"sub"', 'GRANT', 'DO', 'RESET', 'CREATE'))) or '[]')
summary = {}
for r in rows:
    key = f"{r['company']}|{r['period']}|{r['part']}"
    summary.setdefault(key, {'rows': r['rows'], 'ms': []})['ms'].append(float(r['ms']))
report = {'db': DB, 'parallel': 0, 'measures': summary}
if '--planos' in sys.argv:
    _, notices = psql(PLANS)
    target = pathlib.Path('/opt/biomie-v2/hml/sales_kpis_planos.txt')
    target.write_text(notices)
    report['plans'] = {'file': str(target), 'chars': len(notices), 'head': notices[:6000]}
print(json.dumps(report, indent=1, ensure_ascii=False))
