"""Cópia da homologação × produção (SÓ LEITURA nos dois bancos): evidências da versão combinada.

    python ops/remote.py ops/48_hml_vs_prod.py [--esperar]

A cópia (biomie_v2_hml) é a produção num momento; a versão nova roda nela. Compara, por empresa:
- estoque: posições, unidades e valor a custo da leitura publicada (só se a leitura publicada for a
  mesma nos dois bancos; senão a empresa sai como "não comparável": a produção leu depois da cópia);
- curvas: produtos e faturamento por curva e janela (stock_auto_curves; só se o último cálculo for o mesmo);
- faturamento: fact_sales (a base da página Produtos) por mês fechado de 2026 (janeiro até o mês passado):
  valor, unidades e notas;
- sales_kpis: o da produção (o atual) × o da cópia (o da release em teste), nos trimestres fechados e de 1º
  a 25 de outubro, sem filtro: o JSON inteiro tem de ser igual; o tempo de cada um é medido uma vez.
Nada é gravado: transações read only, limite de 120 s por consulta. Na produção são ~20 chamadas do
sales_kpis, à noite e dentro da janela de testes.
"""
import json
import subprocess
import sys

COMPOSE = ['docker', 'compose', '--env-file', '/opt/biomie-v2/shared/stack.env', '-f', '/opt/biomie-v2/compose.yml']

SNAPSHOT = r"""
begin read only;
set local statement_timeout = '120s';
select json_build_object(
  'migrations', (select max(name) from private.vps_schema_migrations),
  'companyIds', (select json_object_agg(slug, id) from public.companies where not is_demo),
  'salesKpisMd5', (select md5(pg_get_functiondef('public.sales_kpis(uuid,date,date,uuid,uuid,uuid,text,text,text)'::regprocedure))),
  'readings', (select json_object_agg(c.slug, sc.reading_id) from private.stock_current sc
               join public.companies c on c.id = sc.company_id),
  'curveRuns', (select json_object_agg(c.slug, r.finished_at) from (select distinct on (company_id) company_id, finished_at
                 from private.stock_curve_runs where status = 'ok' order by company_id, finished_at desc) r
               join public.companies c on c.id = r.company_id),
  'stock', (select json_object_agg(t.slug, t.v) from (select c.slug, json_build_object('positions', count(*),
              'units', sum(sp.physical_qty), 'cost', round(sum(sp.physical_qty * sp.unit_cost), 2)) v
            from private.stock_current sc join private.stock_positions sp on sp.reading_id = sc.reading_id
            join public.companies c on c.id = sc.company_id group by c.slug) t),
  'curves', (select json_object_agg(t.k, t.v) from (select c.slug || ':' || a.curve_window as k,
               json_object_agg(a.curve, json_build_object('products', a.n, 'revenue', a.rev) order by a.curve) as v
             from (select company_id, curve_window, curve, count(*) n, round(sum(revenue), 2) rev
                   from private.stock_auto_curves group by 1, 2, 3) a
             join public.companies c on c.id = a.company_id group by c.slug, a.curve_window) t),
  'sales', (select json_object_agg(t.k, t.v) from (
              select c.slug || ':' || to_char(m.m, 'YYYY-MM') as k,
                json_build_object('amount', round(coalesce(sum(f.amount), 0), 2), 'units', coalesce(sum(f.qty), 0),
                                  'invoices', count(distinct f.invoice_id)) as v
              from public.companies c
              cross join generate_series(date '2026-01-01', date_trunc('month', current_date) - interval '1 month',
                                         interval '1 month') m(m)
              left join lateral public.fact_sales(c.id, m.m::date, (m.m + interval '1 month - 1 day')::date) f on true
              where not c.is_demo
              group by c.slug, m.m) t));
commit;
"""

PERIODS = [('t1', '2026-01-01', '2026-03-31'), ('t2', '2026-04-01', '2026-06-30'),
           ('t3', '2026-07-01', '2026-09-30'), ('out1a25', '2026-10-01', '2026-10-25')]


def kpis(db, companies):
    """Uma consulta por caso, com o tempo do próprio psql (meta-comando timing); transação read only."""
    lines = ["begin read only;", "set local statement_timeout = '120s';", chr(92) + "timing on"]
    for slug, cid in sorted(companies.items()):
        for k, start, end in PERIODS:
            lines.append(f"select '{slug}:{k}', md5(x::text), x::text from "
                         f"(select public.sales_kpis('{cid}'::uuid, date '{start}', date '{end}') x) s;")
    lines.append('commit;')
    p = subprocess.run(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', db, '-At',
                                  '-v', 'ON_ERROR_STOP=1'], input=chr(10).join(lines) + chr(10),
                       capture_output=True, text=True, timeout=1800)
    if p.returncode:
        raise SystemExit(f'{db}: ' + p.stderr[-1500:])
    out, last = {}, None
    for line in p.stdout.splitlines():
        if line.startswith('Time: ') and last:
            out[last]['ms'] = float(line.split()[1])
            last = None
        elif line.count('|') >= 2 and ':' in line.split('|', 1)[0]:
            key, digest, value = line.split('|', 2)
            out[key] = {'md5': digest, 'value': json.loads(value), 'ms': None}
            last = key
    return out


def query(db, sql):
    p = subprocess.run(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', db, '-At',
                                  '-v', 'ON_ERROR_STOP=1'], input=sql, capture_output=True, text=True, timeout=1800)
    if p.returncode:
        raise SystemExit(f'{db}: ' + p.stderr[-1500:])
    lines = [line for line in p.stdout.splitlines() if line.startswith('{')]
    return json.loads(lines[-1]) if lines else None


def diff(a, b):
    """Chaves com valor diferente (ou só de um lado)."""
    a, b = a or {}, b or {}
    return sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))


prod, copy = query('biomie_v2', SNAPSHOT), query('biomie_v2_hml', SNAPSHOT)
companies = sorted(set(prod['readings'] or {}) | set(copy['readings'] or {}))
same_reading = {c: (prod['readings'] or {}).get(c) == (copy['readings'] or {}).get(c) for c in companies}
same_curves = {c: (prod['curveRuns'] or {}).get(c) == (copy['curveRuns'] or {}).get(c) for c in companies}
stock_diff = [c for c in companies if same_reading[c] and (prod['stock'] or {}).get(c) != (copy['stock'] or {}).get(c)]
curve_keys = sorted(set(prod['curves'] or {}) | set(copy['curves'] or {}))
curve_diff = [k for k in curve_keys if same_curves.get(k.split(':')[0])
              and (prod['curves'] or {}).get(k) != (copy['curves'] or {}).get(k)]
sales_diff = diff(prod['sales'], copy['sales'])
kp_prod, kp_copy = kpis('biomie_v2', prod['companyIds']), kpis('biomie_v2_hml', prod['companyIds'])
kp_cases = sorted(set(kp_prod or {}) | set(kp_copy or {}))
kp_diff = [k for k in kp_cases if (kp_prod or {}).get(k, {}).get('md5') != (kp_copy or {}).get(k, {}).get('md5')]
ms = lambda d: round(sum(v['ms'] or 0 for v in (d or {}).values()), 1)  # noqa: E731
out = {
    'migrations': {'production': prod['migrations'], 'copy': copy['migrations']},
    'salesKpisVersion': {'production': prod['salesKpisMd5'], 'copy': copy['salesKpisMd5'],
                         'different': prod['salesKpisMd5'] != copy['salesKpisMd5']},
    'stock': {'comparable': [c for c in companies if same_reading[c]],
              'notComparable': [c for c in companies if not same_reading[c]], 'different': stock_diff},
    'curves': {'comparable': [c for c in companies if same_curves[c]],
               'notComparable': [c for c in companies if not same_curves[c]], 'different': curve_diff},
    'sales': {'monthsCompared': len(set(prod['sales'] or {}) | set(copy['sales'] or {})), 'different': sales_diff},
    'salesKpis': {'cases': len(kp_cases), 'different': kp_diff,
                  'msProduction': ms(kp_prod), 'msCopy': ms(kp_copy),
                  'byCase': {k: [(kp_prod or {}).get(k, {}).get('ms'), (kp_copy or {}).get(k, {}).get('ms')] for k in kp_cases},
                  'diffSamples': {k: {'production': (kp_prod or {}).get(k, {}).get('value'),
                                      'copy': (kp_copy or {}).get(k, {}).get('value')} for k in kp_diff[:3]}},
    'stockByCompany': {c: {'production': (prod['stock'] or {}).get(c), 'copy': (copy['stock'] or {}).get(c)}
                       for c in companies},
}
out['allEqual'] = not (stock_diff or curve_diff or sales_diff or kp_diff)
print(json.dumps(out, indent=1, ensure_ascii=False, default=str))
sys.exit(0)
