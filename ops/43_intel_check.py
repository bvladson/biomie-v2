"""Conferência dos resultados publicados pelo motor de inteligência (SÓ LEITURA).

    python ops/remote.py ops/43_intel_check.py [biomie_v2_hml|biomie_v2]

Compara, por empresa, o que o motor gravou com as fontes:
- capital somado dos produtos = saldos positivos × CMC da leitura publicada, com a mesma conta do motor
  (capital de cada produto arredondado em centavos e depois somado, como na 0047); a soma arredondada só
  no fim (capitalPositions) pode diferir alguns centavos e fica como referência;
- unidades vendidas em 12 meses = fact_sales (a base da página Produtos) dos produtos do Omie; empresa sem
  nenhuma venda no fact_sales conta 0 e aparece em "notes";
- produtos analisados = produtos da leitura com saldo, ou com venda em 12 meses;
- foto do dia (stock_snapshots) = capital e produtos por curva efetiva de 12 meses;
- sem prioridade só quem não tem saldo positivo; estado novo só com produto novo.
Fases 3–5 (quando a execução publicada as tem):
- alertas abertos por tipo e gravidade, resolvidos e com ciência;
- previsão: status, qualidade (das que passaram no teste) e WAPE mediano de 30 dias;
- reposição: status, "comprar" só com previsão aprovada e prazo, recomendação "comprar" = status
  "comprar", custo estimado só com custo conhecido; oportunidades da execução publicada;
- nenhum texto de diagnóstico, recomendação ou alerta com "R$" (valores de custo só nas evidências).
"""
import json
import subprocess
import sys

DB = sys.argv[1] if len(sys.argv) > 1 else 'biomie_v2_hml'
if DB not in ('biomie_v2_hml', 'biomie_v2'):
    raise SystemExit('banco inválido')

SQL = r"""
begin read only;
with co as (select c.id, c.slug from public.companies c where not c.is_demo),
cur as (
  select ic.company_id, ic.run_id, ic.published_at, r.as_of, r.algorithm_version, r.stats
  from private.intel_current ic join private.intel_runs r on r.id = ic.run_id),
m as (
  select x.company_id,
    count(*) as products,
    count(*) filter (where (x.metrics->'stock'->>'qty')::numeric > 0) as with_stock,
    round(coalesce(sum((x.metrics->>'capital')::numeric), 0), 2) as capital,
    round(coalesce(sum((x.metrics->'sales'->'d365'->>'units')::numeric), 0), 3) as units365,
    count(*) filter (where x.priority is not null and coalesce((x.metrics->'stock'->>'qty')::numeric, 0) <= 0) as priority_without_stock,
    count(*) filter (where x.priority is null and (x.metrics->'stock'->>'qty')::numeric > 0) as stock_without_priority,
    count(*) filter (where x.state = 'novo' and not coalesce((x.metrics->>'isNew')::boolean, false)) as novo_not_new,
    count(*) filter (where x.state = 'sem_saldo' and (x.metrics->'stock'->>'qty')::numeric > 0) as sem_saldo_with_stock,
    round(avg(x.priority) filter (where x.priority is not null), 1) as avg_priority,
    max(x.priority) as max_priority
  from private.intel_product_metrics x join cur on cur.run_id = x.run_id and cur.company_id = x.company_id
  group by x.company_id),
st as (
  select t.company_id, jsonb_object_agg(t.state, t.n) as states
  from (select x.company_id, x.state, count(*) as n
        from private.intel_product_metrics x join cur on cur.run_id = x.run_id and cur.company_id = x.company_id
        group by 1, 2) t
  group by t.company_id),
pos as (
  select t.company_id,
    round(coalesce(sum(t.value), 0), 2) as capital,
    coalesce(sum(round(t.value, 2)), 0) as capital_by_product,
    count(*) filter (where t.has_qty) as products_with_qty
  from (select sc.company_id, p.omie_product_id, bool_or(p.physical_qty <> 0) as has_qty,
          sum(p.physical_qty * p.unit_cost) filter (where p.physical_qty > 0 and p.unit_cost > 0) as value
        from private.stock_current sc join private.stock_positions p on p.reading_id = sc.reading_id
        group by 1, 2) t
  group by 1),
sales as (
  select cur.company_id, round(coalesce(sum(f.qty), 0), 3) as units365,
    count(distinct pr.external_id) as products_sold
  from cur
  cross join lateral public.fact_sales(cur.company_id, cur.as_of - 364, cur.as_of) f
  join public.products pr on pr.id = f.product_id and pr.source = 'omie'
  group by cur.company_id),
snap as (
  select s.company_id, s.day, s.totals from private.stock_snapshots s
  join (select company_id, max(day) as day from private.stock_snapshots group by 1) l
    on l.company_id = s.company_id and l.day = s.day),
eff as (
  select pp.company_id, pp.omie_product_id, sum(pp.physical_qty) as qty,
    sum(pp.physical_qty * pp.unit_cost) filter (where pp.physical_qty > 0) as pos_value
  from private.stock_current sc join private.stock_positions pp on pp.reading_id = sc.reading_id
  group by 1, 2),
effc as (
  select eff.*, case when mc.curve is not null then mc.curve when a.curve is not null then a.curve
                     when r.company_id is null then 'U' when eff.qty > 0 then 'D' else 'U' end as curve
  from eff
  left join private.stock_curves mc on mc.company_id = eff.company_id and mc.omie_product_id = eff.omie_product_id
  left join private.stock_auto_curves a on a.company_id = eff.company_id and a.curve_window = '12m'
    and a.omie_product_id = eff.omie_product_id
  left join (select distinct cr.company_id from private.stock_curve_runs cr where cr.status = 'ok') r
    on r.company_id = eff.company_id),
byc as (
  select effc.company_id, jsonb_object_agg(k.curve, jsonb_build_object(
      'products', coalesce(t.products, 0), 'capital', coalesce(t.capital, 0))) as totals
  from (select distinct company_id from effc) effc
  cross join unnest(array['A', 'B', 'C', 'D']) k(curve)
  left join (select company_id, curve, count(*) filter (where qty > 0) as products,
               round(coalesce(sum(pos_value), 0), 2) as capital from effc group by 1, 2) t
    on t.company_id = effc.company_id and t.curve = k.curve
  group by effc.company_id)
select json_agg(json_build_object(
  'company', co.slug,
  'run', json_build_object('asOf', cur.as_of, 'publishedAt', cur.published_at, 'version', cur.algorithm_version),
  'products', m.products, 'withStock', m.with_stock,
  'capitalEngine', m.capital, 'capitalPositionsByProduct', pos.capital_by_product, 'capitalPositions', pos.capital,
  'units365Engine', m.units365, 'units365FactSales', sales.units365,
  'productsSold', sales.products_sold, 'productsWithQty', pos.products_with_qty,
  'priorityWithoutStock', m.priority_without_stock, 'stockWithoutPriority', m.stock_without_priority,
  'novoNotNew', m.novo_not_new, 'semSaldoWithStock', m.sem_saldo_with_stock,
  'states', st.states, 'avgPriority', m.avg_priority, 'maxPriority', m.max_priority,
  'snapshotDay', snap.day,
  'snapshotMatchesCurves', (select bool_and((snap.totals->k.curve->>'capital')::numeric = (byc.totals->k.curve->>'capital')::numeric
                                         and (snap.totals->k.curve->>'products')::integer = (byc.totals->k.curve->>'products')::integer)
                            from unnest(array['A', 'B', 'C', 'D']) k(curve)),
  'snapshot', (select jsonb_object_agg(k.curve, snap.totals->k.curve->'capital') from unnest(array['A', 'B', 'C', 'D']) k(curve)),
  'curvesNow', (select jsonb_object_agg(k.curve, byc.totals->k.curve->'capital') from unnest(array['A', 'B', 'C', 'D']) k(curve)))
  order by co.slug)
from co
left join cur on cur.company_id = co.id
left join m on m.company_id = co.id
left join st on st.company_id = co.id
left join pos on pos.company_id = co.id
left join sales on sales.company_id = co.id
left join snap on snap.company_id = co.id
left join byc on byc.company_id = co.id;
with cur as (select ic.company_id, ic.run_id from private.intel_current ic),
x as (select pm.* from private.intel_product_metrics pm join cur on cur.run_id = pm.run_id and cur.company_id = pm.company_id),
fc as (select x.metrics->'forecast' f from x where x.metrics ? 'forecast'),
rp as (select x.metrics->'replenishment' r, x.metrics from x where x.metrics ? 'replenishment')
select json_build_object(
  'phase3', json_build_object(
    'alertsOpen', (select coalesce(json_object_agg(k, n), '{}') from (select a.kind || ':' || a.severity k, count(*) n
                   from private.intel_alerts a where a.status = 'open' group by 1) t),
    'alertsResolved', (select count(*) from private.intel_alerts where status = 'resolved'),
    'alertsAcknowledged', (select count(*) from private.intel_alerts where acknowledged_at is not null),
    'diagnoses', (select coalesce(json_object_agg(k, n), '{}') from (select d->>'code' k, count(*) n
                  from x cross join jsonb_array_elements(coalesce(x.metrics->'diagnoses', '[]')) d group by 1) t),
    'recommendations', (select coalesce(json_object_agg(k, n), '{}') from (select r->>'type' k, count(*) n
                        from x cross join jsonb_array_elements(coalesce(x.metrics->'recommendations', '[]')) r group by 1) t),
    'textsWithMoney', (select count(*) from x cross join lateral (
        select i from jsonb_array_elements(coalesce(x.metrics->'diagnoses', '[]') || coalesce(x.metrics->'recommendations', '[]')
                                           || coalesce(x.metrics->'alerts', '[]')) i) it
        where concat_ws(' ', it.i->>'text', it.i->>'title', it.i->>'action', it.i->>'why', it.i->>'reason') ~ 'R\$')),
  'phase4', json_build_object(
    'status', (select coalesce(json_object_agg(k, n), '{}') from (select f->>'status' k, count(*) n from fc group by 1) t),
    'quality', (select coalesce(json_object_agg(k, n), '{}') from (select f->'backtest'->>'quality' k, count(*) n
                from fc where f->>'status' = 'ok' group by 1) t),
    'models', (select coalesce(json_object_agg(k, n), '{}') from (select f->>'model' k, count(*) n
               from fc where f->>'status' = 'ok' group by 1) t),
    'medianWape30', (select percentile_cont(0.5) within group (order by (f->'backtest'->>'wape')::numeric)
                     from fc where f->>'status' = 'ok' and f->'backtest'->>'wape' is not null),
    'withInterval', (select count(*) from fc where f->'horizons'->'30' ? 'low')),
  'phase5', json_build_object(
    'status', (select coalesce(json_object_agg(k, n), '{}') from (select r->>'status' k, count(*) n from rp group by 1) t),
    'buyWithoutForecastOrLead', (select count(*) from rp where r->>'status' = 'comprar'
                                 and (metrics->'forecast'->>'status' is distinct from 'ok' or (r->>'leadTimeDays') is null)),
    'buyRecMismatch', (select count(*) from rp where (r->>'status' = 'comprar') <> exists (
                         select 1 from jsonb_array_elements(coalesce(metrics->'recommendations', '[]')) e where e->>'type' = 'comprar')),
    'costEstimateWithoutCost', (select count(*) from rp where r->>'costEstimate' is not null
                                and not coalesce((metrics->'cost'->>'known')::boolean, false)),
    'buyUnits', (select sum((r->>'qty')::numeric) from rp where r->>'status' = 'comprar'),
    'buyCostEstimate', (select sum((r->>'costEstimate')::numeric) from rp where r->>'status' = 'comprar'),
    __PARAMS__,
    'opportunities', (select count(*) from private.intel_opportunities o join private.intel_current a
                        on a.company_id = o.from_company and a.run_id = o.run_id)));
select json_build_object('runs', (select json_agg(json_build_object('status', r.status, 'trigger', r.trigger,
    'started', r.started_at, 'finished', r.finished_at, 'seconds', round(extract(epoch from r.finished_at - r.started_at)),
    'error', r.error, 'stats', r.stats) order by r.started_at desc) from (select * from private.intel_runs
    order by started_at desc limit 3) r),
  'enabled', (select enabled from private.intel_settings where id),
  'snapshots', (select count(*) from private.stock_snapshots),
  'curveHistory', (select count(*) from private.stock_curve_history));
commit;
"""

cmd = ['docker', 'compose', '--env-file', '/opt/biomie-v2/shared/stack.env', '-f', '/opt/biomie-v2/compose.yml',
       'exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', DB, '-At', '-v', 'ON_ERROR_STOP=1']
# Modelo de prazos: o antigo (0048 de 25/10, por empresa/família/produto) ou o de fornecedores (0048/0049).
probe = subprocess.run(cmd, input="select to_regclass('private.stock_lead_times') is not null;",
                       capture_output=True, text=True, timeout=120)
SUPPLIERS = probe.returncode == 0 and probe.stdout.strip().endswith('t')
PARAMS = ("""'leadTimes', (select coalesce(json_object_agg(status, n), '{}') from (select status, count(*) n
                   from private.stock_lead_times group by 1) t),
    'testLeadTimesOn', (select value from private.app_settings where key = 'stock.test_lead_times'),
    'suppliers', (select count(*) from private.stock_suppliers where in_omie),
    'links', (select count(*) from private.stock_product_suppliers),
    'lastSupplierImport', (select json_agg(json_build_object('company', c.slug, 'status', j.status,
        'finished', j.finished_at, 'suppliers', j.suppliers_saved, 'links', j.links_saved, 'error', j.error))
        from (select distinct on (company_id) * from private.stock_supplier_jobs order by company_id, created_at desc) j
        join public.companies c on c.id = j.company_id),
    'buyWithoutSupplier', (select count(*) from rp where r->>'status' = 'comprar' and r->'supplier'->>'id' is null),
    'buyWithTestLeadTime', (select count(*) from rp where r->>'status' = 'comprar' and r->>'leadTimeStatus' = 'teste'),
    'policySource', (select coalesce(json_object_agg(k, n), '{}') from (select r->>'policySource' k, count(*) n
                     from rp where r ? 'policySource' group by 1) t)"""
          if SUPPLIERS else "'params', (select count(*) from private.intel_replenishment_params)")
SQL = SQL.replace('__PARAMS__', PARAMS)
p = subprocess.run(cmd, input=SQL, capture_output=True, text=True, timeout=900)
if p.returncode:
    raise SystemExit(p.stderr[-2000:])
lines = [line for line in p.stdout.splitlines() if line not in ('BEGIN', 'COMMIT')]
companies = json.loads(lines[0])
phases = json.loads(lines[1])
summary = json.loads(lines[2])
notes = []
for c in companies:
    # Sem nenhuma venda em 12 meses o fact_sales não devolve linha (null): equivale a 0 unidades, mas fica anotado.
    c['noSales'] = c['units365FactSales'] is None
    if c['noSales']:
        notes.append(f"{c['company']}: nenhuma venda em 12 meses no fact_sales (conta como 0 unidades)")
    c['ok'] = (c['capitalEngine'] is not None and c['capitalEngine'] == c['capitalPositionsByProduct']
               and c['units365Engine'] is not None and c['units365Engine'] == (c['units365FactSales'] or 0)
               and not c['priorityWithoutStock'] and not c['stockWithoutPriority'] and not c['novoNotNew']
               and not c['semSaldoWithStock'] and bool(c['snapshotMatchesCurves']))
p5 = phases['phase5']
phases_ok = (not phases['phase3']['textsWithMoney'] and not p5['buyWithoutForecastOrLead'] and not p5['buyRecMismatch']
             and not p5['costEstimateWithoutCost'] and not p5.get('buyWithoutSupplier'))
# Prazo de teste nunca na produção.
if DB == 'biomie_v2' and (p5.get('leadTimes') or {}).get('teste'):
    phases_ok = False
print(json.dumps({'db': DB, 'allOk': all(c['ok'] for c in companies) and phases_ok, 'phasesOk': phases_ok,
                  'notes': notes, 'companies': companies, **phases, **summary}, indent=1, ensure_ascii=False,
                 default=str))
