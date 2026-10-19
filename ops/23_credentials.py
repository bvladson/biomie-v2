"""Encrypt stored Omie credentials, enforce the constraint, prove each connection.

    python ops/remote.py ops/23_credentials.py [encrypt|test|status]   (default: all)

Runs the credentials CLI inside the web container (server environment holds the
encryption key). Prints only company slugs, statuses and Omie messages.
"""
import json
import pathlib
import subprocess
import sys

BASE = pathlib.Path('/opt/biomie-v2')
ENV = BASE / 'shared' / 'stack.env'
COMPOSE = ['docker', 'compose', '--env-file', str(ENV), '-f', str(BASE / 'compose.yml')]
action = sys.argv[1] if len(sys.argv) > 1 else 'all'


def ctl(*args, timeout=600):
    p = subprocess.run(COMPOSE + ['exec', '-T', 'web', 'node', '.output/credentials-ctl.mjs', *args],
                       capture_output=True, text=True, timeout=timeout)
    if p.returncode:
        raise SystemExit('credentials-ctl ' + ' '.join(args) + ' failed: ' + (p.stderr or p.stdout)[-800:])
    return json.loads(p.stdout)


report = {}
if action in ('all', 'encrypt'):
    report['encrypt'] = ctl('encrypt-existing')
    p = subprocess.run(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', 'biomie_v2',
                                  '-v', 'ON_ERROR_STOP=1', '-c',
                                  'alter table private.integration_credentials validate constraint integration_credentials_encrypted;'],
                       capture_output=True, text=True, timeout=120)
    report['constraint_validated'] = p.returncode == 0
    if p.returncode:
        raise SystemExit('constraint validation failed: ' + p.stderr[-500:])
if action in ('all', 'status'):
    report['status_before_test'] = ctl('status')
if action in ('all', 'test'):
    report['test'] = ctl('test', 'all', timeout=900)
    report['status_after_test'] = ctl('status')
print(json.dumps(report, indent=2, ensure_ascii=False))
