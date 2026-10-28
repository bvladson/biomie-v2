"""Estoque (migração 0041): situação, leitura, conferência com o Omie e liberação do menu.

    python ops/remote.py ops/40_stock.py status
    python ops/remote.py ops/40_stock.py probe <empresa-slug>     # 1 página do Omie, nada gravado
    python ops/remote.py ops/40_stock.py reading on|off            # leitura agendada pelo worker
    python ops/remote.py ops/40_stock.py refresh <empresa-slug>    # leitura fora da agenda
    python ops/remote.py ops/40_stock.py validate [empresa-slug]   # totais por empresa e local + 20
                                                                   # produtos fixos para conferir no
                                                                   # relatório de posição do Omie
    python ops/remote.py ops/40_stock.py mode off|pilot|on         # menu escondido / só Super admin
                                                                   # / todos com permissão
  Curva automática (migração 0043):
    python ops/remote.py ops/40_stock.py curves [empresa-slug] [--force]   # recalcula agora (o worker
                                                                   # recalcula após cada leitura)
    python ops/remote.py ops/40_stock.py curves-status             # últimos cálculos por empresa
    python ops/remote.py ops/40_stock.py curve-report <empresa-slug> [30d|90d|180d|12m]
                                                                   # conferência: curvas, D aberta,
                                                                   # tempo sem venda, maiores D
    python ops/remote.py ops/40_stock.py movements on|off          # leitura das movimentações
    python ops/remote.py ops/40_stock.py movements-status          # blocos, cobertura e registros
    python ops/remote.py ops/40_stock.py movements-probe <empresa-slug> [dias]
                                                                   # 1 página do Omie, nada gravado
    python ops/remote.py ops/40_stock.py movements-backfill <empresa-slug> [dias]
                                                                   # carga (re)feita em blocos de 31 dias
  Fornecedores e prazos (migração 0048):
    python ops/remote.py ops/40_stock.py suppliers on|off          # importação diária (só leitura do Omie)
    python ops/remote.py ops/40_stock.py suppliers-import          # importação ÚNICA pelo worker (não liga a
                                                                   # diária; o worker lê o Omie no ritmo dele)
    python ops/remote.py ops/40_stock.py suppliers-status          # importações, vínculos e prazos

Ordem da ativação (runbook, seção 12): release com a 0041 -> probe em cada empresa -> reading on
-> validate (bate com o Omie?) -> mode pilot -> teste no navegador -> mode on. Retorno: mode off
(o menu some; dados e curvas ficam) e, se preciso, reading off.
Mudanças de leitura e liberação entram na Auditoria com origem "ops". O resto é só leitura.
"""
import json
import pathlib
import re
import subprocess
import sys

BASE = pathlib.Path('/opt/biomie-v2')
COMPOSE = ['docker', 'compose', '--env-file', str(BASE / 'shared/stack.env'), '-f', str(BASE / 'compose.yml')]
SLUG = re.compile(r'^[a-z0-9][a-z0-9-]{0,62}$')
# --db=biomie_v2_test testa os comandos na cópia de teste (22_test_database.py --keep);
# --db=biomie_v2_hml, na homologação (41_homolog.py).
DB = next((a.split('=', 1)[1] for a in sys.argv if a.startswith('--db=')), 'biomie_v2')
if DB not in ('biomie_v2', 'biomie_v2_test', 'biomie_v2_hml'):
    raise SystemExit('--db aceita só biomie_v2, biomie_v2_test ou biomie_v2_hml')
FORCE = '--force' in sys.argv
sys.argv = [a for a in sys.argv if not a.startswith('--db=') and a != '--force']
WINDOWS = ('30d', '90d', '180d', '12m')


def psql(sql, write=False):
    statement = sql if write else 'begin read only; ' + sql + ' commit;'
    p = subprocess.run(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', DB, '-At',
                                  '-v', 'ON_ERROR_STOP=1', '-c', statement],
                       capture_output=True, text=True, timeout=900)
    if p.returncode:
        raise SystemExit('postgres: ' + p.stderr[-800:])
    lines = [line for line in p.stdout.splitlines() if line not in ('BEGIN', 'COMMIT')]
    return json.loads('\n'.join(lines) or 'null')


def psql_service(sql):
    """Escrita como o worker (service_role): as funções de curva conferem quem chama."""
    claims = '{"role":"service_role"}'
    statement = f"select set_config('request.jwt.claims', '{claims}', true); " + sql
    p = subprocess.run(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', DB, '-At',
                                  '-v', 'ON_ERROR_STOP=1', '-c', statement],
                       capture_output=True, text=True, timeout=1800)
    if p.returncode:
        raise SystemExit('postgres: ' + p.stderr[-800:])
    lines = [line for line in p.stdout.splitlines() if not line.startswith('{"role"')]
    return json.loads('\n'.join(lines) or 'null')


CURVE_REPORT = """
with c as (select id, name from public.companies where slug = '{slug}' and not is_demo),
x as (select r.* from c, stock_internal.current_rows(array[c.id], '{window}') r),
pr as (
  select x.omie_product_id, min(x.sku) as sku, min(x.name) as name, min(x.curve) as curve,
    min(x.curve_source) as source, sum(x.physical_qty) as qty, round(sum(x.physical_qty * x.unit_cost), 2) as value,
    min(x.window_revenue) as revenue, min(x.window_share) as share, min(x.last_sale) as last_sale,
    min(x.days_without_sale) as days, min(x.last_entry) as last_entry, min(x.last_entry_operation) as last_op,
    min(x.registered_at) as registered, min(x.arrived_on) as arrived, bool_or(x.is_new) as is_new,
    min(x.incomplete_reason) as incomplete, min(x.elsewhere_company) as elsewhere,
    min(x.elsewhere_last_sale) as elsewhere_sale, min(x.curves_as_of) as as_of, min(x.sales_from) as sales_from,
    min(x.window_start) as window_start, count(*) as locations, min(x.idle_since) as idle_since,
    min(x.last_exit) as last_exit, min(x.last_exit_operation) as last_exit_op, bool_or(x.recent_exit) as moving,
    bool_or(x.last_exit_group) as exit_group
  from x group by x.omie_product_id),
run as (select r.* from c, private.stock_curve_runs r where r.company_id = c.id order by r.finished_at desc limit 5)
select json_build_object(
  'company', '{slug}', 'name', (select name from c), 'window', '{window}',
  'asOf', (select min(as_of) from pr), 'salesFrom', (select min(sales_from) from pr),
  'windowStart', (select min(window_start) from pr),
  'runs', (select json_agg(json_build_object('status', run.status, 'asOf', run.as_of, 'reason', run.reason,
      'finished', run.finished_at, 'totals', run.totals -> '{window}')) from run),
  'movementsFrom', (select stock_internal.movements_from(c.id) from c),
  'byCurve', (select json_object_agg(k.curve, json_build_object(
      'products', (select count(*) from pr where pr.curve = k.curve),
      'productsWithStock', (select count(*) from pr where pr.curve = k.curve and pr.qty > 0),
      'value', (select coalesce(round(sum(pr.value) filter (where pr.qty > 0), 2), 0) from pr where pr.curve = k.curve),
      'revenue', (select coalesce(round(sum(pr.revenue), 2), 0) from pr where pr.curve = k.curve)))
    from unnest(array['A', 'B', 'C', 'D', 'U']) k(curve)),
  'manual', (select count(*) from pr where pr.source = 'manual'),
  'dOpen', (select json_build_object(
      'products', count(*), 'value', round(sum(pr.value), 2),
      'new', count(*) filter (where pr.is_new),
      'newValue', round(coalesce(sum(pr.value) filter (where pr.is_new), 0), 2),
      'incomplete', count(*) filter (where not pr.is_new and pr.incomplete is not null),
      'incompleteValue', round(coalesce(sum(pr.value) filter (where not pr.is_new and pr.incomplete is not null), 0), 2),
      'confirmed', count(*) filter (where not pr.is_new and pr.incomplete is null),
      'confirmedValue', round(coalesce(sum(pr.value) filter (where not pr.is_new and pr.incomplete is null), 0), 2),
      'elsewhere', count(*) filter (where pr.elsewhere is not null),
      'elsewhereValue', round(coalesce(sum(pr.value) filter (where pr.elsewhere is not null), 0), 2),
      'withEntry', count(*) filter (where pr.last_entry is not null),
      'moving', count(*) filter (where pr.moving),
      'movingToGroup', count(*) filter (where pr.moving and pr.exit_group),
      'movingValue', round(coalesce(sum(pr.value) filter (where pr.moving), 0), 2),
      'entryLast90d', count(*) filter (where pr.last_entry >= pr.as_of - 90))
    from pr where pr.curve = 'D' and pr.qty > 0),
  'aging', (select json_object_agg(b.band, json_build_object('products', b.n, 'value', b.v)) from (
      select case when pr.days >= 365 then '365' when pr.days >= 180 then '180'
                  when pr.days >= 90 then '90' when pr.days >= 30 then '30'
                  else 'recente' end as band, count(*) as n, round(sum(pr.value), 2) as v
      from pr where pr.qty > 0 and pr.as_of is not null and pr.days is not null group by 1) b),
  'topD', (select json_agg(json_build_object('sku', t.sku, 'name', t.name, 'qty', t.qty, 'value', t.value,
      'lastSale', t.last_sale, 'idleSince', t.idle_since, 'idleDays', t.days, 'lastEntry', t.last_entry,
      'lastEntryOp', t.last_op, 'lastExit', t.last_exit, 'lastExitOp', t.last_exit_op, 'exitToGroup', t.exit_group, 'registered', t.registered,
      'arrived', t.arrived, 'new', t.is_new, 'incomplete', t.incomplete, 'elsewhere', t.elsewhere,
      'elsewhereSale', t.elsewhere_sale, 'locations', t.locations) order by t.value desc)
    from (select * from pr where pr.curve = 'D' and pr.qty > 0 order by pr.value desc limit 15) t),
  'topA', (select json_agg(json_build_object('sku', t.sku, 'name', t.name, 'revenue', t.revenue,
      'share', round(t.share * 100, 2), 'qty', t.qty, 'value', t.value, 'lastSale', t.last_sale)
      order by t.revenue desc)
    from (select * from pr where pr.curve = 'A' order by pr.revenue desc limit 10) t));"""


def curve_report(slug, window):
    return psql(CURVE_REPORT.replace('{slug}', slug).replace('{window}', window))


def slug_arg(position=2, required=True):
    value = sys.argv[position] if len(sys.argv) > position else None
    if value is None and not required:
        return None
    if not value or not SLUG.match(value):
        raise SystemExit('informe o slug da empresa (letras minúsculas, números e hífen)')
    return value


def status():
    return psql("""
select json_build_object(
  'mode', (select f.mode from private.feature_flags f where f.key = 'stock'),
  'settings', (select json_build_object('readingEnabled', s.reading_enabled, 'slots', s.slots,
      'closeSlot', s.close_slot, 'manualMinMinutes', s.manual_min_minutes, 'staleHours', s.stale_hours)
    from private.stock_settings s),
  'companies', (select coalesce(json_agg(x order by x.name), '[]') from (
    select c.slug, c.name, ci.status as integration,
      (select json_build_object('finished', r.finished_at, 'positions', r.records_received, 'kind', r.kind,
          'positionDate', r.position_date)
       from private.stock_current sc join private.stock_readings r on r.id = sc.reading_id
       where sc.company_id = c.id) as current,
      (select coalesce(json_agg(json_build_object('created', q.created_at, 'status', q.status, 'trigger', q.trigger,
          'kind', q.kind, 'pages', q.pages_done || '/' || coalesce(q.pages_total::text, '?'),
          'attempts', q.attempts, 'error', q.error) order by q.created_at desc), '[]')
       from (select * from private.stock_readings q2 where q2.company_id = c.id
             order by q2.created_at desc limit 3) q) as recent
    from public.companies c
    left join public.company_integrations ci on ci.company_id = c.id and ci.provider = 'omie'
    where not c.is_demo) x));""")


def validate(slug):
    where = f"c.slug = '{slug}'" if slug else 'true'
    return psql(f"""
with c as (select id, slug, name from public.companies c where not c.is_demo and {where}),
cur as (
  select c.slug, c.name, r.id as reading, r.finished_at, r.position_date, r.locations
  from c join private.stock_current sc on sc.company_id = c.id
  join private.stock_readings r on r.id = sc.reading_id),
p as (select cur.slug, sp.* from cur join private.stock_positions sp on sp.reading_id = cur.reading)
select coalesce(json_agg(json_build_object(
  'company', cur.slug, 'name', cur.name, 'positionDate', cur.position_date, 'readAt', cur.finished_at,
  'totals', (select json_build_object('positions', count(*),
      'withStock', count(*) filter (where p.physical_qty <> 0 or p.reserved_qty <> 0 or p.pending_qty <> 0),
      'units', sum(p.physical_qty), 'costValue', round(sum(p.physical_qty * p.unit_cost), 2),
      'negative', count(*) filter (where p.physical_qty < 0),
      'reserved', sum(p.reserved_qty), 'pending', sum(p.pending_qty))
    from p where p.slug = cur.slug),
  'byLocation', (select json_agg(json_build_object('code', l.location_code,
      'name', cur.locations -> l.location_code ->> 'name', 'positions', l.n, 'units', l.u, 'costValue', l.v)
      order by l.location_code)
    from (select p.location_code, count(*) as n, sum(p.physical_qty) as u,
            round(sum(p.physical_qty * p.unit_cost), 2) as v
          from p where p.slug = cur.slug group by p.location_code) l),
  'sample', (select json_agg(json_build_object('sku', s.sku, 'name', s.name, 'location', s.location_code,
      'physical', s.physical_qty, 'cmc', s.unit_cost, 'reserved', s.reserved_qty, 'pending', s.pending_qty)
      order by s.sku)
    from (select * from p where p.slug = cur.slug and p.physical_qty <> 0
          order by md5(p.omie_product_id || ':' || p.location_code) limit 20) s)
) order by cur.slug), '[]') from cur;""")


command = sys.argv[1] if len(sys.argv) > 1 else 'status'
if command == 'status':
    print(json.dumps(status(), indent=1, ensure_ascii=False, default=str))
elif command == 'probe':
    slug = slug_arg()
    p = subprocess.run(COMPOSE + ['exec', '-T', 'worker', 'node', '.output/stock-probe.mjs', slug],
                       capture_output=True, text=True, timeout=300)
    print(p.stdout[-20000:])
    if p.returncode:
        raise SystemExit('probe: ' + p.stderr[-800:])
elif command == 'reading':
    value = sys.argv[2] if len(sys.argv) > 2 else ''
    if value not in ('on', 'off'):
        raise SystemExit('uso: reading on|off')
    enabled = 'true' if value == 'on' else 'false'
    print(json.dumps(psql(f"""
with u as (update private.stock_settings set reading_enabled = {enabled}, updated_at = now(), updated_by = null
           returning reading_enabled),
a as (insert into public.audit_log (actor_id, action, entity, entity_id, payload)
      select null, 'stock.reading.toggled', 'stock', null,
             jsonb_build_object('ligada', u.reading_enabled, 'origem', 'ops') from u)
select json_build_object('readingEnabled', (select reading_enabled from u));""", write=True), indent=1))
elif command == 'refresh':
    slug = slug_arg()
    print(json.dumps(psql(f"""
with c as (select id from public.companies where slug = '{slug}' and not is_demo),
busy as (select 1 from private.stock_readings r join c on r.company_id = c.id
         where r.status in ('queued', 'running')),
ins as (insert into private.stock_readings (company_id, kind, trigger, status, position_date)
        select c.id, 'intraday', 'manual', 'queued', (now() at time zone 'America/Fortaleza')::date from c
        where not exists (select 1 from busy) and (select s.reading_enabled from private.stock_settings s)
        returning id),
a as (insert into public.audit_log (actor_id, action, entity, entity_id, payload)
      select null, 'stock.refresh.requested', 'stock', c.id::text,
             jsonb_build_object('companyId', c.id, 'origem', 'ops') from c where exists (select 1 from ins))
select json_build_object('company', '{slug}', 'found', exists (select 1 from c),
  'queued', (select count(*) from ins), 'alreadyInQueue', exists (select 1 from busy),
  'readingEnabled', (select s.reading_enabled from private.stock_settings s));""", write=True), indent=1))
elif command == 'validate':
    print(json.dumps(validate(slug_arg(required=False)), indent=1, ensure_ascii=False, default=str))
elif command == 'mode':
    mode = sys.argv[2] if len(sys.argv) > 2 else ''
    if mode not in ('off', 'pilot', 'on'):
        raise SystemExit('uso: mode off|pilot|on')
    print(json.dumps(psql(f"""
with before as (select f.mode from private.feature_flags f where f.key = 'stock'),
u as (update private.feature_flags set mode = '{mode}', updated_at = now(), updated_by = null
      where key = 'stock' returning mode),
a as (insert into public.audit_log (actor_id, action, entity, entity_id, payload)
      select null, 'stock.module.mode', 'stock', null,
             jsonb_build_object('antes', (select mode from before), 'depois', u.mode, 'origem', 'ops') from u)
select json_build_object('mode', (select mode from u), 'before', (select mode from before));""", write=True),
                     indent=1))
elif command == 'curves':
    slug = slug_arg(required=False)
    where = f"and c.slug = '{slug}'" if slug else ''
    force = 'true' if FORCE else 'false'
    print(json.dumps(psql_service(f"""
select coalesce(json_agg(json_build_object('company', c.slug,
    'result', stock_internal.refresh_curves(c.id, 'ops', {force})) order by c.name), '[]')
from public.companies c
where not c.is_demo {where}
  and exists (select 1 from public.company_integrations ci where ci.company_id = c.id and ci.provider = 'omie');"""),
        indent=1, ensure_ascii=False, default=str))
elif command == 'curves-status':
    print(json.dumps(psql("""
select coalesce(json_agg(json_build_object('company', c.slug,
  'runs', (select json_agg(json_build_object('status', r.status, 'trigger', r.trigger, 'asOf', r.as_of,
      'salesFrom', r.sales_from, 'reason', r.reason, 'finished', r.finished_at,
      'revenue12m', r.totals -> '12m' -> 'revenue') order by r.finished_at desc)
    from (select * from private.stock_curve_runs r2 where r2.company_id = c.id order by r2.finished_at desc limit 3) r),
  'autoCurves', (select count(*) from private.stock_auto_curves a where a.company_id = c.id),
  'manualCurves', (select count(*) from private.stock_curves m where m.company_id = c.id)) order by c.name), '[]')
from public.companies c where not c.is_demo;"""), indent=1, ensure_ascii=False, default=str))
elif command == 'curve-report':
    slug = slug_arg()
    window = sys.argv[3] if len(sys.argv) > 3 else '12m'
    if window not in WINDOWS:
        raise SystemExit('janela: 30d, 90d, 180d ou 12m')
    print(json.dumps(curve_report(slug, window), indent=1, ensure_ascii=False, default=str))
elif command == 'movements':
    value = sys.argv[2] if len(sys.argv) > 2 else ''
    if value not in ('on', 'off'):
        raise SystemExit('uso: movements on|off')
    enabled = 'true' if value == 'on' else 'false'
    print(json.dumps(psql(f"""
with u as (update private.stock_settings set movements_enabled = {enabled}, updated_at = now(), updated_by = null
           returning movements_enabled),
a as (insert into public.audit_log (actor_id, action, entity, entity_id, payload)
      select null, 'stock.movements.toggled', 'stock', null,
             jsonb_build_object('ligada', u.movements_enabled, 'origem', 'ops') from u)
select json_build_object('movementsEnabled', (select movements_enabled from u));""", write=True), indent=1))
elif command == 'suppliers':
    if len(sys.argv) < 3 or sys.argv[2] not in ('on', 'off'):
        raise SystemExit('uso: suppliers on|off')
    enabled = 'true' if sys.argv[2] == 'on' else 'false'
    print(json.dumps(psql(f"""
with u as (update private.stock_settings set suppliers_enabled = {enabled}, updated_at = now(), updated_by = null
           returning suppliers_enabled),
l as (insert into public.audit_log (actor_id, action, entity, entity_id, payload)
      select null, 'stock.suppliers.toggled', 'stock', null,
             jsonb_build_object('ligada', u.suppliers_enabled, 'origem', 'ops') from u)
select json_build_object('suppliersEnabled', (select suppliers_enabled from u));""", write=True), indent=1))
elif command == 'suppliers-import':
    # Pede uma importação para cada empresa conectada; o worker a faz entre as leituras e movimentações,
    # com o limitador de sempre. A importação diária continua como estiver (suppliers on|off).
    print(json.dumps(psql_service("select json_build_object('queued', "
                                  "public.stock_worker_suppliers_enqueue(null, 'ops'));"), indent=1))
elif command == 'suppliers-status':
    print(json.dumps(psql("""select json_build_object(
  'enabled', (select s.suppliers_enabled from private.stock_settings s),
  'testLeadTimesOn', (select value from private.app_settings where key = 'stock.test_lead_times'),
  'companies', (select json_agg(json_build_object('company', c.slug,
      'suppliers', (select count(*) from private.stock_suppliers s where s.company_id = c.id and s.in_omie),
      'links', (select count(*) from private.stock_product_suppliers l where l.company_id = c.id),
      'leadTimes', (select json_object_agg(t.status, t.n) from (select status, count(*) n from private.stock_lead_times
                    where company_id = c.id group by 1) t),
      'lastJob', (select json_build_object('status', j.status, 'trigger', j.trigger, 'created', j.created_at,
                    'finished', j.finished_at, 'error', j.error) from private.stock_supplier_jobs j
                  where j.company_id = c.id order by j.created_at desc limit 1)) order by c.slug)
    from public.companies c where not c.is_demo));"""), indent=1))
elif command == 'movements-status':
    print(json.dumps(psql("""
select json_build_object(
  'enabled', (select s.movements_enabled from private.stock_settings s),
  'companies', (select coalesce(json_agg(json_build_object('company', c.slug,
      'jobs', (select json_object_agg(j.status, j.n) from (select status, count(*) as n
               from private.stock_movement_jobs where company_id = c.id group by 1) j),
      'coveredFrom', stock_internal.movements_from(c.id),
      'coveredTo', (select max(period_to) from private.stock_movement_jobs
                    where company_id = c.id and status = 'complete'),
      'movements', (select count(*) from private.stock_movements m where m.company_id = c.id),
      'skipped', (select coalesce(sum(records_skipped), 0) from private.stock_movement_jobs where company_id = c.id),
      'lastError', (select error from private.stock_movement_jobs where company_id = c.id and error is not null
                    order by coalesce(finished_at, created_at) desc limit 1)) order by c.name), '[]')
    from public.companies c where not c.is_demo));"""), indent=1, ensure_ascii=False, default=str))
elif command == 'movements-backfill':
    slug = slug_arg()
    days = sys.argv[3] if len(sys.argv) > 3 else '365'
    if not days.isdigit() or not 30 <= int(days) <= 730:
        raise SystemExit('dias: de 30 a 730')
    print(json.dumps(psql(f"""
with c as (select id from public.companies where slug = '{slug}' and not is_demo),
s as (select movements_chunk_days as chunk from private.stock_settings),
busy as (select 1 from private.stock_movement_jobs j join c on j.company_id = c.id
         where j.status in ('queued', 'running')),
y as (select (now() at time zone 'America/Fortaleza')::date - 1 as yesterday),
ins as (insert into private.stock_movement_jobs (company_id, trigger, period_from, period_to)
        select c.id, 'backfill', g::date, least(g::date + s.chunk - 1, y.yesterday)
        from c, s, y, generate_series(y.yesterday - {days} + 1, y.yesterday, make_interval(days => s.chunk)) g
        where not exists (select 1 from busy)
        returning id),
a as (insert into public.audit_log (actor_id, action, entity, entity_id, payload)
      select null, 'stock.movements.backfill', 'stock', c.id::text,
             jsonb_build_object('dias', {days}, 'blocos', (select count(*) from ins), 'origem', 'ops')
      from c where exists (select 1 from ins))
select json_build_object('company', '{slug}', 'found', exists (select 1 from c),
  'chunks', (select count(*) from ins), 'alreadyInQueue', exists (select 1 from busy));""", write=True),
        indent=1))
elif command == 'movements-probe':
    slug = slug_arg()
    days = sys.argv[3] if len(sys.argv) > 3 else '30'
    if not days.isdigit():
        raise SystemExit('dias: número inteiro')
    p = subprocess.run(COMPOSE + ['exec', '-T', 'worker', 'node', '.output/stock-movements-probe.mjs', slug, days],
                       capture_output=True, text=True, timeout=300)
    print(p.stdout[-20000:])
    if p.returncode:
        raise SystemExit('probe: ' + p.stderr[-800:])
else:
    raise SystemExit(__doc__)
