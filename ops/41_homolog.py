"""HOMOLOGAÇÃO isolada da produção: banco, login, API e site próprios, só em 127.0.0.1.

    python ops/remote.py ops/41_homolog.py db-refresh               # copia a produção para biomie_v2_hml
    python ops/remote.py ops/41_homolog.py up <release-short-sha>   # migra a cópia e sobe a release
    python ops/remote.py ops/41_homolog.py status
    python ops/remote.py ops/41_homolog.py down                     # para os contêineres (a cópia fica)
    python ops/remote.py ops/41_homolog.py drop                     # apaga contêineres, cópia, chaves e imagem
    python ops/remote.py ops/41_homolog.py movements-probe <empresa-slug> [dias]   # 1 página do Omie, nada gravado
    python ops/remote.py ops/41_homolog.py movements-load [minutos]   # processa a fila de movimentações
                                                                      # da cópia (só LÊ o Omie)
    python ops/remote.py ops/41_homolog.py suppliers-load [minutos]   # fornecedores do Omie (Produto x
                                                                      # Fornecedor) na cópia (só LÊ o Omie)
    python ops/remote.py ops/41_homolog.py intel-run [args do motor]  # BIOMIE Intelligence na cópia
                                                                      # (ex.: run --trigger ops --force)
    python ops/remote.py ops/41_homolog.py tx-probe <release> <empresa-slug> <entidades> [dias]
        # ciclo REAL de cargas de uma empresa com o código de uma release (ex.: correção da MAG Matriz):
        # lê o Omie com a chave da empresa (a mesma da produção) e grava só na cópia; espera os minutos
        # :10–:14 ou :40–:44 sem carga dessa empresa na produção, para não disputar a chave

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
  -- Importação de fornecedores (0048): só pelo comando suppliers-load, nunca pela agenda da cópia.
  if to_regclass('private.stock_supplier_jobs') is not null then
    update private.stock_settings set suppliers_enabled = false;
    update private.stock_supplier_jobs set status = 'failed', error = 'Cópia de homologação', next_attempt_at = null
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


def oneoff(args, timeout, image=None, extra=None):
    """Contêiner avulso da imagem da homologação, na rede dela, com as chaves dela e a chave das
    credenciais do Omie (para LER o Omie); o arquivo de ambiente é apagado em seguida."""
    image = image or run(['docker', 'inspect', f'{PROJECT}-hml-web-1', '--format', '{{.Config.Image}}'])
    stack, env = read_env(STACK_ENV), read_env(HML_ENV)
    values = {'SUPABASE_URL': 'http://hml-gateway:8000', 'SUPABASE_SERVICE_ROLE_KEY': env['HML_SERVICE_KEY'],
              'SUPABASE_PUBLISHABLE_KEY': env['HML_ANON_KEY'],
              'BIOMIE_CREDENTIALS_KEY': stack.get('BIOMIE_CREDENTIALS_KEY', ''),
              'APP_ENV': 'production', 'BIOMIE_PROCESS_ROLE': 'worker', 'OMIE_GLOBAL_PER_MINUTE': '30',
              'OMIE_KEY_METHOD_PER_MINUTE': '10', 'OMIE_MAX_CONCURRENT': '1', 'OMIE_CIRCUIT_OPEN_MS': '1800000'}
    values.update(extra or {})
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


PROBE_CONTAINER = 'biomie-hml-txprobe'


def key_conflicts(slug):
    """Uso real da chave do Omie dessa empresa pela PRODUÇÃO agora (só leitura no banco da produção):
    cargas, jobs de carga, leituras de estoque (inclusive longas) e importação de movimentações."""
    row = psql(f"""select concat_ws(' | ',
      (select 'carga em andamento: ' || string_agg(r.entity, ',') from public.integration_sync_runs r
        where r.company_id = c.id and r.status = 'RUNNING'),
      (select 'job de carga em andamento: ' || count(*) from public.integration_backfill_jobs j
        where j.company_id = c.id and j.status = 'RUNNING' having count(*) > 0),
      (select 'leitura de estoque: ' || string_agg(s.status, ',') from private.stock_readings s
        where s.company_id = c.id and s.status in ('queued', 'running')),
      (select 'movimentações: ' || string_agg(m.status, ',') from private.stock_movement_jobs m
        where m.company_id = c.id and m.status = 'running'))
      from public.companies c where c.slug = '{slug}';""", db='biomie_v2')
    return [part for part in row.split(' | ') if part.strip()]


SUPPLIER_JOB = """select coalesce((select json_build_object('status', j.status, 'pages', j.pages_done,
    'pagesTotal', j.pages_total, 'suppliers', j.suppliers_saved, 'links', j.links_saved, 'error', j.error)
  from private.stock_supplier_jobs j where j.company_id = '{company}' order by j.created_at desc limit 1), '{{}}'::json);"""


def close_supplier_jobs(company, others=False):
    """Fecha na CÓPIA a importação aberta de uma empresa (ou de todas as outras): o passo do worker pega a mais
    antiga de QUALQUER empresa, e cada chave só pode ser usada na janela conferida para ela."""
    where = f"company_id <> '{company}'" if others else f"company_id = '{company}'"
    return int(psql(f"""with closed as (update private.stock_supplier_jobs set status = 'failed',
        finished_at = clock_timestamp(), error = 'fechada pela homologação: uma empresa por vez, só na janela da chave'
      where status in ('queued', 'running') and {where} returning 1) select count(*) from closed;""") or 0)


def suppliers_load(total_minutes):
    """Fornecedores do Omie na cópia, EMPRESA POR EMPRESA (a chave de cada uma é a mesma da produção): cada
    importação só começa nos minutos :10–:14 ou :40–:44, sem uso real da chave daquela empresa pela produção, e
    termina 1 minuto antes das cargas :21/:51. Empresa sem janela livre no prazo total fica registrada (as outras
    seguem); importação que não terminou na janela é fechada na cópia e recomeça na próxima."""
    import re
    rows = psql("""select string_agg(c.slug || ':' || c.id, ' ' order by c.slug) from public.companies c
      join public.company_integrations ci on ci.company_id = c.id
      where ci.provider = 'omie' and ci.status = 'CONNECTED' and not c.is_demo;""", db='biomie_v2').split()
    pending = {}
    for item in rows:
        slug, _, company = item.partition(':')
        if re.fullmatch(r'[a-z0-9-]{2,40}', slug) and re.fullmatch(r'[0-9a-f-]{36}', company):
            pending[slug] = company
    results = {slug: {'attempts': []} for slug in pending}
    deadline = time.time() + total_minutes * 60
    while pending and time.time() < deadline:
        if not 10 <= datetime.datetime.now().minute % 30 <= 14:
            time.sleep(20)
            continue
        for slug in sorted(pending):
            now = datetime.datetime.now()
            seconds_left = (20 - now.minute % 30) * 60 - now.second - 60
            if seconds_left < 150 or time.time() > deadline:
                break
            attempt = {'at': now.isoformat(timespec='seconds')}
            conflicts = key_conflicts(slug)
            if conflicts:
                results[slug]['attempts'].append({**attempt, 'conflicts': conflicts})
                continue
            company = pending[slug]
            attempt['closedOthers'] = close_supplier_jobs(company, others=True)
            minutes = max(2, seconds_left // 60)
            started = time.time()
            res = oneoff(['.output/stock-suppliers-load.mjs', f'--minutes={minutes}', f'--empresa={company}'],
                         minutes * 60 + 180)
            events = [json.loads(l) for l in res['stdout'].splitlines() if l.startswith('{"event":"load_')]
            end = next((e for e in events if e.get('event') == 'load_end'), {})
            job = json.loads(psql(SUPPLIER_JOB.format(company=company)) or '{}')
            attempt.update({'seconds': round(time.time() - started), 'exit': res['exit'], 'tally': end.get('tally'),
                            'timedOut': end.get('timedOut'), 'job': job,
                            'stderr': res['stderr'][-300:] if res['exit'] else None})
            if job.get('status') in ('complete', 'failed'):
                results[slug]['final'] = job['status']
                del pending[slug]
            else:
                attempt['closedAtWindowEnd'] = close_supplier_jobs(company)
            results[slug]['attempts'].append(attempt)
        while 10 <= datetime.datetime.now().minute % 30 <= 14:
            time.sleep(20)
    for slug in pending:
        results[slug]['final'] = 'sem janela livre da chave no prazo'
    after = psql("""select json_build_object('suppliers', (select count(*) from private.stock_suppliers),
      'links', (select count(*) from private.stock_product_suppliers),
      'jobs', (select json_agg(json_build_object('company', c.slug, 'status', j.status, 'pages', j.pages_done,
         'suppliers', j.suppliers_saved, 'links', j.links_saved, 'removed', j.links_removed, 'error', j.error))
         from (select distinct on (company_id) * from private.stock_supplier_jobs order by company_id, created_at desc) j
         join public.companies c on c.id = j.company_id));""")
    return {'companies': results, 'complete': sorted(s for s, r in results.items() if r.get('final') == 'complete'),
            'notLoaded': sorted(s for s, r in results.items() if r.get('final') != 'complete'),
            'after': json.loads(after) if after.startswith('{') else after}


def container_log_lines(name):
    """Linhas do contêiner direto do arquivo json-file (docker logs não é confiável neste servidor)."""
    path = run(['docker', 'inspect', '--format', '{{.LogPath}}', name], check=False)
    lines = []
    if path and os.path.exists(path):
        with open(path, encoding='utf-8', errors='replace') as handle:
            for raw in handle:
                try:
                    rec = json.loads(raw)
                except ValueError:
                    continue
                lines.extend((rec.get('time', ''), part) for part in rec.get('log', '').splitlines())
    return lines


def trace_metrics(events):
    """Ritmo real das chamadas: depois de cada resposta vazia, quanto tempo até a próxima chamada do
    mesmo método (a correção promete 12 s ou mais; o código antigo esperava 2 s)."""
    def stamp(value):
        return datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    by_call = {}
    for ev in events:
        by_call.setdefault(ev['call'], []).append(ev)
    out = {}
    for call, evs in by_call.items():
        evs.sort(key=lambda e: e['startedAt'])
        outcomes = {}
        for ev in evs:
            outcomes[ev['outcome']] = outcomes.get(ev['outcome'], 0) + 1
        gaps = {'afterEmpty': [], 'afterOk': [], 'afterBusy': []}
        for prev, nxt in zip(evs, evs[1:]):
            gap = round(stamp(nxt['startedAt']) - (stamp(prev['startedAt']) + prev['ms'] / 1000), 1)
            kind = ('afterEmpty' if prev['outcome'] in ('empty-list', 'empty-fault') else
                    'afterBusy' if prev['outcome'] == 'busy' else 'afterOk')
            gaps[kind].append(gap)
        first = stamp(evs[0]['startedAt'])
        last = stamp(evs[-1]['startedAt']) + evs[-1]['ms'] / 1000
        out[call] = {
            'calls': len(evs), 'outcomes': outcomes,
            'records': sum(ev['records'] or 0 for ev in evs),
            'seconds': round(last - first, 1),
            'emptyThenWaited12s': f"{sum(1 for g in gaps['afterEmpty'] if g >= 11.5)}/{len(gaps['afterEmpty'])}",
            'gapAfterEmpty': {'min': min(gaps['afterEmpty'], default=None), 'max': max(gaps['afterEmpty'], default=None)},
            'gapAfterOk': {'min': min(gaps['afterOk'], default=None), 'max': max(gaps['afterOk'], default=None)},
            'gapAfterBusy': gaps['afterBusy'],
            'apiMs': {'min': min(ev['ms'] for ev in evs), 'max': max(ev['ms'] for ev in evs)},
        }
    return out


def finance_snapshot(slug, since, db):
    """Contas a receber emitidas e baixas pagas no período, para comparar cópia × produção."""
    return json.loads(psql(f"""select json_build_object(
      'receivables', (select json_build_object('count', count(*), 'amount', round(coalesce(sum(r.original_amount), 0), 2),
                        'cancelled', count(*) filter (where r.cancelled_at is not null),
                        'missing', count(*) filter (where r.missing_in_source))
                      from public.canonical_receivables r where r.company_id = c.id and r.issue_date >= date '{since}'),
      'settlements', (select json_build_object('count', count(*), 'amount', round(coalesce(sum(s.amount), 0), 2))
                      from public.canonical_settlements s where s.company_id = c.id and s.settlement_date >= date '{since}'))
      from public.companies c where c.slug = '{slug}';""", db=db) or '{}')


def prod_worker_window(t0, t1):
    """O worker da produção no mesmo intervalo: erros, respostas "já existe" e pausas do circuito."""
    lines = [text for stamp, text in container_log_lines('biomie-v2-worker-1') if t0 <= stamp[:19] <= t1]
    return {'lines': len(lines),
            'errors': sum(1 for t in lines if '"tick_failed"' in t or '_failed"' in t),
            'busyAnswers': sum(1 for t in lines if 'Omie ainda processa outra' in t),
            'circuitPauses': sum(1 for t in lines if 'bloqueado temporariamente' in t)}


def tx_probe(short, slug, entities, days):
    """Ciclo real de cargas de UMA empresa com o código de uma release, na cópia, com rastreio de cada
    chamada ao Omie (omie-trace-sync). A chave do Omie é a mesma da produção, então (parecer de
    26/10/2026): só leitura (métodos Listar*), mesmos limites do worker da produção, começa só sem uso
    real da chave pela produção (e nos minutos :10–:14 ou :40–:44, longe das cargas :21/:51) e é
    encerrado na hora se aparecer conflito, bloqueio, consumo redundante, pausa do circuito ou mais de 2
    respostas "já existe uma requisição"."""
    import re
    if not re.fullmatch(r'[0-9a-f]{12}', short) or not re.fullmatch(r'[a-z0-9-]{2,40}', slug):
        raise SystemExit('uso: tx-probe <release-12> <empresa-slug> <entidades> [dias]')
    allowed = ['invoices', 'orders', 'receivables', 'settlements']
    picked = [e for e in entities.split(',') if e]
    if not picked or any(e not in allowed for e in picked) or not days.isdigit() or not 1 <= int(days) <= 400:
        raise SystemExit('entidades: invoices,orders,receivables,settlements; dias: 1 a 400')
    if run(['docker', 'inspect', '--format', '{{.State.Status}}', PROBE_CONTAINER], check=False) == 'running':
        raise SystemExit('outro tx-probe em andamento: um teste por vez na chave')
    release = BASE / 'releases' / short
    meta = json.loads((release / 'RELEASE.json').read_text())
    if not (release / 'scripts/omie-trace-sync.ts').exists():
        raise SystemExit('esta release não tem o rastreio (scripts/omie-trace-sync.ts)')
    image = f'biomie-v2-web:hml-{short}'
    built = 0
    if subprocess.run(['docker', 'image', 'inspect', image], capture_output=True).returncode:
        env = ensure_keys()
        started = time.time()
        build(['-f', str(release / 'deploy/vps/Dockerfile'),
               '--build-arg', f'VITE_SUPABASE_URL={SITE}/supabase',
               '--build-arg', f"VITE_SUPABASE_PUBLISHABLE_KEY={env['HML_ANON_KEY']}",
               '--build-arg', f"GIT_COMMIT={meta['commit']}",
               '-t', image, str(release)], timeout=3600)
        built = round(time.time() - started)
    # Começa só sem uso real da chave pela produção (e longe das cargas :21/:51).
    waited = time.time()
    deadline = waited + 45 * 60
    while True:
        conflicts = key_conflicts(slug)
        if 10 <= datetime.datetime.now().minute % 30 <= 14 and not conflicts:
            break
        if time.time() > deadline:
            raise SystemExit(f'sem janela livre da chave em 45 min: {conflicts}')
        time.sleep(20)
    since = (datetime.date.today() - datetime.timedelta(days=int(days))).isoformat()
    stack, env = read_env(STACK_ENV), read_env(HML_ENV)
    values = {'SUPABASE_URL': 'http://hml-gateway:8000', 'SUPABASE_SERVICE_ROLE_KEY': env['HML_SERVICE_KEY'],
              'SUPABASE_PUBLISHABLE_KEY': env['HML_ANON_KEY'],
              'BIOMIE_CREDENTIALS_KEY': stack.get('BIOMIE_CREDENTIALS_KEY', ''),
              'APP_ENV': 'production', 'BIOMIE_PROCESS_ROLE': 'worker',
              # mesmos limites do worker da produção, para o teste valer como o ciclo real
              'OMIE_GLOBAL_PER_MINUTE': '90', 'OMIE_KEY_METHOD_PER_MINUTE': '30', 'OMIE_MAX_CONCURRENT': '1',
              'OMIE_CIRCUIT_OPEN_MS': '1800000'}
    env_file = HML / 'txprobe.env'
    write_private(env_file, ''.join(f'{k}={v}' + chr(10) for k, v in values.items()))
    subprocess.run(['docker', 'rm', '-f', PROBE_CONTAINER], capture_output=True)
    t0 = datetime.datetime.now(datetime.timezone.utc)
    try:
        run(['docker', 'run', '-d', '--name', PROBE_CONTAINER, '--network', f'{PROJECT}_hml', '--cpus', '0.5',
             '--memory', '768m', '--env-file', str(env_file), image, 'node', '.output/omie-trace-sync.mjs',
             '--phase=transactions', f'--companies={slug}', f'--entities={",".join(picked)}',
             f'--from={since}', '--fresh'])
    finally:
        env_file.unlink(missing_ok=True)
    aborted = None
    limit = time.time() + 20 * 60
    while True:
        state = run(['docker', 'inspect', '--format', '{{.State.Status}}', PROBE_CONTAINER], check=False)
        text = '\n'.join(t for _, t in container_log_lines(PROBE_CONTAINER))
        busy = text.count('"outcome":"busy"')
        if '"outcome":"blocked"' in text or '"outcome":"redundant"' in text:
            aborted = 'bloqueio ou consumo redundante do Omie'
        elif 'bloqueado temporariamente' in text:
            aborted = 'pausa do circuito no teste'
        elif busy > 2:
            aborted = f'{busy} respostas "já existe uma requisição"'
        elif state == 'running' and key_conflicts(slug):
            aborted = 'produção começou a usar a chave: ' + '; '.join(key_conflicts(slug))
        elif state == 'running' and time.time() > limit:
            aborted = 'passou de 20 min'
        if aborted or state != 'running':
            break
        time.sleep(5)
    if aborted:
        subprocess.run(['docker', 'kill', PROBE_CONTAINER], capture_output=True)
        time.sleep(2)
    t1 = datetime.datetime.now(datetime.timezone.utc)
    exit_code = run(['docker', 'inspect', '--format', '{{.State.ExitCode}}', PROBE_CONTAINER], check=False)
    lines = [t for _, t in container_log_lines(PROBE_CONTAINER)]
    subprocess.run(['docker', 'rm', '-f', PROBE_CONTAINER], capture_output=True)
    events, other = [], []
    for line in lines:
        try:
            rec = json.loads(line)
        except ValueError:
            other.append(line)
            continue
        if rec.get('event') == 'omie_call':
            events.append(rec)
        else:
            other.append(line)
    final = [line for line in other if '"job":"omie_trace_sync"' in line]
    tail = '\n'.join(line for line in other if '"job":"omie_trace_sync"' not in line)[-2500:]
    for value in secret_values():
        tail = tail.replace(value, '[REDACTED]')
    w0, w1 = t0.strftime('%Y-%m-%dT%H:%M:%S'), t1.strftime('%Y-%m-%dT%H:%M:%S')
    return {'release': short, 'commit': meta['commit'], 'company': slug, 'entities': picked, 'from': since,
            'buildSeconds': built, 'waitedForSlotSeconds': round(t0.timestamp() - waited),
            'startedUtc': w0, 'finishedUtc': w1, 'seconds': round((t1 - t0).total_seconds()),
            'exit': exit_code, 'aborted': aborted, 'result': final[-1] if final else None,
            'calls': len(events), 'byMethod': trace_metrics(events),
            'retries': sum(1 for t in other if 'omie retry call=' in t),
            'finance': {'copy': finance_snapshot(slug, since, DB), 'production': finance_snapshot(slug, since, 'biomie_v2')},
            'productionWorker': prod_worker_window(w0, w1),
            'timeline': [{k: e[k] for k in ('startedAt', 'call', 'outcome', 'records', 'ms', 'params')} for e in events][-60:],
            'tail': tail}


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
elif command == 'suppliers-load':
    minutes = sys.argv[2] if len(sys.argv) > 2 else '90'
    if not minutes.isdigit() or not 5 <= int(minutes) <= 240:
        raise SystemExit('minutos: prazo total, de 5 a 240')
    out = suppliers_load(int(minutes))
elif command == 'tx-probe':
    if len(sys.argv) < 5:
        raise SystemExit('uso: tx-probe <release-12> <empresa-slug> <entidades> [dias]')
    out = tx_probe(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5] if len(sys.argv) > 5 else '62')
elif command == 'intel-run':
    out = intel_run(sys.argv[2:] or ['run', '--trigger', 'ops', '--force'], 1800)
else:
    raise SystemExit(__doc__)
print(json.dumps(out, indent=1, ensure_ascii=False, default=str))
