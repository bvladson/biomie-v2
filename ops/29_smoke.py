"""Browser smoke test with short-lived real accounts (admin + common user).

    python ops/29_smoke.py [base_url]
    python ops/29_smoke.py --admin      # Admin 2.0 de ponta a ponta (Super admin, Admin da
                                        # MAG Filial e Vendedor): convite, senha temporária,
                                        # bloqueio, exclusão e as travas de cada perfil
    python ops/29_smoke.py --stock [--stock-mode off|pilot|on]
                                        # Estoque: telas, empresas, card no produto, celular,
                                        # menu por liberação e vendedor sem custo
    ... --hml                           # na HOMOLOGAÇÃO (41_homolog.py): túnel local 3150, contas
                                        # criadas e apagadas só lá; a produção não é tocada

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
import socket
import subprocess
import sys
import time
import urllib.request

BASE = pathlib.Path(__file__).resolve().parent.parent
SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes',
       '-i', str(pathlib.Path.home() / '.ssh/hostinger_srv1851839_ed25519'), 'root@179.197.238.57']
REMOTE = r'''
import json, subprocess, sys, urllib.request, urllib.error
req = json.loads(sys.stdin.read())
B = '/opt/biomie-v2'
HML = req.get('hml', False)
env = dict(l.split('=', 1) for l in open(B + '/shared/stack.env').read().splitlines() if '=' in l)
if HML:
    env.update(dict(l.split('=', 1) for l in open(B + '/hml/hml.env').read().splitlines() if '=' in l))
KEY = env['HML_SERVICE_KEY'] if HML else env['SERVICE_ROLE_KEY']
AUTH = 'http://127.0.0.1:3151/auth/v1' if HML else 'http://127.0.0.1:3141/auth/v1'
DBNAME = 'biomie_v2_hml' if HML else 'biomie_v2'
H = {'Authorization': 'Bearer ' + KEY, 'apikey': KEY, 'Content-Type': 'application/json'}
C = ['docker', 'compose', '--env-file', B + '/shared/stack.env', '-f', B + '/compose.yml', 'exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', DBNAME, '-At', '-v', 'ON_ERROR_STOP=1']
def http(method, path, body=None):
    r = urllib.request.Request(AUTH + path, method=method, headers=H,
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
    # Admin 2.0: who was deleted on screen stays as a logical deletion (e-mail anonymised);
    # find it by the profile e-mail and remove it for good.
    for uid in [x for x in sql("select id from public.profiles where email like 'smoke-%@biomie.invalid';").split() if x]:
        out.append({'deleted_tombstone': http('DELETE', '/admin/users/' + uid)[0]})
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
# --hml: homologação (41_homolog.py). O navegador abre http://127.0.0.1:3150 por um túnel com a MESMA
# porta local (o endereço da API está embutido no pacote do navegador da homologação).
HML_MODE = '--hml' in sys.argv
ADMIN_MODE = '--admin' in sys.argv  # Admin 2.0 end-to-end (ops/browser/admin-smoke.cjs)
# --stock [--stock-mode off|pilot|on]: Estoque (0041) com Super admin, Gestor e Vendedor da MAG Filial.
STOCK_MODE = '--stock' in sys.argv
STOCK_EXPECTED = sys.argv[sys.argv.index('--stock-mode') + 1] if '--stock-mode' in sys.argv else 'off'
if STOCK_EXPECTED not in ('off', 'pilot', 'on'):
    raise SystemExit('invalid --stock-mode')
accounts = [
    {'label': 'super', 'email': f'smoke-super-{stamp}@biomie.invalid', 'password': secrets.token_urlsafe(24),
     'role': 'SUPER_ADMIN', 'fullName': 'Smoke Super'},
    {'label': 'gestor', 'email': f'smoke-gestor-{stamp}@biomie.invalid', 'password': secrets.token_urlsafe(24),
     'role': 'GESTOR', 'fullName': 'Smoke Gestor', 'companies': ['mag-filial']},
    {'label': 'vendor', 'email': f'smoke-vendor-{stamp}@biomie.invalid', 'password': secrets.token_urlsafe(24),
     'role': 'VENDEDOR', 'fullName': 'Smoke Vendor', 'companies': ['mag-filial']},
] if STOCK_MODE else [
    {'label': 'super', 'email': f'smoke-super-{stamp}@biomie.invalid', 'password': secrets.token_urlsafe(24),
     'role': 'SUPER_ADMIN', 'fullName': 'Smoke Super'},
    {'label': 'tenant', 'email': f'smoke-tenant-{stamp}@biomie.invalid', 'password': secrets.token_urlsafe(24),
     'role': 'ADMIN', 'fullName': 'Smoke Tenant', 'companies': ['mag-filial']},
    {'label': 'vendor', 'email': f'smoke-vendor-{stamp}@biomie.invalid', 'password': secrets.token_urlsafe(24),
     'role': 'VENDEDOR', 'fullName': 'Smoke Vendor', 'companies': ['mag-filial']},
] if ADMIN_MODE else [
    {'label': 'admin', 'email': f'smoke-admin-{stamp}@biomie.invalid', 'password': secrets.token_urlsafe(24),
     'role': 'SUPER_ADMIN', 'fullName': 'Smoke Admin'},
    {'label': 'common', 'email': f'smoke-common-{stamp}@biomie.invalid', 'password': secrets.token_urlsafe(24),
     'role': 'VIEWER', 'fullName': 'Smoke Common', 'companies': ['mag-filial'], 'legacy': {'mag-filial': ['licitacao']}},
]
report = {}
tunnel = None
try:
    report['create'] = remote({'action': 'create', 'accounts': accounts, 'hml': HML_MODE})
    env = {**os.environ, 'BIOMIE_SMOKE_ACCOUNTS': json.dumps(accounts),
           'BIOMIE_SMOKE_SHOTS': str(BASE / 'ops' / 'logs'), 'BIOMIE_SMOKE_STAMP': stamp,
           'BIOMIE_STOCK_MODE': STOCK_EXPECTED, 'BIOMIE_STOCK_CURVES': '1' if '--curves' in sys.argv else '0'}
    # --shots <prefix>: full-page screenshots of every admin screen (visual comparison).
    if '--shots' in sys.argv:
        env['BIOMIE_SMOKE_SHOT_PREFIX'] = sys.argv[sys.argv.index('--shots') + 1]
    # --upstream-port: which private web to look at (3130 production, 3132 preview).
    port = sys.argv[sys.argv.index('--upstream-port') + 1] if '--upstream-port' in sys.argv else '3130'
    if not port.isdigit():
        raise SystemExit('invalid --upstream-port')
    if HML_MODE:
        with socket.socket() as s:
            if s.connect_ex(('127.0.0.1', 3150)) == 0:
                raise SystemExit('porta local 3150 ocupada: feche o outro túnel da homologação')
        tunnel = subprocess.Popen(SSH[:-1] + ['-N', '-o', 'ExitOnForwardFailure=yes',
                                              '-L', '3150:127.0.0.1:3150', SSH[-1]])
        time.sleep(4)
        if tunnel.poll() is not None:
            raise SystemExit(f'túnel para a homologação falhou (exit {tunnel.returncode})')
        env['BIOMIE_TEST_URL'] = 'http://127.0.0.1:3150'
    elif '--pre-cutover' in sys.argv:
        # Free local port + ExitOnForwardFailure: never ride on a stale tunnel to another web.
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            local = s.getsockname()[1]
        tunnel = subprocess.Popen(SSH[:-1] + ['-N', '-o', 'ExitOnForwardFailure=yes',
                                              '-L', f'{local}:127.0.0.1:{port}', SSH[-1]])
        time.sleep(4)
        if tunnel.poll() is not None:
            raise SystemExit(f'tunnel to 127.0.0.1:{port} failed (exit {tunnel.returncode})')
        env['BIOMIE_TEST_UPSTREAM'] = f'http://127.0.0.1:{local}'
        # Which build answered: the hashed stylesheet name changes with every release.
        with urllib.request.urlopen(f'http://127.0.0.1:{local}/auth', timeout=30) as r:
            found = re.search(r'/assets/styles-[A-Za-z0-9_-]+[.]css', r.read().decode('utf-8', 'replace'))
        report['upstream_styles'] = found.group(0) if found else None
    report['mode'] = ('homologação (127.0.0.1:3150 via túnel)' if HML_MODE else
                      f'pre-cutover (private web 127.0.0.1:{port} via tunnel)' if tunnel else 'public site')
    (BASE / 'ops' / 'logs').mkdir(exist_ok=True)
    script = 'stock-smoke.cjs' if STOCK_MODE else 'admin-smoke.cjs' if ADMIN_MODE else 'smoke.cjs'
    p = subprocess.run(['node', str(BASE / 'ops/browser' / script)], cwd=BASE / 'ops/browser', env=env,
                       capture_output=True, text=True, timeout=900)
    try:
        start = p.stdout.index('{' if ADMIN_MODE or STOCK_MODE else '[')
        report['browser'] = json.loads(redact(p.stdout[start:]))
    except ValueError:
        report['browser_error'] = redact((p.stderr or p.stdout)[-1500:])
    report['browser_exit'] = p.returncode
finally:
    if tunnel:
        tunnel.terminate()
    report['cleanup'] = remote({'action': 'delete', 'hml': HML_MODE})
print(json.dumps(report, indent=1, ensure_ascii=False))
