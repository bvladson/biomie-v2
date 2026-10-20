"""Prove, today, that the key rotation of 19/10/2026 16:20 is effective. Never prints a secret.

    python ops/remote.py ops/34_verify_rotation.py

Compares fingerprints (sha256[:10], the stackctl method) of the live configuration,
the running containers, the public JavaScript and the gateway with the fingerprints
recorded by ops/20_rotate_and_harden.py; checks that the gateway still refuses the
service key on the public side; checks auth for pre-rotation sessions/refresh tokens.
"""
import base64
import hashlib
import json
import pathlib
import re
import subprocess
import urllib.error
import urllib.request

BASE = pathlib.Path('/opt/biomie-v2')
ENV_PATH = BASE / 'shared' / 'stack.env'
COMPOSE = ['docker', 'compose', '--env-file', str(ENV_PATH), '-f', str(BASE / 'compose.yml')]
ROTATED_AT = '2026-10-19 19:20:58+00'
OLD = {'JWT_SECRET': '9c6d63fe70', 'ANON_KEY': '1eb6fa3113', 'SERVICE_ROLE_KEY': '1466391252'}
NEW = {'JWT_SECRET': 'fe586bd6b4', 'ANON_KEY': 'a2fa1b665e', 'SERVICE_ROLE_KEY': 'd89be9b88e'}
JWT = re.compile(r'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}')


def fp(value):
    return hashlib.sha256(value.encode()).hexdigest()[:10]


def claims(token):
    part = token.split('.')[1]
    return json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))


def http_body(url, headers=None):
    req = urllib.request.Request(url, headers={'User-Agent': 'biomie-ops-check', **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read(400000).decode(errors='replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read(2000).decode(errors='replace')


def http(url, headers=None):
    status, body = http_body(url, headers)
    return status, body if status < 400 else ''


env = dict(l.split('=', 1) for l in ENV_PATH.read_text().splitlines() if '=' in l and not l.startswith('#'))
report = {'stack_env': {}, 'containers': {}, 'public_bundle': {}, 'gateway_conf': {}, 'gateway_checks': {}, 'auth': {}}
for key in ('JWT_SECRET', 'ANON_KEY', 'SERVICE_ROLE_KEY'):
    value = env.get(key, '')
    report['stack_env'][key] = {'fp': fp(value), 'is_rotated_value': fp(value) == NEW[key], 'is_old_value': fp(value) == OLD[key]}
for key in ('ANON_KEY', 'SERVICE_ROLE_KEY'):
    c = claims(env[key])
    report['stack_env'][key].update({'role': c.get('role'), 'iat_utc': c.get('iat')})

wanted = {'auth': ['GOTRUE_JWT_SECRET'], 'rest': ['PGRST_JWT_SECRET'],
          'web': ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_PUBLISHABLE_KEY'],
          'worker': ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_PUBLISHABLE_KEY']}
for service, keys in wanted.items():
    cid = subprocess.run(COMPOSE + ['ps', '-q', service], capture_output=True, text=True).stdout.strip()
    raw = subprocess.run(['docker', 'inspect', '--format', '{{json .Config.Env}}', cid], capture_output=True, text=True).stdout
    cenv = dict(e.split('=', 1) for e in json.loads(raw or '[]') if '=' in e)
    report['containers'][service] = {k: fp(cenv.get(k, '')) for k in keys}

status, html = http('https://biomie.magmoveiscorporativos.com.br/auth')
scripts = sorted(set(re.findall(r'/assets/[A-Za-z0-9_.-]+\.js', html)))
found, secret_hits = [], 0
for path in scripts[:60]:
    s, body = http('https://biomie.magmoveiscorporativos.com.br' + path)
    for token in set(JWT.findall(body)):
        try:
            found.append({'role': claims(token).get('role'), 'fp': fp(token)})
        except Exception:
            pass
    secret_hits += sum(1 for k in ('JWT_SECRET', 'SERVICE_ROLE_KEY', 'BIOMIE_CREDENTIALS_KEY') if env.get(k) and env[k] in body)
report['public_bundle'] = {'login_status': status, 'scripts_checked': len(scripts[:60]),
                           'jwts_found': found, 'service_role_jwts': sum(1 for f in found if f['role'] == 'service_role'),
                           'server_secrets_present': secret_hits}

gw = pathlib.Path(env.get('GATEWAY_CONFIG', str(BASE / 'shared/gateway.conf')))
text = gw.read_text() if gw.exists() else ''
tokens = set(JWT.findall(text))
report['gateway_conf'] = {'jwts': len(tokens), 'old_fps_present': [k for k, v in OLD.items() if any(fp(t) == v for t in tokens)],
                          'new_fps_present': [k for k, v in NEW.items() if any(fp(t) == v for t in tokens)]}

svc = {'Authorization': 'Bearer ' + env['SERVICE_ROLE_KEY'], 'apikey': env['SERVICE_ROLE_KEY']}
anon = {'apikey': env['ANON_KEY']}
report['gateway_checks'] = {
    'service_internal_admin(expect 200)': http('http://127.0.0.1:3141/auth/v1/admin/users?per_page=1', svc)[0],
    'service_public_admin(expect 403)': http('http://127.0.0.1:3140/auth/v1/admin/users?per_page=1', svc)[0],
    'service_public_rest(expect 401)': http('http://127.0.0.1:3140/rest/v1/companies?select=id&limit=1', svc)[0],
    # A valid anon key reaches PostgREST, whose anon role has no grant on companies:
    # 401 with Postgres code 42501. An old/forged key would fail on the signature instead.
    'anon_public_rest_reaches_postgrest(expect True)': (lambda r: r[0] == 401 and '42501' in r[1])(
        http_body('http://127.0.0.1:3140/rest/v1/companies?select=id&limit=1', anon)),
    # Sent without any key: the public admin route must be closed for everybody.
    'domain_admin(expect 403)': http('https://biomie.magmoveiscorporativos.com.br/supabase/auth/v1/admin/users')[0],
}


def psql(q):
    return subprocess.run(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', 'biomie_v2', '-At', '-c', q],
                          capture_output=True, text=True).stdout.strip()


report['auth'] = {
    'users': psql('select count(*) from auth.users'),
    'test_or_smoke_users': psql("select count(*) from auth.users where email like '%.invalid' or email ilike '%smoke%' or email ilike '%teste%'"),
    'sessions_before_rotation': psql(f"select count(*) from auth.sessions where created_at < '{ROTATED_AT}'"),
    'refresh_tokens_before_rotation_not_revoked': psql(f"select count(*) from auth.refresh_tokens where created_at < '{ROTATED_AT}' and not revoked"),
    'orphan_sessions': psql('select count(*) from auth.sessions s where not exists(select 1 from auth.users u where u.id=s.user_id)'),
    'super_admins': psql("select count(*) from public.user_roles where role::text='SUPER_ADMIN'"),
}
checks = report['gateway_checks']
report['ok'] = (all(v['is_rotated_value'] for v in report['stack_env'].values())
                and all(f == NEW['JWT_SECRET'] for f in (report['containers']['auth']['GOTRUE_JWT_SECRET'], report['containers']['rest']['PGRST_JWT_SECRET']))
                and all(c['SUPABASE_SERVICE_ROLE_KEY'] == NEW['SERVICE_ROLE_KEY'] and c['SUPABASE_PUBLISHABLE_KEY'] == NEW['ANON_KEY']
                        for c in (report['containers']['web'], report['containers']['worker']))
                and report['public_bundle']['service_role_jwts'] == 0 and report['public_bundle']['server_secrets_present'] == 0
                and all(f['fp'] == NEW['ANON_KEY'] for f in report['public_bundle']['jwts_found'])
                and not report['gateway_conf']['old_fps_present']
                and [checks[k] for k in checks] == [200, 403, 401, True, 403]
                and report['auth']['sessions_before_rotation'] == '0'
                and report['auth']['refresh_tokens_before_rotation_not_revoked'] == '0'
                and report['auth']['test_or_smoke_users'] == '0')
print(json.dumps(report, indent=1))
