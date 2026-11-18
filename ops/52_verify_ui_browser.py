"""Read-only UI smoke with one disposable account, cleaned by its exact UID.

python ops/52_verify_ui_browser.py preview|production
Passwords stay in memory. No global smoke-account cleanup or business mutations.
"""
import datetime
import json
import os
import pathlib
import secrets
import shlex
import socket
import subprocess
import sys
import time

BASE = pathlib.Path(__file__).resolve().parent.parent
SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
       '-o', 'StrictHostKeyChecking=yes', '-o', 'ServerAliveInterval=30',
       '-i', str(pathlib.Path.home() / '.ssh/id_ed25519_vps'), 'root@203.0.113.10']

REMOTE = r'''
import json, pathlib, re, subprocess, sys, urllib.request, urllib.error, uuid
request = json.load(sys.stdin)
root = pathlib.Path('/opt/biomie-v2')
env = dict(line.split('=', 1) for line in (root / 'shared/stack.env').read_text().splitlines() if '=' in line)
key = env['SERVICE_ROLE_KEY']
headers = {'Authorization': 'Bearer ' + key, 'apikey': key, 'Content-Type': 'application/json'}
auth = 'http://127.0.0.1:3141/auth/v1'
compose = ['docker', 'compose', '--env-file', str(root / 'shared/stack.env'), '-f', str(root / 'compose.yml')]
email = request['email']
assert re.fullmatch(r'ui-scroll-[0-9]{8}-[a-f0-9]{12}@biomie[.]invalid', email)

def api(method, path, body=None):
    req = urllib.request.Request(auth + path, method=method, headers=headers,
          data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, json.loads(response.read() or '{}')
    except urllib.error.HTTPError as error:
        return error.code, {}

def sql(statement):
    result = subprocess.run(compose + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres',
             '-d', 'biomie_v2', '-At', '-v', 'ON_ERROR_STOP=1'], input=statement,
             capture_output=True, text=True, timeout=60)
    if result.returncode: raise RuntimeError('Disposable UI account SQL failed')
    return result.stdout.strip()

def remove(uid):
    if not uid:
        found = sql("select id from auth.users where email='" + email + "' union "
                    "select id from public.profiles where email='" + email + "';").splitlines()
        if not found: return {'removed': True, 'remaining_rows': 0}
        assert len(found) == 1, 'Disposable account ownership is ambiguous'
        uid = found[0]
    uid = str(uuid.UUID(uid))
    status, user = api('GET', '/admin/users/' + uid)
    if status == 200:
        assert user.get('email') == email, 'Disposable account ownership mismatch'
        deleted, _ = api('DELETE', '/admin/users/' + uid)
        assert deleted in (200, 204), 'Disposable account removal failed'
    elif status != 404:
        raise RuntimeError('Disposable account verification failed')
    # Only this UID; never remove other testers or unrelated orphan rows.
    sql("begin; delete from public.user_company_access where user_id='" + uid + "';"
        "delete from public.user_roles where user_id='" + uid + "';"
        "delete from public.profiles where id='" + uid + "'; commit;")
    count = sql("select (select count(*) from auth.users where id='" + uid + "') + "
        "(select count(*) from public.profiles where id='" + uid + "') + "
        "(select count(*) from public.user_roles where user_id='" + uid + "') + "
        "(select count(*) from public.user_company_access where user_id='" + uid + "') + "
        "(select count(*) from auth.sessions where user_id='" + uid + "');")
    assert count == '0', 'Disposable UI account cleanup incomplete'
    return {'removed': True, 'remaining_rows': 0}

if request['action'] == 'create':
    status, user = api('POST', '/admin/users', {'email': email, 'password': request['password'],
           'email_confirm': True, 'user_metadata': {'full_name': 'Validação temporária da interface'}})
    assert status == 200 and user.get('id'), 'Disposable account creation failed'
    uid = str(uuid.UUID(user['id']))
    try:
        company = str(uuid.UUID(sql("select id from public.companies where slug='mag-filial';")))
        sql("begin; insert into public.profiles(id,email,full_name,default_company_id) values('" + uid +
            "','" + email + "','Validação temporária da interface','" + company +
            "') on conflict(id) do update set default_company_id=excluded.default_company_id;"
            "insert into public.user_roles(user_id,role) values('" + uid + "','SUPER_ADMIN') on conflict do nothing;"
            "insert into public.user_company_access(user_id,company_id) values('" + uid + "','" + company +
            "') on conflict do nothing; commit;")
        print(json.dumps({'uid': uid, 'created': True}))
    except BaseException:
        remove(uid)
        raise
else:
    assert request['action'] == 'delete'
    print(json.dumps(remove(request.get('uid'))))
'''


def remote(payload):
    result = subprocess.run(SSH + ['python3 -c ' + shlex.quote(REMOTE)],
                            input=json.dumps(payload), capture_output=True, text=True, timeout=150)
    if result.returncode:
        # Remote script deliberately never prints keys/passwords. Avoid tracebacks
        # that might repeat requests, SQL or credentials in future revisions.
        raise RuntimeError('Disposable UI account operation failed (remote exit %s)' % result.returncode)
    return json.loads(result.stdout)


mode = sys.argv[1] if len(sys.argv) == 2 else ''
if mode not in ('preview', 'production'):
    raise SystemExit(__doc__)
stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
account = {'label': 'super', 'email': 'ui-scroll-' + stamp[:8] + '-' + secrets.token_hex(6) + '@biomie.invalid',
           'password': secrets.token_urlsafe(32)}
logs = BASE / 'ops/logs'
logs.mkdir(exist_ok=True)
uid = None
tunnel = None
report = {'mode': mode, 'account_created': False, 'browser_exit': None}
try:
    created = remote({'action': 'create', **account})
    uid = created['uid']
    report['account_created'] = True
    test_env = {**os.environ, 'BIOMIE_TEST_URL': 'https://biomie.magmoveiscorporativos.com.br',
                'BIOMIE_SMOKE_ACCOUNTS': json.dumps([account]),
                'BIOMIE_SMOKE_SHOTS': str(logs / 'floating-scroll-production'),
                'BIOMIE_SMOKE_SHOT_PREFIX': mode + '-' + stamp}
    if mode == 'preview':
        with socket.socket() as temporary_socket:
            temporary_socket.bind(('127.0.0.1', 0))
            port = temporary_socket.getsockname()[1]
        tunnel = subprocess.Popen(SSH[:-1] + ['-N', '-o', 'ExitOnForwardFailure=yes',
                                  '-L', f'{port}:127.0.0.1:3132', SSH[-1]],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            if tunnel.poll() is not None: raise RuntimeError('Private preview tunnel failed')
            with socket.socket() as probe:
                if probe.connect_ex(('127.0.0.1', port)) == 0: break
            time.sleep(0.2)
        else: raise RuntimeError('Private preview tunnel did not become available')
        test_env['BIOMIE_TEST_UPSTREAM'] = f'http://127.0.0.1:{port}'
    else:
        test_env.pop('BIOMIE_TEST_UPSTREAM', None)
    browser = subprocess.run(['node', str(BASE / 'ops/browser/floating-scroll-production.cjs')],
                             cwd=BASE, env=test_env, capture_output=True, text=True, timeout=420)
    report['browser_exit'] = browser.returncode
    report['browser'] = json.loads(browser.stdout)
except Exception as error:
    report['failure'] = 'UI verification failed: ' + type(error).__name__
finally:
    if tunnel:
        tunnel.terminate()
        try: tunnel.wait(timeout=10)
        except subprocess.TimeoutExpired: tunnel.kill()
    try:
        # Recover by the exact random email even if SSH/create returned no UID.
        report['cleanup'] = remote({'action': 'delete', 'uid': uid, 'email': account['email']})
    except Exception as error:
        report['cleanup'] = {'removed': False, 'error': type(error).__name__, 'uid': uid}
    (logs / f'ui-browser-{mode}-{stamp}.json').write_text(
        json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(report, indent=2, ensure_ascii=False))
raise SystemExit(0 if report.get('browser_exit') == 0 and report.get('browser', {}).get('ok')
                 and report.get('cleanup', {}).get('removed') else 1)
