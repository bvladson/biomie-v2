"""Isolated TEST database (biomie_v2_test) in the same Postgres cluster.

    python ops/remote.py ops/22_test_database.py <release-short-sha> [--keep]

Creates the database from scratch (auth structure copied without data), applies
every migration of the release, runs the SQL suites and drops it again. The
production database is never used for tests.
"""
import json
import pathlib
import subprocess
import sys

BASE = pathlib.Path('/opt/biomie-v2')
SHORT = sys.argv[1]
KEEP = '--keep' in sys.argv
REL = BASE / 'releases' / SHORT
ENV = BASE / 'shared' / 'stack.env'
COMPOSE = ['docker', 'compose', '--env-file', str(ENV), '-f', str(BASE / 'compose.yml')]
TEST_DB = 'biomie_v2_test'
SUITES = ['deploy/db/verify_security.sql', 'deploy/db/verify_channel_filter.sql',
          'deploy/db/verify_pipeline_contract.sql', 'deploy/db/verify_rpc_grants.sql',
          'deploy/db/verify_order_scope.sql', 'deploy/db/verify_finance_adjustments.sql',
          'deploy/db/verify_admin_users.sql', 'deploy/db/verify_stock.sql',
          'scripts/test-commercial-contract.sql',
          'scripts/test-omie-matching.sql']


def psql(db, sql, timeout=600):
    return subprocess.run(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', db,
                                     '-v', 'ON_ERROR_STOP=1'], input=sql, capture_output=True,
                          text=True, timeout=timeout)


def must(p, label):
    if p.returncode:
        raise SystemExit(f'{label} FAILED: ' + (p.stderr or p.stdout)[-2500:])
    return p


report = {'release': SHORT, 'database': TEST_DB}
must(psql('postgres', f"select pg_terminate_backend(pid) from pg_stat_activity where datname='{TEST_DB}';"
                      f"drop database if exists {TEST_DB};"), 'drop')
must(psql('postgres', f'create database {TEST_DB};'), 'create')
must(psql(TEST_DB, 'create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions;'),
     'extensions')
auth_dump = subprocess.run(COMPOSE + ['exec', '-T', 'db', 'pg_dump', '-U', 'postgres', '-d', 'biomie_v2',
                                      '--schema=auth', '--schema-only'], capture_output=True, text=True,
                           timeout=300)
must(auth_dump, 'auth dump')
must(psql(TEST_DB, auth_dump.stdout), 'auth schema')
must(psql(TEST_DB, (REL / 'deploy/db/00_supabase_compat.sql').read_text()), 'compat')
rendered = subprocess.run(['python3', str(REL / 'scripts/render-vps-migrations.py')], capture_output=True,
                          text=True, check=True)
must(psql(TEST_DB, rendered.stdout, timeout=1200), 'migrations')
count = must(psql(TEST_DB, 'select count(*) from private.vps_schema_migrations;'), 'count').stdout
report['migrations_applied'] = int(count.split()[2])
results = {}
for suite in SUITES:
    path = REL / suite
    p = psql(TEST_DB, path.read_text(), timeout=600)
    notices = [line.split('NOTICE:', 1)[1].strip() for line in p.stderr.splitlines() if 'NOTICE:' in line]
    results[suite] = {'ok': p.returncode == 0, 'notices': notices[-8:],
                      'error': None if p.returncode == 0 else (p.stderr or p.stdout)[-1200:]}
report['suites'] = results
report['all_ok'] = all(r['ok'] for r in results.values())
if not KEEP:
    must(psql('postgres', f'drop database if exists {TEST_DB};'), 'cleanup')
report['dropped'] = not KEEP
print(json.dumps(report, indent=2, ensure_ascii=False))
if not report['all_ok']:
    raise SystemExit(3)
