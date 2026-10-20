"""Controlled Omie load through the worker.

    python ops/remote.py ops/25_load.py tune KEY=VALUE [...]      set worker tuning and recreate the worker
    python ops/remote.py ops/25_load.py enqueue <from> <to> <phase> phase: dimensions|facts|finance|receivables
    python ops/remote.py ops/25_load.py pause|resume [reason]
    python ops/remote.py ops/25_load.py recurring on|off               recurring loads (fixed slots, see runbook)
    python ops/remote.py ops/25_load.py status

facts = invoices + orders; finance = receivables + settlements (needs facts done);
receivables = only receivables (also loads titles issued with future dates).
Only companies proven CONNECTED are enqueued.
"""
import json
import os
import pathlib
import subprocess
import sys

BASE = pathlib.Path('/opt/biomie-v2')
ENV = BASE / 'shared' / 'stack.env'
COMPOSE = ['docker', 'compose', '--env-file', str(ENV), '-f', str(BASE / 'compose.yml')]
release = dict(l.split('=', 1) for l in ENV.read_text().splitlines() if '=' in l)['SOURCE_DIR']


def run(cmd, timeout=600, input=None):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, input=input,
                       env={**os.environ, 'BIOMIE_V2_BASE': str(BASE)})
    if p.returncode:
        raise SystemExit(' '.join(cmd[:6]) + ' failed: ' + (p.stderr or p.stdout)[-800:])
    return p.stdout.strip()


def ctl(*args):
    return run(COMPOSE + ['exec', '-T', 'web', 'node', '.output/worker-ctl.mjs', *args])


def sql(query):
    return run(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', 'biomie_v2', '-At',
                          '-v', 'ON_ERROR_STOP=1', '-c', query])


command = sys.argv[1]
if command == 'tune':
    print(run(['python3', f'{release}/deploy/vps/stackctl.py', 'set', *sys.argv[2:]]))
    run(COMPOSE + ['up', '-d', '--no-build', '--no-deps', 'worker'])
    print(run(['docker', 'inspect', '--format', '{{.State.Status}}', 'biomie-v2-worker-1']))
elif command == 'enqueue':
    start, end, phase = sys.argv[2], sys.argv[3], sys.argv[4]
    connected = sql("select string_agg(c.slug, ',' order by c.slug) from public.company_integrations i "
                    "join public.companies c on c.id=i.company_id where i.status='CONNECTED' and not c.is_demo")
    slugs = [s for s in connected.split(',') if s]
    created = []
    if phase == 'dimensions':
        missing = sql("select string_agg(distinct c.slug||':'||e.entity, ',') from public.companies c "
                      "cross join (values('vendors'),('customers'),('products')) e(entity) "
                      "where not c.is_demo and not exists(select 1 from public.integration_sync_runs r "
                      "where r.company_id=c.id and r.entity=e.entity and r.status in ('SUCCESS','WARNING'))")
        for pair in [p for p in missing.split(',') if p]:
            slug, entity = pair.split(':')
            if slug in slugs:
                created += json.loads(ctl('enqueue', slug, entity))
    else:
        entities = {'facts': ['invoices', 'orders'], 'finance': ['receivables', 'settlements'],
                    'receivables': ['receivables']}[phase]
        for entity in entities:
            for slug in slugs:
                created += json.loads(ctl('enqueue', slug, entity, start, end))
    print(json.dumps({'connected': slugs, 'created': created}, indent=1))
elif command == 'retry-failed':
    # Failed jobs go back to the queue in their original order (dimensions keep
    # vendors -> customers -> products because of created_at).
    print(sql("with r as (update public.integration_backfill_jobs set status='PENDING', last_error=null, "
              "updated_at=now() where status='FAILED' and created_at > now() - interval '2 days' returning entity) "
              "select coalesce(json_agg(entity), '[]') from r"))
elif command == 'recurring':
    if sys.argv[2:] not in (['on'], ['off']):
        raise SystemExit('recurring on|off')
    print(ctl('recurring', sys.argv[2]))
elif command in ('pause', 'resume'):
    print(ctl(command, *(sys.argv[2:] or [])))
elif command == 'status':
    queue = sql("select coalesce(json_agg(q order by q.prio, q.created), '[]') from (select c.slug, j.entity, j.status, "
                "j.partitions_done||'/'||j.partitions_total parts, left(coalesce(j.last_error,''),120) err, j.priority prio, "
                "j.created_at created from public.integration_backfill_jobs j join public.companies c on c.id=j.company_id "
                "where j.created_at > now() - interval '2 days' and j.status not in ('DONE','CANCELLED')) q")
    # With recurring loads on, finished jobs are only counted (hundreds per day).
    queue_24h = sql("select coalesce(json_object_agg(status, n), '{}') from (select status, count(*) n "
                    "from public.integration_backfill_jobs where created_at > now() - interval '24 hours' group by 1) x")
    runs = sql("select coalesce(json_agg(r), '[]') from (select distinct on (c.slug, r.entity) c.slug, r.entity, r.status, "
               "r.received, r.raw_complete raw, r.canonical_complete can, r.gold_complete gold, "
               "to_char(r.finished_at at time zone 'America/Fortaleza','HH24:MI') fin, left(coalesce(r.message,''),140) msg "
               "from public.integration_sync_runs r join public.companies c on c.id=r.company_id where not c.is_demo "
               "order by c.slug, r.entity, r.started_at desc) r")
    worker = sql("select value from private.app_settings where key='worker.status'")
    load = pathlib.Path('/proc/loadavg').read_text().split()[:3]
    stats = run(['docker', 'stats', '--no-stream', '--format', '{{.Name}} {{.CPUPerc}} {{.MemUsage}}'])
    print(json.dumps({'worker': json.loads(worker or '{}'), 'loadavg': load, 'cpus': os.cpu_count(),
                      'queue': json.loads(queue), 'queue_24h': json.loads(queue_24h), 'latest_runs': json.loads(runs),
                      'stats': [s for s in stats.splitlines() if 'biomie-v2' in s or 'erpnext-db' in s]},
                     indent=1, ensure_ascii=False))
else:
    raise SystemExit(__doc__)
