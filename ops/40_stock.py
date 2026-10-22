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
# --db=biomie_v2_test testa os comandos na cópia de teste (22_test_database.py --keep).
DB = next((a.split('=', 1)[1] for a in sys.argv if a.startswith('--db=')), 'biomie_v2')
if DB not in ('biomie_v2', 'biomie_v2_test'):
    raise SystemExit('--db aceita só biomie_v2 ou biomie_v2_test')
sys.argv = [a for a in sys.argv if not a.startswith('--db=')]


def psql(sql, write=False):
    statement = sql if write else 'begin read only; ' + sql + ' commit;'
    p = subprocess.run(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', DB, '-At',
                                  '-v', 'ON_ERROR_STOP=1', '-c', statement],
                       capture_output=True, text=True, timeout=900)
    if p.returncode:
        raise SystemExit('postgres: ' + p.stderr[-800:])
    lines = [line for line in p.stdout.splitlines() if line not in ('BEGIN', 'COMMIT')]
    return json.loads('\n'.join(lines) or 'null')


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
else:
    raise SystemExit(__doc__)
