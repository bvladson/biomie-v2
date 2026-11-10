"""Activate a release on the v2 stack (homologation; the public site is untouched).

    python ops/remote.py ops/21_activate_release.py <release-short-sha> [--start-worker]

1. Points stack.env at the release (RELEASE_ID, SOURCE_DIR, BIOMIE_GIT_COMMIT).
2. Takes a verified pg_dump BEFORE migrations.
3. Applies migrations (checksummed, idempotent) and production settings:
   DEMO hidden, worker paused until acceptance.
4. Builds the image tagged with the commit and checks its revision label.
5. Recreates web (and the worker when requested) and checks health.
"""
import datetime
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time

BASE = pathlib.Path('/opt/biomie-v2')
SHORT = sys.argv[1]
START_WORKER = '--start-worker' in sys.argv
REL = BASE / 'releases' / SHORT
ENV = BASE / 'shared' / 'stack.env'
COMPOSE = ['docker', 'compose', '--env-file', str(ENV), '-f', str(BASE / 'compose.yml')]
STACKCTL = ['python3', str(REL / 'deploy/vps/stackctl.py')]
report = {'release': SHORT, 'started': datetime.datetime.now().isoformat()}


def secrets():
    return [v for v in (line.split('=', 1)[1] for line in ENV.read_text().splitlines() if '=' in line) if len(v) > 12]


def run(cmd, input=None, timeout=900, stdout=None):
    p = subprocess.run(cmd, input=input, capture_output=stdout is None, stdout=stdout, text=True,
                       timeout=timeout, env={**os.environ, 'BIOMIE_V2_BASE': str(BASE)})
    if p.returncode:
        msg = ((p.stderr or '') + (p.stdout or ''))[-2500:]
        for value in secrets():
            msg = msg.replace(value, '[REDACTED]')
        raise SystemExit('FAILED ' + ' '.join(str(c) for c in cmd[:5]) + ': ' + msg)
    return (p.stdout or '').strip()


def psql(sql, db='biomie_v2'):
    return run(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1',
                          '-At'], input=sql, timeout=1200)


def wait_healthy(container, seconds=240):
    deadline = time.time() + seconds
    state = ''
    while time.time() < deadline:
        state = subprocess.run(['docker', 'inspect', '--format',
                                '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
                                container], capture_output=True, text=True).stdout.strip()
        if state == 'healthy':
            return state
        time.sleep(4)
    raise SystemExit(f'{container} not healthy: {state}')


meta = json.loads((REL / 'RELEASE.json').read_text())
report['commit'] = meta['commit']

# 1. Release pointers and configuration from the release itself.
run(STACKCTL + ['set', f'RELEASE_ID={SHORT}', f'SOURCE_DIR={REL}', f"BIOMIE_GIT_COMMIT={meta['commit']}"])
shutil.copy2(REL / 'deploy/vps/compose.yml', BASE / 'compose.yml')

# 1b. Rede do assistente MAG AI: o compose referencia mag-ai_biomie (external). Sem o MAG AI
# instalado, criamos a rede vazia com as mesmas opções (interna, ponte sem endereço do servidor)
# para o BIOMIE nunca deixar de subir por causa da IA.
if subprocess.run(['docker', 'network', 'inspect', 'mag-ai_biomie'], capture_output=True).returncode:
    run(['docker', 'network', 'create', '--internal',
         '-o', 'com.docker.network.bridge.inhibit_ipv4=true',
         '--label', 'br.com.mag.projeto=mag-ai', 'mag-ai_biomie'])
    report['mag_ai_network'] = 'criada vazia (MAG AI ausente)'
else:
    report['mag_ai_network'] = 'existente'

run(STACKCTL + ['render-gateway'])
run(STACKCTL + ['check'])

# 2. Verified backup before touching the schema.
backups = pathlib.Path('/var/backups/biomie-v2')
backups.mkdir(mode=0o700, parents=True, exist_ok=True)
dump = backups / f"pre-migrate-{SHORT}-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}.dump"
with dump.open('wb') as handle:
    os.chmod(dump, 0o600)
    p = subprocess.run(COMPOSE + ['exec', '-T', 'db', 'pg_dump', '-U', 'postgres', '-d', 'biomie_v2',
                                  '--format=custom', '--compress=6'], stdout=handle, stderr=subprocess.PIPE,
                       timeout=1800)
if p.returncode:
    raise SystemExit('pre-migration backup failed')
with dump.open('rb') as handle:
    listing = subprocess.run(COMPOSE + ['exec', '-T', 'db', 'pg_restore', '--list'], stdin=handle,
                             capture_output=True, timeout=300)
if listing.returncode or b'TABLE DATA' not in listing.stdout:
    raise SystemExit('pre-migration backup is not restorable')
report['pre_migration_backup'] = {'path': str(dump), 'bytes': dump.stat().st_size}

# 3. Migrations + production settings.
psql((REL / 'deploy/db/00_supabase_compat.sql').read_text())
rendered = run(['python3', str(REL / 'scripts/render-vps-migrations.py')])
psql(rendered)
report['migrations'] = psql('select count(*)||\' / \'||max(name) from private.vps_schema_migrations;')
psql("""
select set_config('request.jwt.claims','{"role":"service_role"}',false);
select public.set_demo_visibility(false);
select public.set_worker_control(true, null, 'aguardando homologacao da release');
notify pgrst, 'reload schema';
""")
report['settings'] = psql("""
select json_build_object('demo_visible', public.demo_companies_visible(),
  'worker_control', (select value from private.app_settings where key='worker.control'),
  'integrations', (select json_agg(json_build_object('company', c.slug, 'status', i.status) order by c.slug)
                   from public.company_integrations i join public.companies c on c.id=i.company_id));
""").splitlines()[-1]

# 4. Image built from the release, carrying its commit.
log = BASE / 'ops' / f'build-{SHORT}.log'
with log.open('w') as handle:
    build = subprocess.run(COMPOSE + ['build', 'web'], stdout=handle, stderr=subprocess.STDOUT, text=True,
                           timeout=1800)
if build.returncode:
    tail = log.read_text()[-3000:]
    for value in secrets():
        tail = tail.replace(value, '[REDACTED]')
    raise SystemExit('build failed:\n' + tail)
label = run(['docker', 'image', 'inspect', f'biomie-v2-web:{SHORT}', '--format',
             '{{index .Config.Labels "org.opencontainers.image.revision"}}'])
if label != meta['commit']:
    raise SystemExit(f'image revision label mismatch: {label}')
report['image'] = {'tag': f'biomie-v2-web:{SHORT}', 'revision': label,
                   'id': run(['docker', 'image', 'inspect', f'biomie-v2-web:{SHORT}', '--format', '{{.Id}}'])[:19]}

# 5. Services.
run(COMPOSE + ['up', '-d', '--no-build', '--no-deps', 'gateway'])
run(COMPOSE + ['up', '-d', '--no-build', '--no-deps', 'web'])
report['web'] = wait_healthy('biomie-v2-web-1')
if START_WORKER:
    run(COMPOSE + ['up', '-d', '--no-build', '--no-deps', 'worker'])
    time.sleep(45)
    report['worker'] = run(['docker', 'inspect', '--format', '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',
                            'biomie-v2-worker-1'])
    report['worker_status'] = psql("select value from private.app_settings where key='worker.status';")
report['containers'] = run(['docker', 'ps', '--filter', 'name=biomie-v2', '--format', '{{.Names}} {{.Image}} {{.Status}}'])
report['finished'] = datetime.datetime.now().isoformat()
print(json.dumps(report, indent=2, ensure_ascii=False))
