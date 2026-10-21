#!/usr/bin/env python3
"""BIOMIE v2 backups (installed at /opt/biomie-v2/bin/backup.py; Python 3 stdlib + docker + gpg).

    backup.py run [--no-offsite]          encrypted bundle -> local store -> offsite (sha256 verified)
    backup.py restore-test [--offsite]    decrypt latest (or download it from offsite) and restore it
                                          into an isolated temporary PostgreSQL (network none)
    backup.py status

Bundle = pg_dump (custom) of biomie_v2 + roles (globals) + stack.env + gateway +
compose + nginx files + active RELEASE.json. Encrypted with gpg AES256 using the
passphrase in /opt/biomie-v2/shared/backup.passphrase BEFORE leaving the
process; nothing is stored or sent in plaintext. Keep a copy of the passphrase
outside the VPS: without it no backup can be restored.
Retention: 30 days locally and offsite (at least the newest bundle is kept).
Offsite destination: /opt/biomie-v2/shared/offsite.conf (HOST, PORT, USER, KEY lines;
KEY is the path of the ssh key, no secret in the file). Until that file exists the
destination is read from the legacy BIomie backup script, as before.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

BASE = pathlib.Path('/opt/biomie-v2')
ENV = BASE / 'shared' / 'stack.env'
PASSPHRASE = BASE / 'shared' / 'backup.passphrase'
STORE = pathlib.Path('/var/backups/biomie-v2')
STATE = BASE / 'ops' / 'backup-state.json'
COMPOSE = ['docker', 'compose', '--env-file', str(ENV), '-f', str(BASE / 'compose.yml')]
OFFSITE_CONF = BASE / 'shared' / 'offsite.conf'
# Fallback only while the legacy BIomie exists (it is being retired).
LEGACY_BACKUP = pathlib.Path('/var/www/biomie/live/cron/hostinger/db_backup.sh')
OFFSITE_DIR = 'backups/biomie-v2-db'
RETENTION_DAYS = 30
NAME = re.compile(r'^biomie-v2-\d{8}T\d{6}Z\.tar\.gpg$')


def log(event, **fields):
    print(json.dumps({'at': dt.datetime.now(dt.timezone.utc).isoformat(), 'event': event, **fields}), flush=True)


def run(cmd, **kw):
    kw.setdefault('capture_output', True)
    kw.setdefault('text', True)
    p = subprocess.run(cmd, **kw)
    if p.returncode:
        raise RuntimeError(f'{cmd[0]} failed ({p.returncode})')
    return p


def state():
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def save_state(**fields):
    data = state() | fields
    tmp = STATE.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, indent=2))
    os.chmod(tmp, 0o600)
    os.replace(tmp, STATE)


def passphrase() -> pathlib.Path:
    if not PASSPHRASE.exists():
        fd = os.open(PASSPHRASE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as handle:
            handle.write(secrets.token_hex(32))
        log('passphrase_created', fingerprint=hashlib.sha256(PASSPHRASE.read_bytes()).hexdigest()[:10])
    os.chmod(PASSPHRASE, 0o600)
    return PASSPHRASE


def offsite_config():
    values = {}
    if OFFSITE_CONF.exists():
        source = 'offsite.conf'
        for line in OFFSITE_CONF.read_text().splitlines():
            key, sep, value = line.strip().partition('=')
            if sep and key in ('HOST', 'PORT', 'USER', 'KEY'):
                values[key] = value.strip().strip('"')
    elif LEGACY_BACKUP.exists():
        source = 'legacy-script'
        text = LEGACY_BACKUP.read_text()
        for key in ('HOST', 'PORT', 'USER', 'KEY'):
            m = re.search(r'^OFFSITE_' + key + r'="\$\{BIOMIE_OFFSITE_' + key + r':-([^}]*)\}"', text, re.M)
            if m:
                values[key] = m.group(1)
    else:
        return None
    if len(values) != 4 or not pathlib.Path(values['KEY']).is_file():
        return None
    return {**values, 'SOURCE': source}


def ssh_base(cfg):
    return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'StrictHostKeyChecking=accept-new',
            '-i', cfg['KEY']]


def offsite_ssh(cfg, command):
    return run(['ssh', *ssh_base(cfg), '-p', cfg['PORT'], f"{cfg['USER']}@{cfg['HOST']}", command], timeout=300)


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def bundles():
    if not STORE.exists():
        return []
    return sorted(p for p in STORE.iterdir() if p.is_file() and NAME.match(p.name))


def build_bundle(workdir: pathlib.Path) -> pathlib.Path:
    bundle = workdir / 'bundle'
    bundle.mkdir(mode=0o700)
    with (bundle / 'database.dump').open('wb') as handle:
        p = subprocess.run(COMPOSE + ['exec', '-T', 'db', 'pg_dump', '-U', 'postgres', '-d', 'biomie_v2',
                                      '--format=custom', '--compress=6'], stdout=handle, stderr=subprocess.PIPE,
                           timeout=3600)
    if p.returncode:
        raise RuntimeError('pg_dump failed')
    globals_sql = run(COMPOSE + ['exec', '-T', 'db', 'pg_dumpall', '-U', 'postgres', '--globals-only'],
                      timeout=300).stdout
    (bundle / 'globals.sql').write_text(globals_sql)
    env = dict(l.split('=', 1) for l in ENV.read_text().splitlines() if '=' in l)
    files = {'stack.env': ENV, 'compose.yml': BASE / 'compose.yml', 'gateway.conf': BASE / 'shared/gateway.conf',
             'nginx-site.conf': pathlib.Path('/etc/nginx/sites-enabled/biomie.magmoveiscorporativos.com.br'),
             'nginx-conf.d-biomie-v2.conf': pathlib.Path('/etc/nginx/conf.d/biomie-v2.conf'),
             'nginx-legacy-site.conf': BASE / 'ops/nginx/legacy-site.conf',
             'RELEASE.json': pathlib.Path(env.get('SOURCE_DIR', '/nonexistent')) / 'RELEASE.json'}
    for snippet in pathlib.Path('/etc/nginx/snippets').glob('biomie-v2-*.conf'):
        files['nginx-snippet-' + snippet.name] = snippet
    for name, source in files.items():
        if source.exists():
            shutil.copy2(source, bundle / name)
    manifest = {'format': 1, 'created_utc': dt.datetime.now(dt.timezone.utc).isoformat(),
                'release': env.get('RELEASE_ID'), 'commit': env.get('BIOMIE_GIT_COMMIT'),
                'files': {p.name: sha256(p) for p in sorted(bundle.iterdir())}}
    (bundle / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    tar_path = workdir / 'bundle.tar'
    with tarfile.open(tar_path, 'w') as tar:
        tar.add(bundle, arcname='bundle')
    return tar_path


def encrypt(tar_path: pathlib.Path, target: pathlib.Path):
    run(['gpg', '--batch', '--yes', '--quiet', '--pinentry-mode', 'loopback', '--passphrase-file', str(passphrase()),
         '--symmetric', '--cipher-algo', 'AES256', '--s2k-digest-algo', 'SHA512', '--s2k-mode', '3',
         '--s2k-count', '65011712', '--compress-algo', 'none', '-o', str(target), str(tar_path)], timeout=3600)


def decrypt(source: pathlib.Path, target: pathlib.Path):
    run(['gpg', '--batch', '--yes', '--quiet', '--pinentry-mode', 'loopback', '--passphrase-file', str(passphrase()),
         '-d', '-o', str(target), str(source)], timeout=3600)


def prune_local():
    keep = bundles()[-1:]
    cutoff = time.time() - RETENTION_DAYS * 86400
    removed = 0
    for path in bundles():
        if path not in keep and path.stat().st_mtime < cutoff:
            path.unlink()
            removed += 1
    return removed


def send_offsite(path: pathlib.Path):
    cfg = offsite_config()
    if not cfg:
        raise RuntimeError('offsite destination not configured')
    offsite_ssh(cfg, f"mkdir -p '{OFFSITE_DIR}' && chmod 700 '{OFFSITE_DIR}'")
    partial = f'{OFFSITE_DIR}/{path.name}.partial'
    run(['scp', *ssh_base(cfg), '-P', cfg['PORT'], '-q', str(path), f"{cfg['USER']}@{cfg['HOST']}:{partial}"],
        timeout=3600)
    remote = offsite_ssh(cfg, f"sha256sum '{partial}' | cut -d' ' -f1").stdout.strip()
    if remote != sha256(path):
        offsite_ssh(cfg, f"rm -f '{partial}'")
        raise RuntimeError('offsite sha256 mismatch')
    offsite_ssh(cfg, f"mv '{partial}' '{OFFSITE_DIR}/{path.name}' && "
                     f"find '{OFFSITE_DIR}' -maxdepth 1 -name 'biomie-v2-*.tar.gpg' -mtime +{RETENTION_DAYS} -delete")
    count = offsite_ssh(cfg, f"ls '{OFFSITE_DIR}' | grep -c '^biomie-v2-.*\\.tar\\.gpg$' || true").stdout.strip()
    return {'host': cfg['HOST'], 'dir': OFFSITE_DIR, 'copies': count, 'config': cfg['SOURCE']}


def cmd_run(offsite=True):
    STORE.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(STORE, 0o700)
    if shutil.disk_usage(STORE).free < 3 * 1024 ** 3:
        raise RuntimeError('less than 3 GiB free; backup not started')
    name = 'biomie-v2-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '.tar.gpg'
    with tempfile.TemporaryDirectory(dir=STORE, prefix='.work-') as work:
        workdir = pathlib.Path(work)
        tar_path = build_bundle(workdir)
        partial = STORE / ('.partial-' + name)
        encrypt(tar_path, partial)
        os.chmod(partial, 0o600)
        final = STORE / name
        os.replace(partial, final)
    digest = sha256(final)
    save_state(last_backup={'file': str(final), 'bytes': final.stat().st_size, 'sha256': digest,
                            'at': dt.datetime.now(dt.timezone.utc).isoformat()})
    log('backup_complete', file=final.name, bytes=final.stat().st_size, pruned=prune_local())
    if offsite:
        try:
            result = send_offsite(final)
            save_state(last_offsite={'file': final.name, 'sha256': digest, 'verified': True,
                                     'at': dt.datetime.now(dt.timezone.utc).isoformat(), **result})
            log('offsite_complete', **result)
        except Exception as error:
            save_state(last_offsite_error={'at': dt.datetime.now(dt.timezone.utc).isoformat(), 'error': str(error)})
            log('offsite_failed', error=str(error))
            raise SystemExit(10)


def cmd_restore_test(from_offsite=False):
    load = os.getloadavg()[0] / max(1, os.cpu_count() or 1)
    if load > 0.9:
        raise RuntimeError(f'host busy (load per cpu {load:.2f}); restore test postponed')
    with tempfile.TemporaryDirectory(dir=STORE, prefix='.restore-') as work:
        workdir = pathlib.Path(work)
        if from_offsite:
            cfg = offsite_config()
            latest = offsite_ssh(cfg, f"ls -1 '{OFFSITE_DIR}' | grep '^biomie-v2-.*\\.tar\\.gpg$' | sort | tail -1").stdout.strip()
            if not latest:
                raise RuntimeError('no offsite bundle')
            source = workdir / latest
            run(['scp', *ssh_base(cfg), '-P', cfg['PORT'], '-q', f"{cfg['USER']}@{cfg['HOST']}:{OFFSITE_DIR}/{latest}",
                 str(source)], timeout=3600)
        else:
            if not bundles():
                raise RuntimeError('no local bundle')
            source = bundles()[-1]
        tar_path = workdir / 'bundle.tar'
        decrypt(source, tar_path)
        with tarfile.open(tar_path) as tar:
            tar.extractall(workdir, filter='data')
        bundle = workdir / 'bundle'
        manifest = json.loads((bundle / 'manifest.json').read_text())
        for name, digest in manifest['files'].items():
            if sha256(bundle / name) != digest:
                raise RuntimeError(f'checksum mismatch: {name}')
        image = run(['docker', 'inspect', '--format', '{{.Config.Image}}', 'biomie-v2-db-1']).stdout.strip()
        name = 'biomie-v2-restore-test-' + uuid.uuid4().hex[:8]
        volume = name + '-data'
        try:
            run(['docker', 'volume', 'create', volume])
            run(['docker', 'run', '-d', '--name', name, '--network', 'none', '--memory', '512m', '--cpus', '0.5',
                 '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=restore_test',
                 '-v', volume + ':/var/lib/postgresql/data', image, '-c', 'shared_buffers=64MB'], timeout=120)
            # The official image first starts a temporary server for initdb and shuts it
            # down; only after "init process complete" is the final server up.
            for _ in range(90):
                logs = subprocess.run(['docker', 'logs', name], capture_output=True, text=True)
                ready = 'init process complete' in (logs.stdout + logs.stderr)
                if ready and subprocess.run(['docker', 'exec', name, 'pg_isready', '-U', 'postgres'],
                                            capture_output=True).returncode == 0:
                    break
                time.sleep(2)
            else:
                raise RuntimeError('temporary PostgreSQL did not become ready')
            roles = re.sub(r'^CREATE ROLE postgres;\s*$', '', (bundle / 'globals.sql').read_text(), flags=re.M)
            run(['docker', 'exec', '-i', name, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
                input=roles, timeout=300)
            with (bundle / 'database.dump').open('rb') as handle:
                p = subprocess.run(['docker', 'exec', '-i', name, 'pg_restore', '-U', 'postgres', '-d', 'restore_test',
                                    '--exit-on-error'], stdin=handle, capture_output=True, timeout=3600)
            if p.returncode:
                raise RuntimeError('pg_restore failed: ' + p.stderr.decode(errors='replace')[-500:])
            query = """select json_build_object(
              'companies',(select count(*) from public.companies where not is_demo),
              'invoices',(select count(*) from public.invoices i join public.companies c on c.id=i.company_id where not c.is_demo),
              'canonical_invoices',(select count(*) from public.canonical_invoices),
              'auth_users',(select count(*) from auth.users),
              'migrations',(select count(*) from private.vps_schema_migrations),
              'encrypted_credentials',(select count(*) from private.integration_credentials where app_secret like 'enc:v1:%'),
              'unvalidated_fk',(select count(*) from pg_constraint where contype='f' and not convalidated));"""
            checks = json.loads(run(['docker', 'exec', '-i', name, 'psql', '-X', '-U', 'postgres', '-d', 'restore_test',
                                     '-At', '-c', query]).stdout.strip())
            if checks['unvalidated_fk'] or not checks['migrations'] or not checks['auth_users']:
                raise RuntimeError('restored database failed checks: ' + json.dumps(checks))
            proof = {'at': dt.datetime.now(dt.timezone.utc).isoformat(), 'bundle': source.name,
                     'source': 'offsite' if from_offsite else 'local', 'isolation': 'network none, no ports',
                     'commit': manifest.get('commit'), 'checks': checks}
            save_state(last_restore_test=proof)
            log('restore_test_passed', **proof)
        finally:
            subprocess.run(['docker', 'rm', '-f', name], capture_output=True)
            subprocess.run(['docker', 'volume', 'rm', volume], capture_output=True)


def main(argv):
    if not argv:
        raise SystemExit(__doc__)
    if argv[0] == 'run':
        cmd_run(offsite='--no-offsite' not in argv)
    elif argv[0] == 'restore-test':
        cmd_restore_test(from_offsite='--offsite' in argv)
    elif argv[0] == 'status':
        print(json.dumps(state() | {'local_bundles': [p.name for p in bundles()]}, indent=2))
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except RuntimeError as error:
        log('failed', error=str(error))
        raise SystemExit(1)
