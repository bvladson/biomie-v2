"""Reprocess the stored RAW with the current adapters and rules, without calling Omie.

    python ops/remote.py ops/31_reprocess.py <company-slug|all> <invoices|orders|receivables|settlements|all>

Refuses unless the worker is paused. Each entity is re-canonicalized, promoted to
Gold and integrity-checked; every proven RAW period gets a REPROCESS run.
Prints counts and periods only.
"""
import json
import pathlib
import subprocess
import sys
import time

BASE = pathlib.Path('/opt/biomie-v2')
COMPOSE = ['docker', 'compose', '--env-file', str(BASE / 'shared/stack.env'), '-f', str(BASE / 'compose.yml')]
if len(sys.argv) != 3:
    raise SystemExit(__doc__)
selector, entity = sys.argv[1], sys.argv[2]


def psql(query):
    p = subprocess.run(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', 'biomie_v2', '-At',
                                  '-v', 'ON_ERROR_STOP=1', '-c', query], capture_output=True, text=True, timeout=120)
    if p.returncode:
        raise SystemExit('postgres: ' + p.stderr[-600:])
    return p.stdout.strip()


control = json.loads(psql("select value from private.app_settings where key='worker.control'") or '{}')
status = json.loads(psql("select value from private.app_settings where key='worker.status'") or '{}')
if not control.get('paused') or status.get('state') != 'PAUSED':
    raise SystemExit(f"Worker precisa estar pausado (controle={control.get('paused')}, estado={status.get('state')}).")
started = time.time()
p = subprocess.run(COMPOSE + ['exec', '-T', 'worker', 'node', '.output/reprocess-raw.mjs', selector, entity],
                   capture_output=True, text=True, timeout=3600)
if p.returncode:
    raise SystemExit('reprocess: ' + (p.stderr or p.stdout)[-1500:])
results = json.loads(p.stdout)
print(json.dumps({'seconds': round(time.time() - started), 'results': results}, indent=1, ensure_ascii=False))
