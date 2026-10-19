#!/usr/bin/env python3
"""BIOMIE v2 health monitor (installed at /opt/biomie-v2/bin/health.py, cron every 5 min).

Collects host (load, memory, swap, disk, iowait), containers, PostgreSQL,
worker, backup and sync health. Writes /opt/biomie-v2/ops/health.json, appends a
CSV line and logs WARN lines to /var/log/biomie-v2-health.log.
Protection: when available memory is critical the worker is paused
automatically ("auto:" reason) and resumed only when that automatic pause can
be lifted; manual pauses are never touched.
"""
import datetime as dt
import json
import os
import pathlib
import subprocess
import time
import urllib.request

BASE = pathlib.Path('/opt/biomie-v2')
COMPOSE = ['docker', 'compose', '--env-file', str(BASE / 'shared/stack.env'), '-f', str(BASE / 'compose.yml')]
OUT = BASE / 'ops' / 'health.json'
CSV = pathlib.Path('/var/log/biomie-v2-health.csv')
LOG = pathlib.Path('/var/log/biomie-v2-health.log')
STATE = BASE / 'ops' / 'health-state.json'
MEM_CRITICAL_MB = 450
MEM_RESUME_MB = 900


def sh(cmd, timeout=30):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return p.stdout.strip() if p.returncode == 0 else ''


def psql(query):
    out = sh(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', 'biomie_v2', '-At', '-c', query], 60)
    return out.splitlines()[-1] if out else ''


def cpu_times():
    fields = pathlib.Path('/proc/stat').read_text().splitlines()[0].split()[1:]
    values = list(map(int, fields))
    return sum(values), values[4]  # total, iowait


def main():
    now = dt.datetime.now(dt.timezone.utc)
    previous = json.loads(STATE.read_text()) if STATE.exists() else {}
    total, iowait = cpu_times()
    io_pct = None
    if previous.get('cpu_total') and total > previous['cpu_total']:
        io_pct = round(100 * (iowait - previous['cpu_iowait']) / (total - previous['cpu_total']), 1)
    meminfo = dict((l.split(':')[0], int(l.split()[1])) for l in pathlib.Path('/proc/meminfo').read_text().splitlines())
    load = os.getloadavg()
    disk = os.statvfs('/')
    health = {
        'at': now.isoformat(),
        'host': {'load': [round(x, 2) for x in load], 'cpus': os.cpu_count(),
                 'mem_available_mb': meminfo['MemAvailable'] // 1024,
                 'swap_used_mb': (meminfo['SwapTotal'] - meminfo['SwapFree']) // 1024,
                 'disk_free_gb': round(disk.f_bavail * disk.f_frsize / 1024 ** 3, 1), 'iowait_pct': io_pct},
        'containers': [dict(zip(('name', 'cpu', 'mem'), l.split('|'))) for l in
                       sh(['docker', 'stats', '--no-stream', '--format', '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}']).splitlines()
                       if l.startswith('biomie-v2')],
        'postgres': json.loads(psql("""select json_build_object(
            'connections', (select count(*) from pg_stat_activity where datname='biomie_v2'),
            'longest_query_s', (select coalesce(max(extract(epoch from now()-query_start))::int,0) from pg_stat_activity
                                where datname='biomie_v2' and state='active' and query not ilike '%pg_stat_activity%'),
            'size_mb', pg_database_size('biomie_v2')/1048576,
            'sync_failures_24h', (select count(*) from public.integration_sync_runs where status='FAILED' and started_at > now()-interval '24 hours'),
            'worker', (select value from private.app_settings where key='worker.status'),
            'control', (select value from private.app_settings where key='worker.control'));""") or '{}'),
    }
    backup = json.loads((BASE / 'ops/backup-state.json').read_text()) if (BASE / 'ops/backup-state.json').exists() else {}
    age = lambda iso: round((now - dt.datetime.fromisoformat(iso)).total_seconds() / 3600, 1) if iso else None
    health['backup'] = {'last_backup_h': age((backup.get('last_backup') or {}).get('at')),
                        'last_offsite_h': age((backup.get('last_offsite') or {}).get('at')),
                        'last_restore_test_h': age((backup.get('last_restore_test') or {}).get('at'))}
    worker = json.loads(health['postgres'].get('worker') or '{}') if isinstance(health['postgres'].get('worker'), str) else {}
    control = json.loads(health['postgres'].get('control') or '{}') if isinstance(health['postgres'].get('control'), str) else {}
    health['worker'] = {'state': worker.get('state'), 'heartbeat_min': round(age(worker.get('heartbeat_at')) * 60, 1)
                        if worker.get('heartbeat_at') else None, 'paused': control.get('paused'),
                        'reason': control.get('reason')}
    try:
        with urllib.request.urlopen('https://biomie.magmoveiscorporativos.com.br/supabase/auth/v1/health', timeout=10) as r:
            health['public_api'] = r.status
    except Exception as error:
        health['public_api'] = type(error).__name__

    warnings = []
    h = health['host']
    if load[1] / max(1, h['cpus']) > 1.0:
        warnings.append(f"load5 {load[1]:.2f} acima de 1,0 por CPU")
    if h['mem_available_mb'] < 700:
        warnings.append(f"memoria disponivel {h['mem_available_mb']} MB")
    if h['disk_free_gb'] < 5:
        warnings.append(f"disco livre {h['disk_free_gb']} GB")
    if io_pct is not None and io_pct > 25:
        warnings.append(f"iowait {io_pct}%")
    if (health['worker']['heartbeat_min'] or 0) > 10 and not control.get('paused'):
        warnings.append('worker sem sinal ha mais de 10 min')
    if health['backup']['last_backup_h'] is None or health['backup']['last_backup_h'] > 26:
        warnings.append('backup com mais de 26 h')
    if health['backup']['last_restore_test_h'] is not None and health['backup']['last_restore_test_h'] > 8 * 24:
        warnings.append('teste de restauracao com mais de 8 dias')
    if (health['postgres'].get('longest_query_s') or 0) > 300:
        warnings.append('consulta no Postgres ha mais de 5 min')
    if health['public_api'] != 200:
        warnings.append(f"API publica respondeu {health['public_api']}")

    # Memory protection for the shared VPS (VSB ERP, sites): pause/resume the worker.
    reason = control.get('reason') or ''
    service = "select set_config('request.jwt.claims','{\"role\":\"service_role\"}',false); "
    if h['mem_available_mb'] < MEM_CRITICAL_MB and not control.get('paused'):
        psql(service + "select public.set_worker_control(true, null, 'auto: memoria critica');")
        warnings.append('worker pausado automaticamente (memoria critica)')
    elif control.get('paused') and reason.startswith('auto:') and h['mem_available_mb'] > MEM_RESUME_MB:
        psql(service + "select public.set_worker_control(false, null, 'auto: memoria normalizada');")
        warnings.append('worker retomado automaticamente (memoria normalizada)')

    health['warnings'] = warnings
    OUT.write_text(json.dumps(health, indent=1))
    STATE.write_text(json.dumps({'cpu_total': total, 'cpu_iowait': iowait}))
    if not CSV.exists():
        CSV.write_text('at,load1,load5,mem_avail_mb,swap_mb,disk_gb,iowait,pg_conn,pg_longest_s,worker,warnings\n')
    with CSV.open('a') as handle:
        handle.write(','.join(map(str, [now.isoformat(), round(load[0], 2), round(load[1], 2), h['mem_available_mb'],
                                        h['swap_used_mb'], h['disk_free_gb'], io_pct, health['postgres'].get('connections'),
                                        health['postgres'].get('longest_query_s'), health['worker']['state'],
                                        len(warnings)])) + '\n')
    if warnings:
        with LOG.open('a') as handle:
            for warning in warnings:
                handle.write(f"{now.isoformat()} WARN {warning}\n")


if __name__ == '__main__':
    main()
