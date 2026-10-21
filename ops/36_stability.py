"""Post-release stability check (read-only): syncs, integrity, performance, logs and containers.

    python ops/remote.py ops/36_stability.py [--since 2026-10-21T10:50Z]     (default: last 24 h)

Prints aggregates only (no request parameters, tokens or personal data) and one verdict per area.
The document-by-document revenue check of the month stays in `ops/26_reconcile.py <YYYY-MM> <YYYY-MM>`.
Smoke tests (29_smoke.py) generate load and client aborts on purpose; read their windows accordingly.
"""
import collections
import datetime as dt
import json
import re
import subprocess
import sys

BASE = '/opt/biomie-v2'
COMPOSE = ['docker', 'compose', '--env-file', f'{BASE}/shared/stack.env', '-f', f'{BASE}/compose.yml']
NOW = dt.datetime.now(dt.timezone.utc)
SINCE = NOW - dt.timedelta(hours=24)
if '--since' in sys.argv:
    SINCE = dt.datetime.fromisoformat(sys.argv[sys.argv.index('--since') + 1].replace('Z', '+00:00'))
SINCE_ISO = SINCE.strftime('%Y-%m-%dT%H:%M:%SZ')
S = f"'{SINCE_ISO}'::timestamptz"
LOCAL = "at time zone 'America/Fortaleza'"


def sql(query):
    p = subprocess.run(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', 'biomie_v2', '-At',
                                  '-v', 'ON_ERROR_STOP=1'], input=query, capture_output=True, text=True, timeout=300)
    if p.returncode:
        raise SystemExit('psql failed: ' + p.stderr[-500:])
    return p.stdout.strip()  # json_agg output spans lines; json.loads takes it whole


def logs(container):
    p = subprocess.run(['docker', 'logs', '--timestamps', '--since', SINCE_ISO, container], capture_output=True,
                       text=True, errors='replace')
    return (p.stdout + p.stderr).splitlines()


def seconds(values, q):
    values = sorted(values)
    return round(values[min(len(values) - 1, int(q * len(values)))] / 1000, 1) if values else None


report = {'since_utc': SINCE_ISO, 'now_utc': NOW.strftime('%Y-%m-%dT%H:%M:%SZ')}
attention = collections.defaultdict(list)

# 1. Omie syncs: queue, runs, failures, entities without a recent successful run.
sync = json.loads(sql(f"""select json_build_object(
 'jobs', (select coalesce(json_object_agg(status, n), '{{}}') from (select status, count(*) n
          from public.integration_backfill_jobs where created_at >= {S} group by 1) x),
 'open_jobs_now', (select count(*) from public.integration_backfill_jobs where status in ('PENDING', 'RUNNING')),
 'oldest_open_job_min', (select round(extract(epoch from now() - min(created_at)) / 60)
          from public.integration_backfill_jobs where status in ('PENDING', 'RUNNING')),
 'runs', (select coalesce(json_object_agg(status, n), '{{}}') from (select r.status, count(*) n
          from public.integration_sync_runs r join public.companies c on c.id = r.company_id
          where not c.is_demo and r.started_at >= {S} group by 1) x),
 'failed_runs', (select coalesce(json_agg(x), '[]') from (select c.slug, r.entity,
          to_char(r.started_at {LOCAL}, 'DD/MM HH24:MI') at, left(coalesce(r.message, ''), 120) msg
          from public.integration_sync_runs r join public.companies c on c.id = r.company_id
          where not c.is_demo and r.started_at >= {S} and r.status not in ('SUCCESS', 'WARNING', 'RUNNING')
          order by r.started_at) x),
 'warning_runs', (select coalesce(json_agg(x), '[]') from (select c.slug, r.entity, count(*) n,
          max(left(coalesce(r.message, ''), 100)) msg
          from public.integration_sync_runs r join public.companies c on c.id = r.company_id
          where not c.is_demo and r.started_at >= {S} and r.status = 'WARNING' group by 1, 2) x),
 'without_recent_success', (select coalesce(json_agg(x), '[]') from (select c.slug, e.entity,
          to_char(max(r.finished_at) {LOCAL}, 'DD/MM HH24:MI') last_success
          from public.companies c
          cross join (values ('invoices'), ('orders'), ('receivables'), ('settlements'),
                             ('customers'), ('products'), ('vendors')) e(entity)
          left join public.integration_sync_runs r on r.company_id = c.id and r.entity = e.entity
               and r.status in ('SUCCESS', 'WARNING')
          where not c.is_demo group by 1, 2
          having max(r.finished_at) is null or max(r.finished_at) < now() - case
               when e.entity in ('customers', 'products', 'vendors') then interval '26 hours'
               else interval '2 hours' end) x))"""))
report['sync'] = sync
if sync['failed_runs']:
    attention['sync'].append(f"{len(sync['failed_runs'])} execução(ões) com falha")
if sync['without_recent_success']:
    attention['sync'].append('sem sucesso recente: ' + ', '.join(f"{x['slug']}:{x['entity']}"
                                                                for x in sync['without_recent_success']))
if sync['open_jobs_now'] and (sync['oldest_open_job_min'] or 0) > 90:
    attention['sync'].append(f"fila parada: job aberto há {sync['oldest_open_job_min']} min")

# 2. Integrity Center: readiness per entity and divergences opened in the window.
readiness = json.loads(sql("""\\o /dev/null
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
\\o
select coalesce(json_agg(json_build_object('slug', c.slug, 'entity', x->>'entity', 'state', x->>'state',
       'issues', (x->>'openIssues')::int, 'stale', (x->>'stale')::boolean, 'contract', (x->>'contractValid')::boolean,
       'reload', (x->>'backfillPending')::boolean)), '[]')
from public.companies c cross join lateral jsonb_array_elements(public.omie_readiness(c.id)::jsonb) x
where not c.is_demo;"""))
integrity = json.loads(sql(f"""select json_build_object(
 'open', (select count(*) from public.integrity_issues i join public.companies c on c.id = i.company_id
          where not c.is_demo and i.status = 'OPEN'),
 'open_by_type', (select coalesce(json_object_agg(k, n), '{{}}') from (select i.severity || ' ' || i.check_key k,
          count(*) n from public.integrity_issues i join public.companies c on c.id = i.company_id
          where not c.is_demo and i.status = 'OPEN' group by 1) x),
 'opened_in_window', (select coalesce(json_agg(x), '[]') from (select c.slug, i.entity, i.severity, i.check_key,
          i.external_id, i.status, left(i.reason, 100) reason
          from public.integrity_issues i join public.companies c on c.id = i.company_id
          where not c.is_demo and i.first_seen_at >= {S} order by i.first_seen_at) x))"""))
report['integrity'] = {
    'states': dict(collections.Counter(r['state'] for r in readiness)),
    'not_ready': [f"{r['slug']}:{r['entity']} {r['state']} divergências={r['issues']}"
                  + (' EM-RECARGA' if r['reload'] else '') + (' DESATUALIZADO' if r['stale'] else '')
                  + ('' if r['contract'] else ' CONTRATO-INVÁLIDO')
                  for r in readiness if r['state'] != 'READY'],
    **integrity}
# Not ready is explained by a queued/running reload (the daily 60-day replay) or by open divergences awaiting a
# decision (which also invalidate the contract); anything else needs a look.
unexplained = [r for r in readiness if r['state'] != 'READY' and not r['reload'] and not r['issues']]
if unexplained:
    attention['integridade'].append('não-prontos sem divergência que explique: '
                                    + ', '.join(f"{r['slug']}:{r['entity']}" for r in unexplained))
new_open = [x for x in integrity['opened_in_window'] if x['status'] == 'OPEN']
if new_open:
    attention['integridade'].append(f'{len(new_open)} divergência(s) nova(s) aberta(s) na janela')

# 3. Gold revenue month to date (to follow the numbers between checks).
report['revenue_month_to_date'] = json.loads(sql("""select coalesce(json_agg(x), '[]') from (select c.slug,
  count(distinct f.invoice_id) nfs, round(sum(f.amount), 2) revenue
  from public.companies c cross join lateral public.fact_sales(c.id, date_trunc('month', current_date)::date, current_date) f
  where not c.is_demo group by 1 order by 1) x"""))

# 4. Performance: statements over log_min_duration_statement (1 s) and statement timeouts.
slow = collections.defaultdict(list)
for line in logs('biomie-v2-db-1'):
    m = re.search(r'(\d{4}-\d\d-\d\d \d\d:\d\d):\d\d\.\d+ UTC \[\d+\] LOG:  duration: ([\d.]+) ms', line)
    if m:
        fn = re.search(r'"public"\."([a-z0-9_]+)"\(', line)
        slow[fn.group(1) if fn else 'sql-direto'].append((m.group(1), float(m.group(2))))
everything = [ms for calls in slow.values() for _, ms in calls]
web = logs('biomie-v2-web-1')
codes = collections.Counter()
for i, line in enumerate(web):
    if ' failed {' in line:
        code = re.search(r"code: '([0-9A-Z]+)'", ' '.join(web[i:i + 6]))
        codes[code.group(1) if code else '?'] += 1
report['performance'] = {
    'slow_statements': len(everything), 'over_5s': sum(ms >= 5000 for ms in everything),
    'over_15s': sum(ms >= 15000 for ms in everything), 'p50_s': seconds(everything, .5),
    'p95_s': seconds(everything, .95), 'max_s': seconds(everything, 1),
    'by_function': sorted(({'fn': fn, 'n': len(c), 'p50_s': seconds([ms for _, ms in c], .5),
                            'max_s': seconds([ms for _, ms in c], 1), 'worst_utc': max(c, key=lambda x: x[1])[0][5:]}
                           for fn, c in slow.items()), key=lambda r: -r['max_s'])[:8],
    'query_failures_by_code': dict(codes)}
if codes.get('57014'):
    attention['desempenho'].append(f"{codes['57014']} consulta(s) cancelada(s) por tempo (57014)")
if report['performance']['over_15s']:
    attention['desempenho'].append(f"{report['performance']['over_15s']} consulta(s) acima de 15 s")

# 5. Logs, worker and containers.
names = subprocess.run(['docker', 'ps', '-a', '--filter', 'name=biomie-v2-', '--format', '{{.Names}}'],
                       capture_output=True, text=True).stdout.split()
containers = []
for name in names:
    out = subprocess.run(['docker', 'inspect', '--format',
                          '{{.RestartCount}}|{{.State.OOMKilled}}|{{.State.StartedAt}}|{{.State.Status}}|'
                          '{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.Config.Image}}', name],
                         capture_output=True, text=True).stdout.strip().split('|')
    started = dt.datetime.fromisoformat(out[2][:19] + '+00:00')
    containers.append({'name': name, 'restarts': int(out[0]), 'oom': out[1] == 'true', 'status': out[3],
                       'health': out[4], 'image': out[5], 'started_in_window': started >= SINCE})
report['containers'] = containers
for c in containers:
    if c['status'] == 'running' and (c['restarts'] or c['oom'] or c['health'] == 'unhealthy'):
        attention['logs'].append(f"{c['name']}: reinícios={c['restarts']} oom={c['oom']} saúde={c['health']}")
worker = logs('biomie-v2-worker-1')
worker_errors = [l[31:200] for l in worker if re.search(r'error|failed|exception|unhandled', l, re.I)
                 and 'omie retry' not in l and 'omie tx sync failed' not in l]
omie_blocks = sum('bloqueado temporariamente' in l for l in worker)
web_lines = [l[31:] for l in web if re.search(r'error|failed', l, re.I) and not l[31:].startswith('    at ')]
web_kinds = collections.Counter('cliente cancelou (AbortError)' if 'AbortError' in l else
                                'consulta falhou (ver códigos)' if ' failed {' in l else l[:80] for l in web_lines)
report['logs'] = {'worker_lines': len(worker), 'worker_errors': worker_errors[:5], 'worker_error_count': len(worker_errors),
                  'omie_temporary_blocks': omie_blocks,
                  'omie_attempt_failures': sum('omie tx sync failed' in l for l in worker),
                  'worker_states': dict(collections.Counter(re.findall(r'"state":"([A-Z_]+)"', '\n'.join(worker)))),
                  'web_error_lines': dict(web_kinds.most_common(6))}
if worker_errors:
    attention['logs'].append(f'{len(worker_errors)} erro(s) no worker')
odd_web = {k: n for k, n in web_kinds.items() if not k.startswith(('cliente cancelou', 'consulta falhou'))}
if odd_web:
    attention['logs'].append(f'{sum(odd_web.values())} linha(s) de erro inesperadas no web')

health = json.load(open(f'{BASE}/ops/health.json'))
warn = [l.strip()[:120] for l in open('/var/log/biomie-v2-health.log', errors='replace')
        if l[:19] >= SINCE.strftime('%Y-%m-%dT%H:%M:%S') and 'WARN' in l]
report['health'] = {'warn_lines': warn[-10:], 'warn_count': len(warn), 'host': health.get('host'),
                    'backup': health.get('backup'), 'public_api': health.get('public_api')}
if warn:
    attention['logs'].append(f'{len(warn)} alerta(s) WARN do monitor de saúde')
backup = health.get('backup') or {}
if (backup.get('last_backup_h') or 99) > 26 or (backup.get('last_offsite_h') or 99) > 26:
    attention['logs'].append(f"backup atrasado: {backup}")

since_local = SINCE.astimezone().replace(tzinfo=None)
public = collections.Counter()
server_errors = collections.Counter()
for line in open('/var/log/nginx/biomie-v2-access.log', errors='replace'):
    m = re.search(r'\[(\d\d/\w{3}/\d{4}):(\d\d:\d\d:\d\d) [^\]]+\] "([A-Z]+) (\S+)[^"]*" (\d{3})', line)
    if not m or dt.datetime.strptime(f'{m.group(1)} {m.group(2)}', '%d/%b/%Y %H:%M:%S') < since_local:
        continue
    public[m.group(5)[0] + 'xx'] += 1
    if m.group(5).startswith('5'):
        server_errors[f"{m.group(5)} {m.group(3)} {m.group(4).split('?')[0][:60]}"] += 1
report['public_http'] = {'by_class': dict(public), 'server_errors': dict(server_errors.most_common(5))}
if server_errors:
    attention['logs'].append(f"{sum(server_errors.values())} resposta(s) 5xx no site público")

report['verdict'] = {area: ('ATENÇÃO: ' + '; '.join(attention[area])) if attention[area] else 'OK'
                     for area in ('sync', 'integridade', 'desempenho', 'logs')}
print(json.dumps(report, indent=1, ensure_ascii=False, default=str))
