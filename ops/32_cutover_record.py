"""Record exactly what is live, right before (or after) the public cutover.

    python ops/remote.py ops/32_cutover_record.py <label>

Writes /opt/biomie-v2/ops/cutover-record-<stamp>-<label>.json (root-only) and prints
it: commit, release, image, migration version, containers, config checksums
(never contents), nginx state, newest backups and worker state. No secret values.
"""
import datetime
import hashlib
import json
import os
import pathlib
import subprocess
import sys

BASE = pathlib.Path('/opt/biomie-v2')
ENV = BASE / 'shared' / 'stack.env'
COMPOSE = ['docker', 'compose', '--env-file', str(ENV), '-f', str(BASE / 'compose.yml')]
label = sys.argv[1] if len(sys.argv) > 1 else 'record'
env = dict(l.split('=', 1) for l in ENV.read_text().splitlines() if '=' in l and not l.startswith('#'))


def run(cmd, timeout=120):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return p.stdout.strip() if p.returncode == 0 else 'ERROR: ' + p.stderr.strip()[-300:]


def psql(query):
    return run(COMPOSE + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', 'biomie_v2', '-At', '-c', query])


def sha(path):
    p = pathlib.Path(path)
    return hashlib.sha256(p.read_bytes()).hexdigest()[:16] if p.exists() else None


now = datetime.datetime.now().astimezone()
release = pathlib.Path(env['SOURCE_DIR'])
record = {
    'label': label,
    'at_local': now.isoformat(timespec='seconds'),
    'at_utc': now.astimezone(datetime.timezone.utc).isoformat(timespec='seconds'),
    'release_id': env.get('RELEASE_ID'),
    'git_commit': env.get('BIOMIE_GIT_COMMIT'),
    'release_json': json.loads((release / 'RELEASE.json').read_text()) if (release / 'RELEASE.json').exists() else None,
    'image': run(['docker', 'image', 'inspect', '--format',
                  '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}', f"biomie-v2-web:{env.get('RELEASE_ID')}"]),
    'migrations': psql("select count(*)||' / '||max(name) from private.vps_schema_migrations;"),
    'containers': run(['docker', 'ps', '--filter', 'name=biomie-v2', '--format', '{{.Names}} {{.Image}} {{.Status}}']).splitlines(),
    'config_sha256_16': {
        'compose.yml': sha(BASE / 'compose.yml'),
        'stack.env (hash only)': sha(ENV),
        'gateway.conf': sha(env.get('GATEWAY_CONFIG', '')) if env.get('GATEWAY_CONFIG') else None,
        'nginx site': sha('/etc/nginx/sites-enabled/biomie.magmoveiscorporativos.com.br'),
        'nginx conf.d/biomie-v2.conf': sha('/etc/nginx/conf.d/biomie-v2.conf'),
        'nginx security headers': sha('/etc/nginx/snippets/biomie-v2-security-headers.conf'),
        'nginx api locations': sha('/etc/nginx/snippets/biomie-v2-api-locations.conf'),
        'legacy site saved for rollback': sha(BASE / 'ops/nginx/legacy-site.conf'),
    },
    'nginx_active': 'v2' if '# BIOMIE v2 public site' in pathlib.Path(
        '/etc/nginx/sites-enabled/biomie.magmoveiscorporativos.com.br').read_text() else 'legacy',
    'backups': json.loads(run(['python3', str(BASE / 'bin/backup.py'), 'status']) or '{}'),
    'worker_control': psql("select value from private.app_settings where key='worker.control';"),
    'worker_status': psql("select value from private.app_settings where key='worker.status';"),
    'companies': psql("select string_agg(slug||':'||data_source, ', ' order by slug) from public.companies where not is_demo;"),
}
out = BASE / 'ops' / f"cutover-record-{now.strftime('%Y%m%d-%H%M%S')}-{label}.json"
out.write_text(json.dumps(record, indent=1, ensure_ascii=False, default=str))
os.chmod(out, 0o600)
record['file'] = str(out)
print(json.dumps(record, indent=1, ensure_ascii=False, default=str))
