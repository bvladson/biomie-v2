"""P0 on the VPS: rotate the exposed JWT/service key, split the gateway, remove
the SUPER_ADMIN smoke account and prove the old key is dead.

    python ops/remote.py ops/20_rotate_and_harden.py <release-short-sha>

Never prints secret values (only short fingerprints and HTTP statuses).
"""
import datetime
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE = pathlib.Path('/opt/biomie-v2')
SHORT = sys.argv[1]
REL = BASE / 'releases' / SHORT
ENV_PATH = BASE / 'shared' / 'stack.env'
COMPOSE = ['docker', 'compose', '--env-file', str(ENV_PATH), '-f', str(BASE / 'compose.yml')]
STACKCTL = ['python3', str(REL / 'deploy/vps/stackctl.py')]
report = {'release': SHORT, 'started': datetime.datetime.now().isoformat()}


def env():
    return dict(line.split('=', 1) for line in ENV_PATH.read_text().splitlines() if '=' in line)


def run(cmd, timeout=600):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                       env={**os.environ, 'BIOMIE_V2_BASE': str(BASE)})
    if p.returncode:
        values = [v for v in env().values() if len(v) > 12]
        msg = (p.stderr or p.stdout)[-1500:]
        for v in values:
            msg = msg.replace(v, '[REDACTED]')
        raise SystemExit('FAILED ' + ' '.join(cmd[:4]) + ': ' + msg)
    return p.stdout.strip()


def wait_healthy(container, seconds=180):
    deadline = time.time() + seconds
    while time.time() < deadline:
        state = subprocess.run(['docker', 'inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', container],
                               capture_output=True, text=True).stdout.strip()
        if state in ('healthy', 'running'):
            return state
        time.sleep(3)
    raise SystemExit(f'{container} did not become healthy')


def http(method, url, headers=None):
    req = urllib.request.Request(url, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read().decode(errors='replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors='replace')


def fp(value):
    return hashlib.sha256(value.encode()).hexdigest()[:10]


if not (REL / 'RELEASE.json').exists() or not (REL / 'deploy/vps/stackctl.py').exists():
    raise SystemExit('release not uploaded: ' + str(REL))

old = env()
old_service, old_anon = old['SERVICE_ROLE_KEY'], old['ANON_KEY']
stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
shutil.copy2(BASE / 'compose.yml', BASE / 'ops' / f'compose.yml.before-rotation-{stamp}')

report['rotate'] = json.loads(run(STACKCTL + ['rotate-jwt']))
report['credentials_key'] = json.loads(run(STACKCTL + ['ensure-secret', 'BIOMIE_CREDENTIALS_KEY']))
shutil.copy2(REL / 'deploy/vps/compose.yml', BASE / 'compose.yml')
report['gateway'] = json.loads(run(STACKCTL + ['render-gateway']))

# --no-deps: never recreate the database container here.
run(COMPOSE + ['up', '-d', '--no-build', '--no-deps', 'auth', 'rest', 'gateway'])
wait_healthy('biomie-v2-auth-1')
for _ in range(40):
    if http('GET', 'http://127.0.0.1:3140/health')[0] == 200 and http('GET', 'http://127.0.0.1:3141/health')[0] == 200:
        break
    time.sleep(2)
run(COMPOSE + ['up', '-d', '--no-build', '--no-deps', 'web'])
report['web'] = wait_healthy('biomie-v2-web-1')

new = env()
svc_old = {'Authorization': 'Bearer ' + old_service, 'apikey': old_service}
svc_new = {'Authorization': 'Bearer ' + new['SERVICE_ROLE_KEY'], 'apikey': new['SERVICE_ROLE_KEY']}
checks = {
    'old_service_internal_admin': http('GET', 'http://127.0.0.1:3141/auth/v1/admin/users?per_page=1', svc_old)[0],
    'old_service_internal_rest': http('GET', 'http://127.0.0.1:3141/rest/v1/companies?select=id&limit=1', svc_old)[0],
    'new_service_internal_admin': http('GET', 'http://127.0.0.1:3141/auth/v1/admin/users?per_page=1', svc_new)[0],
    'public_admin_with_new_service': http('GET', 'http://127.0.0.1:3140/auth/v1/admin/users?per_page=1', svc_new)[0],
    'public_rest_with_new_service': http('GET', 'http://127.0.0.1:3140/rest/v1/companies?select=id&limit=1', svc_new)[0],
    'public_rest_with_old_anon': http('GET', 'http://127.0.0.1:3140/rest/v1/companies?select=id&limit=1', {'apikey': old_anon})[0],
}
status, body = http('GET', 'http://127.0.0.1:3140/rest/v1/companies?select=id&limit=1', {'apikey': new['ANON_KEY']})
checks['public_rest_with_new_anon_reaches_postgrest'] = status == 401 and '42501' in body
checks['public_domain_admin'] = http('GET', 'https://biomie.magmoveiscorporativos.com.br/supabase/auth/v1/admin/users', svc_new)[0]
expected = {'old_service_internal_admin': {401, 403}, 'old_service_internal_rest': {401},
            'new_service_internal_admin': {200}, 'public_admin_with_new_service': {403},
            'public_rest_with_new_service': {401}, 'public_rest_with_old_anon': {401},
            'public_rest_with_new_anon_reaches_postgrest': {True}, 'public_domain_admin': {403}}
report['checks'] = checks
# GoTrue answers 403 (bad_jwt) for an invalid admin token; both mean "rejected".
report['checks_ok'] = all(checks[k] in v for k, v in expected.items())

# Smoke SUPER_ADMIN account: delete through GoTrue (removes sessions and refresh tokens).
status, body = http('GET', 'http://127.0.0.1:3141/auth/v1/admin/users?per_page=1000', svc_new)
users = json.loads(body).get('users', []) if status == 200 else []
removed = []
for user in users:
    email = (user.get('email') or '').lower()
    if email.endswith('@biomie.invalid') or email.endswith('@biomie-test.dev'):
        code = http('DELETE', 'http://127.0.0.1:3141/auth/v1/admin/users/' + user['id'], svc_new)[0]
        removed.append({'user_fp': fp(user['id']), 'status': code})
report['test_accounts_removed'] = removed
sql = """
delete from public.user_company_access a where not exists(select 1 from auth.users u where u.id=a.user_id);
delete from public.user_roles r where not exists(select 1 from auth.users u where u.id=r.user_id);
delete from public.profiles p where not exists(select 1 from auth.users u where u.id=p.id);
select json_build_object(
  'users', (select count(*) from auth.users),
  'test_users', (select count(*) from auth.users where email like '%@biomie.invalid' or email like '%@biomie-test.dev'),
  'orphan_sessions', (select count(*) from auth.sessions s where not exists(select 1 from auth.users u where u.id=s.user_id)),
  'orphan_refresh_tokens', (select count(*) from auth.refresh_tokens t where not exists(select 1 from auth.users u where u.id::text=t.user_id::text)),
  'super_admins', (select count(*) from public.user_roles where role='SUPER_ADMIN'));
"""
report['accounts_after'] = json.loads(run(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', 'biomie_v2',
                                                     '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql]).splitlines()[-1])
smoke_file = BASE / 'shared' / 'smoke-account.json'
if smoke_file.exists():
    smoke_file.write_bytes(os.urandom(smoke_file.stat().st_size))
    smoke_file.unlink()
report['smoke_file_removed'] = not smoke_file.exists()
report['finished'] = datetime.datetime.now().isoformat()
print(json.dumps(report, indent=2))
if not report['checks_ok']:
    raise SystemExit(2)
