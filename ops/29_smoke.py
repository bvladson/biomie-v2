"""Browser smoke test with short-lived real accounts (admin + common user).

    python ops/29_smoke.py [base_url]

Passwords are generated in memory, sent to the VPS over the SSH stdin and to the
browser through the environment; they are never printed or written. The accounts
are always deleted at the end (with their sessions).
The common user gets a HISTORICAL legacy grant "licitacao only" on MAG Filial to
prove that channel no longer hides data.
"""
import json
import os
import re
import pathlib
import secrets
import shlex
import subprocess
import sys
import time

BASE = pathlib.Path(__file__).resolve().parent.parent
SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes',
       '-i', str(pathlib.Path.home() / '.ssh/hostinger_srv1851839_ed25519'), 'root@179.197.238.57']
REMOTE = r'''
import json, subprocess, sys, urllib.request, urllib.error
req = json.loads(sys.stdin.read())
B = '/opt/biomie-v2'
env = dict(l.split('=', 1) for l in open(B + '/shared/stack.env').read().splitlines() if '=' in l)
H = {'Authorization': 'Bearer ' + env['SERVICE_ROLE_KEY'], 'apikey': env['SERVICE_ROLE_KEY'], 'Content-Type': 'application/json'}
C = ['docker', 'compose', '--env-file', B + '/shared/stack.env', '-f', B + '/compose.yml', 'exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', 'biomie_v2', '-At', '-v', 'ON_ERROR_STOP=1']
def http(method, path, body=None):
    r = urllib.request.Request('http://127.0.0.1:3141/auth/v1' + path, method=method, headers=H,
                               data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp: return resp.status, json.loads(resp.read() or b'{}')
    except urllib.error.HTTPError as e: return e.code, {}
def sql(q): return subprocess.run(C, input=q, capture_output=True, text=True, check=True).stdout.strip()
lit = lambda v: "'" + str(v).replace("'", "''") + "'"
out = []
if req['action'] == 'create':
    for a in req['accounts']:
        status, user = http('POST', '/admin/users', {'email': a['email'], 'password': a['password'], 'email_confirm': True,
                                                     'user_metadata': {'full_name': a['fullName']}})
        if status != 200: raise SystemExit('create failed ' + str(status))
        uid = user['id']
        q = f"insert into public.profiles(id,email,full_name,default_company_id) select {lit(uid)},{lit(a['email'])},{lit(a['fullName'])},id from public.companies where slug='mag-filial' on conflict(id) do update set full_name=excluded.full_name, default_company_id=excluded.default_company_id;"
        q += f"insert into public.user_roles(user_id,role) values({lit(uid)},{lit(a['role'])}) on conflict do nothing;"
        for slug in a.get('companies', []):
            q += f"insert into public.user_company_access(user_id,company_id) select {lit(uid)},id from public.companies where slug={lit(slug)} on conflict do nothing;"
        for slug, channels in a.get('legacy', {}).items():
            q += f"insert into private.legacy_company_access(user_id,company_id,allowed_channels,legacy_role) select {lit(uid)},id,array[{','.join(lit(c) for c in channels)}]::text[],'smoke' from public.companies where slug={lit(slug)} on conflict do nothing;"
        sql(q)
        out.append({'label': a['label'], 'created': True})
else:
    status, data = http('GET', '/admin/users?per_page=1000')
    for u in data.get('users', []):
        if (u.get('email') or '').startswith('smoke-') and u['email'].endswith('@biomie.invalid'):
            out.append({'deleted': http('DELETE', '/admin/users/' + u['id'])[0]})
    sql("delete from public.user_company_access a where not exists(select 1 from auth.users u where u.id=a.user_id);"
        "delete from public.user_roles r where not exists(select 1 from auth.users u where u.id=r.user_id);"
        "delete from public.profiles p where not exists(select 1 from auth.users u where u.id=p.id);")
    out.append({'remaining_smoke_users': int(sql("select count(*) from auth.users where email like 'smoke-%@biomie.invalid';")),
                'orphan_sessions': int(sql("select count(*) from auth.sessions s where not exists(select 1 from auth.users u where u.id=s.user_id);"))})
print(json.dumps(out))
'''


def redact(text):
    """Tokens, cookies and keys never reach the output (Playwright errors embed request headers)."""
    text = re.sub(r"(?i)(authorization|cookie|apikey|x-api-key)\s*:\s*[^\n']+", r'\1: [redacted]', text)
    text = re.sub(r'Bearer\s+[A-Za-z0-9._~+/=-]+', 'Bearer [redacted]', text)
    return re.sub(r'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+', '[jwt]', text)


def remote(payload):
    p = subprocess.run(SSH + ['python3 -c ' + shlex.quote(REMOTE)], input=json.dumps(payload),
                       capture_output=True, text=True, timeout=300)
    if p.returncode:
        raise SystemExit('remote failed: ' + p.stderr[-600:])
    return json.loads(p.stdout)


stamp = time.strftime('%Y%m%d%H%M%S')
accounts = [
    {'label': 'admin', 'email': f'smoke-admin-{stamp}@biomie.invalid', 'password': secrets.token_urlsafe(24),
     'role': 'SUPER_ADMIN', 'fullName': 'Smoke Admin'},
    {'label': 'common', 'email': f'smoke-common-{stamp}@biomie.invalid', 'password': secrets.token_urlsafe(24),
     'role': 'VIEWER', 'fullName': 'Smoke Common', 'companies': ['mag-filial'], 'legacy': {'mag-filial': ['licitacao']}},
]
report = {}
tunnel = None
try:
    report['create'] = remote({'action': 'create', 'accounts': accounts})
    env = {**os.environ, 'BIOMIE_SMOKE_ACCOUNTS': json.dumps(accounts),
           'BIOMIE_SMOKE_SHOTS': str(BASE / 'ops' / 'logs')}
    # --shots <prefix>: full-page screenshots of every admin screen (visual comparison).
    if '--shots' in sys.argv:
        env['BIOMIE_SMOKE_SHOT_PREFIX'] = sys.argv[sys.argv.index('--shots') + 1]
    # --upstream-port: which private web to look at (3130 production, 3132 preview).
    port = sys.argv[sys.argv.index('--upstream-port') + 1] if '--upstream-port' in sys.argv else '3130'
    if not port.isdigit():
        raise SystemExit('invalid --upstream-port')
    if '--pre-cutover' in sys.argv:
        tunnel = subprocess.Popen(SSH[:-1] + ['-N', '-L', f'33130:127.0.0.1:{port}', SSH[-1]])
        time.sleep(4)
        env['BIOMIE_TEST_UPSTREAM'] = 'http://127.0.0.1:33130'
    report['mode'] = f'pre-cutover (private web 127.0.0.1:{port} via tunnel)' if tunnel else 'public site'
    (BASE / 'ops' / 'logs').mkdir(exist_ok=True)
    p = subprocess.run(['node', str(BASE / 'ops/browser/smoke.cjs')], cwd=BASE / 'ops/browser', env=env,
                       capture_output=True, text=True, timeout=900)
    try:
        report['browser'] = json.loads(redact(p.stdout[p.stdout.index('['):]))
    except ValueError:
        report['browser_error'] = redact((p.stderr or p.stdout)[-1500:])
    report['browser_exit'] = p.returncode
finally:
    if tunnel:
        tunnel.terminate()
    report['cleanup'] = remote({'action': 'delete'})
print(json.dumps(report, indent=1, ensure_ascii=False))
