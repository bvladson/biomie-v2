"""HOMOLOGAÇÃO isolada da produção: banco, login, API e site próprios, só em 127.0.0.1.

    python ops/remote.py ops/41_homolog.py db-refresh               # copia a produção para biomie_v2_hml
    python ops/remote.py ops/41_homolog.py up <release-short-sha>   # migra a cópia e sobe a release
    python ops/remote.py ops/41_homolog.py status
    python ops/remote.py ops/41_homolog.py down                     # para os contêineres (a cópia fica)
    python ops/remote.py ops/41_homolog.py drop                     # apaga contêineres, cópia, chaves e imagem
    python ops/remote.py ops/41_homolog.py movements-probe <empresa-slug> [dias]   # 1 página do Omie, nada gravado
    python ops/remote.py ops/41_homolog.py movements-load [minutos]   # processa a fila de movimentações
                                                                      # da cópia (só LÊ o Omie)
    python ops/remote.py ops/41_homolog.py intel-run [args do motor]  # BIOMIE Intelligence na cópia
                                                                      # (ex.: run --trigger ops --force)

Para olhar no navegador: túnel SSH local 3150 -> 127.0.0.1:3150 (29_smoke.py --hml já faz isso).

Isolamento (22/10/2026):
- banco biomie_v2_hml no mesmo Postgres, copiado de biomie_v2 com pg_dump (a produção só é lida);
- segredo JWT e chaves anon/service PRÓPRIOS (hml.env 0600): uma sessão de produção não vale aqui e
  uma da homologação não vale na produção;
- serviços com nomes próprios (hml-auth, hml-rest, hml-gateway, hml-web, hml-edge, projeto
  "biomie-hml"); só hml-auth e hml-rest entram na rede da produção, para falar com o Postgres, e com
  nomes que não colidem com os da produção (o gateway da produção nunca resolve para cá);
- nada chama o Omie: não há worker; o web roda sem a chave das credenciais; leitura de estoque,
  movimentações e cargas ficam desligadas na cópia;
- portas só em 127.0.0.1: 3150 (site + /supabase/, como o nginx público) e 3151 (gateway interno,
  para a operação criar e apagar contas de teste).
"""
import base64
import datetime
import hashlib
import hmac
import json
import os
import pathlib
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE = pathlib.Path('/opt/biomie-v2')
STACK_ENV = BASE / 'shared' / 'stack.env'
HML = BASE / 'hml'
HML_ENV = HML / 'hml.env'
DB = 'biomie_v2_hml'
PROJECT = 'biomie-hml'
SITE_PORT, GATEWAY_PORT = 3150, 3151
SITE = f'http://127.0.0.1:{SITE_PORT}'
PROD = ['docker', 'compose', '--env-file', str(STACK_ENV), '-f', str(BASE / 'compose.yml')]
COMPOSE_ENV = HML / 'compose.env'
HML_COMPOSE = ['docker', 'compose', '-p', PROJECT, '--env-file', str(COMPOSE_ENV), '-f', str(HML / 'compose.yml')]


def run(cmd, input=None, timeout=1800, check=True, env=None):
    p = subprocess.run(cmd, input=input, capture_output=True, text=True, timeout=timeout, env=env)
    if check and p.returncode:
        msg = (p.stderr or p.stdout)[-2000:]
        for value in secret_values():
            msg = msg.replace(value, '[REDACTED]')
        raise SystemExit('FAILED ' + ' '.join(str(c) for c in cmd[:6]) + ': ' + msg)
    return p.stdout.strip()


# Builds da homologação num builder próprio limitado (o servidor tem 2 CPUs e atende a produção ao
# mesmo tempo): 1 CPU e 3 GB. Parecer do monitoramento 1/3 (23/10/2026), item 3.
BUILDER = 'biomie-hml-limitado'


def build(args, timeout=3600):
    if subprocess.run(['docker', 'buildx', 'inspect', BUILDER], capture_output=True).returncode:
        run(['docker', 'buildx', 'create', '--name', BUILDER, '--driver', 'docker-container',
             '--driver-opt', 'cpu-period=100000', '--driver-opt', 'cpu-quota=100000',
             '--driver-opt', 'memory=3g'])
    run(['docker', 'buildx', 'build', '--builder', BUILDER, '--load'] + args, timeout=timeout)
    # O cache deste builder não entra na limpeza semanal do Docker: guarda só a última semana.
    run(['docker', 'buildx', 'prune', '--builder', BUILDER, '--filter', 'until=168h', '-f'], check=False)


def read_env(path):
    if not path.exists():
        return {}
    return dict(line.split('=', 1) for line in path.read_text().splitlines() if '=' in line)


def secret_values():
    values = list(read_env(STACK_ENV).values()) + list(read_env(HML / 'hml.env').values())
    return [v for v in values if len(v) > 12]


def psql(sql, db=DB, timeout=1800):
    return run(PROD + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1',
                       '-At'], input=sql, timeout=timeout)


def b64url(data):
    return base64.urlsafe_b64encode(data).decode().rstrip('=')


def jwt(secret, role):
    now = int(time.time())
    header = b64url(json.dumps({'alg': 'HS256', 'typ': 'JWT'}, separators=(',', ':')).encode())
    payload = b64url(json.dumps({'role': role, 'iss': 'biomie-hml', 'iat': now, 'exp': now + 30 * 86400},
                                separators=(',', ':')).encode())
    signature = hmac.new(secret.encode(), f'{header}.{payload}'.encode(), hashlib.sha256).digest()
    return f'{header}.{payload}.{b64url(signature)}'


def write_private(path, text):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as handle:
        handle.write(text)
    os.chmod(path, 0o600)


def ensure_keys():
    env = read_env(HML_ENV)
    if not env.get('HML_JWT_SECRET'):
        secret = secrets.token_urlsafe(48)
        env = {'HML_JWT_SECRET': secret, 'HML_ANON_KEY': jwt(secret, 'anon'),
               'HML_SERVICE_KEY': jwt(secret, 'service_role'),
               'HML_JOB_TOKEN': secrets.token_urlsafe(32)}
        write_private(HML_ENV, ''.join(f'{k}={v}\n' for k, v in env.items()))
    return env


def db_exists():
    return psql(f"select count(*) from pg_database where datname = '{DB}'", db='postgres') == '1'


def db_refresh():
    """Cópia consistente da produção (pg_dump) restaurada em biomie_v2_hml; a produção só é lida."""
    if containers():
        raise SystemExit('Pare a homologação antes (down): a cópia em uso não pode ser trocada.')
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    dump = pathlib.Path('/var/backups/biomie-v2') / f'hml-source-{stamp}.dump'
    dump.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with dump.open('wb') as handle:
        os.chmod(dump, 0o600)
        p = subprocess.run(PROD + ['exec', '-T', 'db', 'pg_dump', '-U', 'postgres', '-d', 'biomie_v2',
                                   '--format=custom', '--compress=6'], stdout=handle, stderr=subprocess.PIPE,
                           timeout=1800)
    if p.returncode:
        raise SystemExit('pg_dump falhou')
    psql(f"select pg_terminate_backend(pid) from pg_stat_activity where datname = '{DB}';", db='postgres')
    psql(f'drop database if exists {DB};', db='postgres')
    psql(f'create database {DB};', db='postgres')
    with dump.open('rb') as handle:
        r = subprocess.run(PROD + ['exec', '-T', 'db', 'pg_restore', '-U', 'postgres', '-d', DB, '--exit-on-error'],
                           stdin=handle, capture_output=True, timeout=3600)
    if r.returncode:
        raise SystemExit('pg_restore falhou: ' + r.stderr.decode(errors='replace')[-1500:])
    dump.unlink()
    neutralize()
    return {'database': DB, 'copiedAt': stamp, 'size': psql(f"select pg_size_pretty(pg_database_size('{DB}'))", db='postgres')}


def neutralize():
    """Nada na cópia pode disparar trabalho externo: worker pausado, leituras e movimentações desligadas."""
    psql("""
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
select public.set_worker_control(true, null, 'homologacao: sem worker');
do $$
begin
  update private.stock_settings set reading_enabled = false;
  update private.stock_readings set status = 'failed', error = 'Cópia de homologação', next_attempt_at = null
    where status in ('queued', 'running');
  -- Tabelas e colunas da 0043 só existem depois da migração.
  if to_regclass('private.stock_movement_jobs') is not null then
    update private.stock_settings set movements_enabled = false;
    update private.stock_movement_jobs set status = 'failed', error = 'Cópia de homologação', next_attempt_at = null
      where status in ('queued', 'running');
  end if;
end $$;
""")
    # Limites da cópia no Postgres que ela divide com a produção (parecer de 23/10/2026, item 3): cada
    # consulta da homologação usa no máximo 1 núcleo e para em 5 minutos. Valem para as novas sessões
    # deste banco; a produção não muda.
    psql(f"alter database {DB} set max_parallel_workers_per_gather = 0;"
         f"alter database {DB} set statement_timeout = '300s';", db='postgres')


def gateway_conf(release, env):
    text = (release / 'deploy/vps/gateway.conf.template').read_text()
    text = text.replace('__ANON_KEY__', env['HML_ANON_KEY']).replace('__SERVICE_KEY__', env['HML_SERVICE_KEY'])
    text = text.replace('http://auth:9999', 'http://hml-auth:9999').replace('http://rest:3000', 'http://hml-rest:3000')
    if 'http://auth:' in text or 'http://rest:' in text or '__ANON_KEY__' in text or '__SERVICE_KEY__' in text:
        raise SystemExit('gateway da homologação ainda aponta para a produção')
    return text


EDGE_CONF = """
# Homologação: o papel do nginx público (site + /supabase/), só em 127.0.0.1.
server {
  listen 8080;
  server_tokens off;
  client_max_body_size 8m;
  location /supabase/ {
    proxy_pass http://hml-gateway:8001/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 120s;
  }
  location / {
    proxy_pass http://hml-web:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 120s;
  }
}
"""


def compose_yaml(image):
    path = '/supabase/auth/v1/verify'
    return f"""name: {PROJECT}
services:
  hml-auth:
    image: supabase/gotrue:v2.197.0
    restart: unless-stopped
    environment:
      GOTRUE_API_HOST: 0.0.0.0
      GOTRUE_API_PORT: 9999
      API_EXTERNAL_URL: {SITE}/supabase
      GOTRUE_DB_DRIVER: postgres
      GOTRUE_DB_DATABASE_URL: postgres://supabase_auth_admin:${{AUTH_DB_PASSWORD}}@db:5432/{DB}
      GOTRUE_SITE_URL: {SITE}
      GOTRUE_URI_ALLOW_LIST: {SITE}/**
      GOTRUE_DISABLE_SIGNUP: "true"
      GOTRUE_JWT_ADMIN_ROLES: service_role
      GOTRUE_JWT_AUD: authenticated
      GOTRUE_JWT_DEFAULT_GROUP_NAME: authenticated
      GOTRUE_JWT_EXP: 3600
      GOTRUE_JWT_SECRET: ${{HML_JWT_SECRET}}
      GOTRUE_JWT_ISSUER: {SITE}/supabase/auth/v1
      GOTRUE_EXTERNAL_EMAIL_ENABLED: "true"
      GOTRUE_MAILER_AUTOCONFIRM: "false"
      GOTRUE_EXTERNAL_PHONE_ENABLED: "false"
      GOTRUE_RATE_LIMIT_EMAIL_SENT: 10
      GOTRUE_RATE_LIMIT_HEADER: X-Real-IP
      GOTRUE_SMTP_HOST: ""
      GOTRUE_MAILER_URLPATHS_INVITE: {path}
      GOTRUE_MAILER_URLPATHS_CONFIRMATION: {path}
      GOTRUE_MAILER_URLPATHS_RECOVERY: {path}
      GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE: {path}
    networks: [hml, prod]
    mem_limit: 256m
    cpus: 0.25
  hml-rest:
    image: postgrest/postgrest:v14.18
    restart: unless-stopped
    environment:
      PGRST_DB_URI: postgres://authenticator:${{REST_DB_PASSWORD}}@db:5432/{DB}
      PGRST_DB_SCHEMAS: public
      PGRST_DB_ANON_ROLE: anon
      PGRST_JWT_SECRET: ${{HML_JWT_SECRET}}
      PGRST_DB_EXTRA_SEARCH_PATH: public,extensions
      PGRST_DB_MAX_ROWS: 10000
      PGRST_DB_POOL: 5
      PGRST_DB_POOL_ACQUISITION_TIMEOUT: 10
      PGRST_DB_TX_END: commit
    networks: [hml, prod]
    mem_limit: 256m
    cpus: 0.5
  hml-gateway:
    image: nginx:stable-alpine
    restart: unless-stopped
    depends_on: [hml-auth, hml-rest]
    ports: ["127.0.0.1:{GATEWAY_PORT}:8000"]
    volumes:
      - {HML / 'gateway.conf'}:/etc/nginx/conf.d/default.conf:ro
    networks: [hml]
    mem_limit: 64m
    cpus: 0.25
  hml-web:
    image: {image}
    restart: unless-stopped
    depends_on: [hml-gateway]
    environment:
      APP_ENV: production
      APP_BASE_URL: {SITE}
      PUBLIC_SUPABASE_URL: {SITE}/supabase
      SUPABASE_URL: http://hml-gateway:8000
      SUPABASE_PUBLISHABLE_KEY: ${{HML_ANON_KEY}}
      SUPABASE_SERVICE_ROLE_KEY: ${{HML_SERVICE_KEY}}
      BIOMIE_JOB_TOKEN: ${{HML_JOB_TOKEN}}
      BIOMIE_CREDENTIALS_KEY: ""
      BIOMIE_PROCESS_ROLE: web
      BIOMIE_ALLOW_HTTP_JOBS: "0"
      OMIE_GLOBAL_PER_MINUTE: 30
      OMIE_KEY_METHOD_PER_MINUTE: 10
      OMIE_MAX_CONCURRENT: 1
      OMIE_CIRCUIT_OPEN_MS: 1800000
      NODE_OPTIONS: --max-old-space-size=1024
    init: true
    networks: [hml]
    mem_limit: 1536m
    cpus: 0.5
  hml-edge:
    image: nginx:stable-alpine
    restart: unless-stopped
    depends_on: [hml-web, hml-gateway]
    ports: ["127.0.0.1:{SITE_PORT}:8080"]
    volumes:
      - {HML / 'edge.conf'}:/etc/nginx/conf.d/default.conf:ro
    networks: [hml]
    mem_limit: 64m
    cpus: 0.25
networks:
  hml: {{}}
  prod:
    external: true
    name: biomie-v2_default
"""


def containers():
    out = run(['docker', 'ps', '-a', '--filter', f'label=com.docker.compose.project={PROJECT}',
               '--format', '{{.Names}} {{.Status}}'], check=False)
    return [line for line in out.splitlines() if line.strip()]


def wait_site(seconds=180):
    deadline = time.time() + seconds
    status = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f'{SITE}/auth', timeout=5) as r:
                status = r.status
                if status == 200:
                    return status
        except (urllib.error.URLError, ConnectionError) as error:
            status = str(error)[:80]
        time.sleep(3)
    raise SystemExit(f'site da homologação não respondeu: {status}')


def up(short):
    release = BASE / 'releases' / short
    meta = json.loads((release / 'RELEASE.json').read_text())
    if not db_exists():
        raise SystemExit('Sem cópia do banco: rode db-refresh antes.')
    env = ensure_keys()
    started = time.time()
    # 1. Migrações da release na cópia (as mesmas da ativação; a produção não é tocada).
    psql((release / 'deploy/db/00_supabase_compat.sql').read_text())
    rendered = run(['python3', str(release / 'scripts/render-vps-migrations.py')])
    psql('set statement_timeout = 0;\n' + rendered)  # migrações não param no limite de 5 min da cópia
    neutralize()
    migrations = psql('select count(*) || \' / \' || max(name) from private.vps_schema_migrations;')
    # 2. Configurações da homologação (gateway com as chaves próprias e o "nginx público").
    write_private(HML / 'gateway.conf', gateway_conf(release, env))
    os.chmod(HML / 'gateway.conf', 0o644)
    (HML / 'edge.conf').write_text(EDGE_CONF)
    # 3. Imagem do web com o endereço e a chave pública da homologação embutidos no navegador.
    image = f'biomie-v2-web:hml-{short}'
    build(['-f', str(release / 'deploy/vps/Dockerfile'),
           '--build-arg', f'VITE_SUPABASE_URL={SITE}/supabase',
           '--build-arg', f"VITE_SUPABASE_PUBLISHABLE_KEY={env['HML_ANON_KEY']}",
           '--build-arg', f"GIT_COMMIT={meta['commit']}",
           '-t', image, str(release)], timeout=3600)
    (HML / 'compose.yml').write_text(compose_yaml(image))
    stack = read_env(STACK_ENV)
    merged = {'AUTH_DB_PASSWORD': stack['AUTH_DB_PASSWORD'], 'REST_DB_PASSWORD': stack['REST_DB_PASSWORD'], **env}
    write_private(COMPOSE_ENV, ''.join(f'{k}={v}\n' for k, v in merged.items()))
    run(HML_COMPOSE + ['up', '-d', '--remove-orphans'])
    status = wait_site()
    return {'site': SITE, 'gateway': f'http://127.0.0.1:{GATEWAY_PORT}', 'image': image,
            'commit': meta['commit'], 'migrations': migrations, 'login_page': status,
            'containers': containers(), 'seconds': round(time.time() - started)}


def oneoff(args, timeout):
    """Contêiner avulso da imagem da homologação, na rede dela, com as chaves dela e a chave das
    credenciais do Omie (para LER o Omie); o arquivo de ambiente é apagado em seguida."""
    image = run(['docker', 'inspect', f'{PROJECT}-hml-web-1', '--format', '{{.Config.Image}}'])
    stack, env = read_env(STACK_ENV), read_env(HML_ENV)
    values = {'SUPABASE_URL': 'http://hml-gateway:8000', 'SUPABASE_SERVICE_ROLE_KEY': env['HML_SERVICE_KEY'],
              'SUPABASE_PUBLISHABLE_KEY': env['HML_ANON_KEY'],
              'BIOMIE_CREDENTIALS_KEY': stack.get('BIOMIE_CREDENTIALS_KEY', ''),
              'APP_ENV': 'production', 'BIOMIE_PROCESS_ROLE': 'worker', 'OMIE_GLOBAL_PER_MINUTE': '30',
              'OMIE_KEY_METHOD_PER_MINUTE': '10', 'OMIE_MAX_CONCURRENT': '1', 'OMIE_CIRCUIT_OPEN_MS': '1800000'}
    env_file = HML / 'oneoff.env'
    write_private(env_file, ''.join(f'{k}={v}' + chr(10) for k, v in values.items()))
    try:
        p = subprocess.run(['docker', 'run', '--rm', '--network', f'{PROJECT}_hml', '--env-file', str(env_file),
                            image, 'node'] + args, capture_output=True, text=True, timeout=timeout)
    finally:
        env_file.unlink(missing_ok=True)
    out = p.stdout[-30000:]
    for value in secret_values():
        out = out.replace(value, '[REDACTED]')
    return {'exit': p.returncode, 'stdout': out, 'stderr': p.stderr[-1500:]}


def intel_run(args, timeout):
    """BIOMIE Intelligence (Python) na cópia: imagem própria da release em uso, contêiner avulso na rede
    da homologação, só com a chave de serviço DELA, 0,5 CPU e 512 MB; não fala com o Omie."""
    web_image = run(['docker', 'inspect', f'{PROJECT}-hml-web-1', '--format', '{{.Config.Image}}'])
    short = web_image.rsplit('hml-', 1)[-1]
    release = BASE / 'releases' / short
    meta = json.loads((release / 'RELEASE.json').read_text())
    image = f'biomie-v2-intel:hml-{short}'
    started = time.time()
    build(['-f', str(release / 'intelligence/Dockerfile'), '--build-arg', f"GIT_COMMIT={meta['commit']}",
           '-t', image, str(release)], timeout=1800)
    built = round(time.time() - started)
    env = read_env(HML_ENV)
    env_file = HML / 'intel.env'
    write_private(env_file, f"SUPABASE_URL=http://hml-gateway:8000\nSUPABASE_SERVICE_ROLE_KEY={env['HML_SERVICE_KEY']}\n"
                            'BIOMIE_INTEL_MAX_SECONDS=1200\n')
    started = time.time()
    try:
        p = subprocess.run(['docker', 'run', '--rm', '--network', f'{PROJECT}_hml', '--cpus', '0.5', '--memory', '512m',
                            '--env-file', str(env_file), image] + args, capture_output=True, text=True, timeout=timeout)
    finally:
        env_file.unlink(missing_ok=True)
    out = p.stdout[-30000:]
    err = p.stderr[-2000:]
    for value in secret_values():
        out, err = out.replace(value, '[REDACTED]'), err.replace(value, '[REDACTED]')
    return {'image': image, 'buildSeconds': built, 'runSeconds': round(time.time() - started), 'exit': p.returncode,
            'stdout': out, 'stderr': err}


def down():
    if (HML / 'compose.yml').exists() and COMPOSE_ENV.exists():
        run(HML_COMPOSE + ['down', '--remove-orphans'], check=False)
    return {'containers': containers()}


def drop():
    result = down()
    if db_exists():
        psql(f"select pg_terminate_backend(pid) from pg_stat_activity where datname = '{DB}';", db='postgres')
        psql(f'drop database if exists {DB};', db='postgres')
    images = run(['docker', 'images', 'biomie-v2-web', '--format', '{{.Tag}}'], check=False).split()
    for tag in images:
        if tag.startswith('hml-'):
            run(['docker', 'rmi', f'biomie-v2-web:{tag}'], check=False)
    if HML.exists():
        shutil.rmtree(HML)
    result.update({'database': db_exists(), 'hmlDir': HML.exists()})
    return result


def status():
    info = {'containers': containers(), 'database': db_exists()}
    if info['database']:
        info['size'] = psql(f"select pg_size_pretty(pg_database_size('{DB}'))", db='postgres')
        info['migrations'] = psql('select count(*) || \' / \' || max(name) from private.vps_schema_migrations;')
        info['worker'] = psql("select value from private.app_settings where key = 'worker.control';")
        info['stock'] = psql("select json_build_object('mode', (select mode from private.feature_flags where key = 'stock'),"
                             " 'reading', reading_enabled, 'movements', movements_enabled) from private.stock_settings;")
    try:
        with urllib.request.urlopen(f'{SITE}/auth', timeout=5) as r:
            info['login_page'] = r.status
    except Exception as error:  # noqa: BLE001 - só informativo
        info['login_page'] = str(error)[:80]
    return info


command = sys.argv[1] if len(sys.argv) > 1 else 'status'
if command == 'db-refresh':
    out = db_refresh()
elif command == 'up':
    if len(sys.argv) < 3:
        raise SystemExit('uso: up <release-short-sha>')
    out = up(sys.argv[2])
elif command == 'down':
    out = down()
elif command == 'drop':
    out = drop()
elif command == 'status':
    out = status()
elif command == 'movements-probe':
    if len(sys.argv) < 3:
        raise SystemExit('uso: movements-probe <empresa-slug> [dias]')
    out = oneoff(['.output/stock-movements-probe.mjs', sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else '30'], 300)
elif command == 'movements-load':
    minutes = sys.argv[2] if len(sys.argv) > 2 else '90'
    if not minutes.isdigit():
        raise SystemExit('minutos: número inteiro')
    out = oneoff(['.output/stock-movements-load.mjs', f'--minutes={minutes}'], int(minutes) * 60 + 600)
elif command == 'intel-run':
    out = intel_run(sys.argv[2:] or ['run', '--trigger', 'ops', '--force'], 1800)
else:
    raise SystemExit(__doc__)
print(json.dumps(out, indent=1, ensure_ascii=False, default=str))
