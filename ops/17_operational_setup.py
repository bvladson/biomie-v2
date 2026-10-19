"""Prepare VPS operations; activation always requires explicit command-line flags.

Install this file at /opt/biomie-v2/ops/17_operational_setup.py before scheduling.
Default action only writes prepared files. Explicit backup actions use SSH only
when offsite has been enabled; this script never logs into the VPS to install itself.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import time
import uuid
from zoneinfo import ZoneInfo

LEGACY_BACKUP = pathlib.Path('/var/backups/biomie-v2-cutover-20261019_101406')
SITE_NAME = 'biomie.magmoveiscorporativos.com.br'
BACKUP_PATTERN = re.compile(r'^biomie-v2-\d{8}T\d{6}Z-[0-9a-f]{8}$')


class OffsiteFailure(RuntimeError):
    """A complete local backup exists, but external transfer was not proved."""


def stamp():
    return dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')


def report(event, **fields):
    print(json.dumps({'event': event, **fields}, ensure_ascii=False), flush=True)


def secure_write(path, content, mode=0o600):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp-' + uuid.uuid4().hex[:8])
    try:
        with temporary.open('x', encoding='utf-8', newline='\n') as handle:
            os.chmod(temporary, mode)
            handle.write(content)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def cron_documents(base):
    runner = str(base / 'ops/17_operational_setup.py')
    # Schedules use the host cron daemon timezone. The VPS uses UTC-3.
    prefix = 'SHELL=/bin/sh\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nMAILTO=""\n'
    backup = prefix + f'''# Biomie V2: daily database/config backup; retention 30 days.
# Host cron timezone; no assumption that CRON_TZ is supported by Debian cron.
20 3 * * * root /usr/bin/flock -n /run/lock/biomie-v2-cron-backup.lock /usr/bin/python3 {runner} --backup-now >> /var/log/biomie-v2-operations.log 2>&1
# Actual restore into a temporary network-isolated container, once per week.
20 4 * * 0 root /usr/bin/flock -n /run/lock/biomie-v2-cron-backup.lock /usr/bin/python3 {runner} --restore-smoke >> /var/log/biomie-v2-operations.log 2>&1
'''
    sync = prefix + f'''# Only activate after business/access/data acceptance. All three share one lock.
# The runner pauses/resumes the worker and skips while backfill/active leases exist.
*/30 * * * * root /usr/bin/flock -n /run/lock/biomie-v2-cron-sync.lock /usr/bin/python3 {runner} --sync-now >> /var/log/biomie-v2-operations.log 2>&1
40 6 * * * root /usr/bin/flock -n /run/lock/biomie-v2-cron-sync.lock /usr/bin/python3 {runner} --dimensions-now >> /var/log/biomie-v2-operations.log 2>&1
# Weekly replay of the current calendar year; deliberately explicit rather than a new source.
30 5 * * 0 root /usr/bin/flock -n /run/lock/biomie-v2-cron-sync.lock /usr/bin/python3 {runner} --replay-now >> /var/log/biomie-v2-operations.log 2>&1
'''
    override = '''services:
  worker:
    environment:
      BIOMIE_SNAPSHOT_TIME_ZONE: America/Sao_Paulo
      BIOMIE_SNAPSHOT_HOUR: "8"
'''
    guide = f'''Biomie V2 operational runbook

Default preparation creates files only. It does not install cron, start workers,
change Nginx, restore data, or enable synchronization.

Persistent runner: {runner}
Prepared cron: {base}/ops/prepared/biomie-v2-backup.cron and biomie-v2-sync.cron
Worker override: {base}/ops/worker-timezone.yml

Explicit actions (root on VPS):
  python3 {runner} --activate-backups
  python3 {runner} --activate-backups --enable-offsite
  python3 {runner} --backup-now
  python3 {runner} --restore-smoke
  python3 {runner} --start-worker
  python3 {runner} --activate-sync --accept-recurring-sync

Backups include a consistent pg_dump custom archive of biomie_v2, global roles
(including password hashes), stack.env, gateway/host Nginx config, cron, compose
and metadata. Everything local is root-only. --enable-offsite reuses the legacy
SSH destination/key in a SEPARATE biomie-v2-db directory, verifies SHA256, and
retains its own archives for 30 days. It requires an existing trusted host key.
No object immutability or extra encryption at rest is supplied. If offsite fails,
backup exits 10: the local bundle remains valid, but external protection failed.
Retention removes only successful timestamped bundles older than 30 days,
retaining at least one successful bundle. Failed partials require investigation.

Restore smoke uses a temporary Docker volume and PostgreSQL container, network
none, no published ports, limited CPU/memory. It restores roles, owners, ACLs,
schema and data, then verifies key relations and FK validity. Production DB is
never the restore target. A smoke test is not a timed full disaster-recovery drill.

Recurring sync invokes the existing private bootstrap CLI. Dimensions run daily,
transactional invoices/orders/receivables/settlements replay the last 62 days
every 30 minutes, and a weekly replay covers the current calendar year. These
queries are bounded by emission/payment dates, not a CDC stream; older changes
may need a manual replay. Review API budget and coverage before activation.
No job is marked READY just because this scheduler starts.

Worker only advances queued backfills and snapshots. Cron adds recurring source
refresh. A shared flock excludes cron/manual runner overlap; the runner pauses
worker during CLI execution and also honors application database entity leases.
Manual syncs from the UI still depend on existing database leases/rate limiting.
Do not run the old Omie sync producer concurrently with V2 synchronization.

Rollback (routing/services only; never overwrites either database):
  python3 {runner} --rollback-legacy --accept-routing-rollback
Original backup: {LEGACY_BACKUP}
Rollback disables only V2 sync cron, stops worker/web/gateway, takes a final V2
backup, restores the original Nginx/PHP routing and legacy release symlink, tests
Nginx, reloads it, then restores the original /etc/cron.d/biomie. Current config
is archived before edits. Daily PostgreSQL backups remain enabled if installed.
V2 user/config changes are preserved in PostgreSQL, not merged back into MariaDB.
The legacy MariaDB dump is NOT restored automatically. Python service state is
captured by the first --prepare BEFORE cutover; rollback restarts/re-enables
biomie-python.service only if its recorded state requires it. If setup happens
after it was stopped, supply --legacy-python-was-active and, if appropriate,
--legacy-python-was-enabled when preparing. TLS private keys and Docker image
contents are not included; retain the release/image separately.
If any post-stop step
fails, the runner attempts to restore previous routing/cron and restart the
previously running V2 services, then returns failure. Inspect before retrying.
'''
    return {'biomie-v2-backup.cron': backup, 'biomie-v2-sync.cron': sync,
            'worker-timezone.yml': override, 'RUNBOOK.txt': guide}


class Operations:
    def __init__(self, base):
        self.base = base.resolve()
        if self.base != pathlib.Path('/opt/biomie-v2'):
            raise RuntimeError('Only /opt/biomie-v2 is supported for VPS mutations')
        self.ops = self.base / 'ops'
        self.env_path = self.base / 'shared/stack.env'
        self.compose_path = self.base / 'compose.yml'
        self.env = {}
        for line in self.env_path.read_text(encoding='utf-8').splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                key, value = line.split('=', 1)
                self.env[key] = value
        self.cmd = ['docker', 'compose', '--env-file', str(self.env_path), '-f', str(self.compose_path)]
        self.backup_root = pathlib.Path('/var/backups/biomie-v2')

    def run(self, args, *, text=True, input=None, stdin=None, timeout=120, check=True, stdout=subprocess.PIPE):
        proc = subprocess.run(args, input=input, stdin=stdin, stdout=stdout, stderr=subprocess.PIPE,
                              text=text, timeout=timeout)
        if check and proc.returncode:
            # Do not expose raw command output, SQL, environment or dump contents.
            raise RuntimeError('Operational subprocess failed; inspect private VPS logs (exit %s)' % proc.returncode)
        return proc

    def sql(self, query):
        return self.run(self.cmd + ['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres',
                                   '-d', 'biomie_v2', '-v', 'ON_ERROR_STOP=1', '-At'],
                        input=query, timeout=120).stdout.strip()

    @contextlib.contextmanager
    def lock(self, name):
        import fcntl
        path = pathlib.Path('/run/lock') / ('biomie-v2-' + name + '.lock')
        with path.open('a') as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError('Another operational %s job is running' % name)
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    def prepare(self):
        prepared = self.ops / 'prepared'
        prepared.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(prepared, 0o700)
        for name, content in cron_documents(self.base).items():
            destination = self.ops / name if name == 'worker-timezone.yml' else prepared / name
            secure_write(destination, content)
        state_path = self.ops / 'legacy-python-before-cutover.json'
        if not state_path.exists():
            active = self.run(['systemctl', 'is-active', 'biomie-python.service'], check=False).stdout.strip() == 'active'
            enabled = self.run(['systemctl', 'is-enabled', 'biomie-python.service'], check=False).stdout.strip() == 'enabled'
            secure_write(state_path, json.dumps({'recorded_utc': stamp(), 'active': active, 'enabled': enabled}))
        offsite_path = self.ops / 'offsite.json'
        if not offsite_path.exists():
            secure_write(offsite_path, json.dumps(self.discover_offsite(), indent=2))
        report('prepared', active_cron_changed=False, services_changed=False,
               files=str(prepared), worker_override=str(self.ops / 'worker-timezone.yml'))

    def discover_offsite(self):
        legacy = pathlib.Path('/var/www/biomie/live/cron/hostinger/db_backup.sh')
        result = {'enabled': False, 'configured': False, 'retention_days': 30}
        if not legacy.is_file():
            return result
        source = legacy.read_text(encoding='utf-8')
        values = {}
        for name in ['HOST', 'PORT', 'USER', 'KEY', 'DIR']:
            match = re.search(r'^OFFSITE_' + name + r'="\$\{BIOMIE_OFFSITE_' + name + r':-([^}]*)\}"', source, re.M)
            if match:
                values[name] = match.group(1)
        # Capture explicit cron overrides without executing any shell/configuration.
        cron = pathlib.Path('/etc/cron.d/biomie')
        if cron.exists():
            for line in cron.read_text().splitlines():
                if line.lstrip().startswith('#'):
                    continue
                for name in list(values):
                    match = re.search(r'\bBIOMIE_OFFSITE_' + name + r'=([A-Za-z0-9_./-]+)', line)
                    if match:
                        values[name] = match.group(1)
        if len(values) != 5:
            return result
        if not re.fullmatch(r'[A-Za-z0-9.-]+', values['HOST']) or not re.fullmatch(r'[A-Za-z0-9_.-]+', values['USER']):
            raise RuntimeError('Legacy offsite endpoint requires manual validation')
        port = int(values['PORT'])
        path = pathlib.PurePosixPath(values['DIR'])
        if not 1 <= port <= 65535 or '..' in path.parts or not re.fullmatch(r'/?[A-Za-z0-9_./-]+', values['DIR']):
            raise RuntimeError('Legacy offsite path/port is invalid')
        key = pathlib.Path(values['KEY'])
        if not key.is_absolute():
            raise RuntimeError('Offsite SSH key must use an absolute path')
        result.update({'configured': key.is_file(), 'host': values['HOST'], 'port': port,
                       'user': values['USER'], 'key': str(key),
                       'directory': str(path.parent / 'biomie-v2-db')})
        return result

    def enable_offsite(self):
        self.prepare()
        config = self.discover_offsite()
        if not config.get('configured'):
            raise RuntimeError('Legacy offsite configuration/key is unavailable; offsite was not activated')
        config['enabled'] = True
        secure_write(self.ops / 'offsite.json', json.dumps(config, indent=2))
        report('offsite_enabled', connection_tested=False, isolated_v2_directory=True)

    def send_offsite(self, bundle):
        config_path = self.ops / 'offsite.json'
        if not config_path.exists():
            return
        config = json.loads(config_path.read_text())
        if not config.get('enabled'):
            return
        archive = self.backup_root / ('.offsite-' + uuid.uuid4().hex + '.tar.gz')
        name = bundle.name + '.tar.gz'
        directory = config['directory']
        destination = directory + '/' + name
        partial = destination + '.partial'
        ssh_options = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'StrictHostKeyChecking=yes',
                       '-i', config['key']]
        ssh = ['ssh'] + ssh_options + ['-p', str(config['port']), config['user'] + '@' + config['host']]
        try:
            with tarfile.open(archive, 'w:gz', compresslevel=1) as handle:
                archive.chmod(0o600)
                handle.add(bundle, arcname=bundle.name, recursive=True)
            with archive.open('rb') as handle:
                expected = hashlib.file_digest(handle, 'sha256').hexdigest()
            self.run(ssh + ['umask 077 && mkdir -p -- ' + shlex.quote(directory) + ' && chmod 700 -- ' + shlex.quote(directory)])
            self.run(['scp'] + ssh_options + ['-P', str(config['port']), '-q', str(archive),
                     config['user'] + '@' + config['host'] + ':' + partial], timeout=1800)
            received = self.run(ssh + ['sha256sum -- ' + shlex.quote(partial)], timeout=180).stdout.split()[0]
            if received != expected:
                self.run(ssh + ['rm -f -- ' + shlex.quote(partial)], check=False)
                raise OffsiteFailure('Local backup complete, but offsite hash verification failed')
            command = 'mv -- ' + shlex.quote(partial) + ' ' + shlex.quote(destination)
            command += ' && find ' + shlex.quote(directory) + ' -maxdepth 1 -type f -name ' + shlex.quote('biomie-v2-*.tar.gz')
            command += ' -mtime +30 -delete'
            self.run(ssh + [command], timeout=180)
            secure_write(self.ops / 'last-offsite.json', json.dumps({'completed_utc': stamp(), 'bundle': bundle.name,
                         'archive_sha256': expected, 'verified': True, 'retention_days': 30}))
            report('offsite_complete', bundle=bundle.name, sha256_verified=True)
        except OffsiteFailure:
            raise
        except Exception:
            raise OffsiteFailure('Local backup complete, but offsite copy/verification failed') from None
        finally:
            if archive.exists():
                archive.unlink()

    def activate_cron(self, kind):
        runner = self.ops / '17_operational_setup.py'
        if not runner.is_file() or runner.is_symlink():
            raise RuntimeError('Install the persistent runner at /opt/biomie-v2/ops/17_operational_setup.py first')
        runner.chmod(0o700)
        self.prepare()
        source = self.ops / 'prepared' / ('biomie-v2-' + kind + '.cron')
        target = pathlib.Path('/etc/cron.d') / ('biomie-v2-' + kind)
        secure_write(target, source.read_text(encoding='utf-8'), 0o644)
        report('cron_activated', kind=kind, host_timezone=time.tzname[0])

    def backup(self):
        with self.lock('backup'):
            self.backup_root.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.backup_root.chmod(0o700)
            if shutil.disk_usage(self.backup_root).free < 2 * 1024**3:
                raise RuntimeError('Less than 2 GiB free; PostgreSQL backup was not started')
            name = 'biomie-v2-' + stamp() + '-' + uuid.uuid4().hex[:8]
            partial = self.backup_root / ('.partial-' + name)
            partial.mkdir(mode=0o700)
            try:
                with (partial / 'database.dump').open('xb') as handle:
                    self.run(self.cmd + ['exec', '-T', 'db', 'pg_dump', '-U', 'postgres',
                                       '-d', 'biomie_v2', '--format=custom', '--compress=6'],
                             text=False, stdout=handle, timeout=1800)
                globals_sql = self.run(self.cmd + ['exec', '-T', 'db', 'pg_dumpall', '-U', 'postgres', '--globals-only'], timeout=180).stdout
                secure_write(partial / 'globals.sql', globals_sql)
                configs = {'stack.env': self.env_path, 'compose.yml': self.compose_path,
                           'gateway.conf': pathlib.Path(self.env.get('GATEWAY_CONFIG', str(self.base / 'shared/gateway.conf')))}
                for filename, source in [('host-nginx-site.conf', pathlib.Path('/etc/nginx/sites-enabled') / SITE_NAME),
                                         ('host-nginx.conf', pathlib.Path('/etc/nginx/nginx.conf')),
                                         ('host-nginx-security.conf', pathlib.Path('/etc/nginx/snippets/biomie-security-headers.conf')),
                                         ('legacy-biomie.cron', pathlib.Path('/etc/cron.d/biomie')),
                                         ('v2-backup.cron', pathlib.Path('/etc/cron.d/biomie-v2-backup')),
                                         ('v2-sync.cron', pathlib.Path('/etc/cron.d/biomie-v2-sync')),
                                         ('legacy-python-before-cutover.json', self.ops / 'legacy-python-before-cutover.json'),
                                         ('offsite.json', self.ops / 'offsite.json')]:
                    if source.exists():
                        configs[filename] = source
                if (self.ops / 'worker-timezone.yml').exists():
                    configs['worker-timezone.yml'] = self.ops / 'worker-timezone.yml'
                for filename, source in configs.items():
                    shutil.copy2(source, partial / filename)
                    (partial / filename).chmod(0o600)
                # A successful list verifies archive structure; restore smoke checks data itself.
                with (partial / 'database.dump').open('rb') as handle:
                    self.run(self.cmd + ['exec', '-T', 'db', 'pg_restore', '--list'],
                             stdin=handle, text=False, timeout=180)
                for file in partial.iterdir():
                    file.chmod(0o600)
                checksums = {}
                for file in partial.iterdir():
                    with file.open('rb') as handle:
                        checksums[file.name] = hashlib.file_digest(handle, 'sha256').hexdigest()
                manifest = {'format': 1, 'created_utc': stamp(), 'database': 'biomie_v2',
                            'release_id': self.env.get('RELEASE_ID'), 'source_dir': self.env.get('SOURCE_DIR'),
                            'retention_days': 30, 'checksums': checksums,
                            'includes_private_auth_config': True, 'offsite_proof': str(self.ops / 'last-offsite.json')}
                secure_write(partial / 'manifest.json', json.dumps(manifest, indent=2))
                final = self.backup_root / name
                os.rename(partial, final)
                secure_write(self.ops / 'last-backup.json', json.dumps({'path': str(final), 'completed_utc': stamp()}))
                self.prune()
                report('backup_complete', bundle=str(final), bytes=(final / 'database.dump').stat().st_size)
                self.send_offsite(final)
                return final
            except OffsiteFailure:
                raise
            except Exception:
                # Leave root-only partials as failure evidence; never mark them successful.
                report('backup_failed', partial=str(partial))
                raise

    def bundles(self):
        if not self.backup_root.exists():
            return []
        return sorted((p for p in self.backup_root.iterdir()
                       if p.is_dir() and not p.is_symlink() and BACKUP_PATTERN.fullmatch(p.name)
                       and (p / 'manifest.json').is_file()), key=lambda p: p.name)

    def prune(self):
        bundles = self.bundles()
        cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=30)
        for bundle in bundles[:-1]:
            if dt.datetime.fromtimestamp(bundle.stat().st_mtime, dt.timezone.utc) < cutoff:
                if bundle.resolve().parent != self.backup_root.resolve():
                    raise RuntimeError('Backup retention escaped its configured directory')
                shutil.rmtree(bundle)

    def restore_smoke(self):
        with self.lock('backup'):
            bundles = self.bundles()
            if not bundles:
                raise RuntimeError('No completed PostgreSQL backup is available')
            bundle = bundles[-1]
            database_size = int(self.sql('SELECT pg_database_size(current_database());'))
            if shutil.disk_usage(self.backup_root).free < max(2 * 1024**3, database_size * 2):
                raise RuntimeError('Insufficient free disk for a separate restore smoke database')
            manifest = json.loads((bundle / 'manifest.json').read_text())
            for filename, expected in manifest['checksums'].items():
                file = bundle / filename
                if file.resolve().parent != bundle.resolve():
                    raise RuntimeError('Backup manifest escaped its bundle directory')
                with file.open('rb') as handle:
                    digest = hashlib.file_digest(handle, 'sha256').hexdigest()
                if digest != expected:
                    raise RuntimeError('Backup checksum verification failed')
            name = 'biomie-v2-restore-smoke-' + uuid.uuid4().hex[:10]
            volume = name + '-data'
            label = 'biomie-v2.restore-smoke=' + name
            image = self.run(self.cmd + ['images', '-q', 'db']).stdout.strip()
            if not image:
                raise RuntimeError('The running PostgreSQL image is unavailable')
            created_volume = False
            created_container = False
            try:
                self.run(['docker', 'volume', 'create', '--label', label, volume])
                created_volume = True
                created_container = True  # Also clean a container left by a failed docker run.
                self.run(['docker', 'run', '-d', '--name', name, '--label', label, '--network', 'none',
                          '--memory', '512m', '--cpus', '0.75', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
                          '-e', 'POSTGRES_DB=biomie_v2_restore_smoke', '-v', volume + ':/var/lib/postgresql/data',
                          image, '-c', 'shared_buffers=64MB', '-c', 'max_connections=15'], timeout=120)
                for _ in range(60):
                    probe = self.run(['docker', 'exec', name, 'pg_isready', '-U', 'postgres'], check=False)
                    if probe.returncode == 0:
                        break
                    time.sleep(1)
                else:
                    raise RuntimeError('Isolated restore PostgreSQL did not become ready')
                roles = (bundle / 'globals.sql').read_text(encoding='utf-8')
                roles = re.sub(r'^CREATE ROLE postgres;\s*$', '-- postgres already exists', roles, flags=re.M)
                self.run(['docker', 'exec', '-i', name, 'psql', '-X', '-U', 'postgres', '-d', 'postgres',
                          '-v', 'ON_ERROR_STOP=1'], input=roles, timeout=180)
                with (bundle / 'database.dump').open('rb') as handle:
                    self.run(['docker', 'exec', '-i', name, 'pg_restore', '-U', 'postgres',
                              '-d', 'biomie_v2_restore_smoke', '--clean', '--if-exists', '--exit-on-error'],
                             stdin=handle, text=False, timeout=1800)
                query = """SELECT jsonb_build_object('companies',(SELECT count(*) FROM public.companies),
                  'invoices',(SELECT count(*) FROM public.invoices),'invoice_items',(SELECT count(*) FROM public.invoice_items),
                  'auth_users',(SELECT count(*) FROM auth.users),'rls_tables',(SELECT count(*) FROM pg_class WHERE relrowsecurity),
                  'unvalidated_fk',(SELECT count(*) FROM pg_constraint WHERE contype='f' AND NOT convalidated));"""
                result = self.run(['docker', 'exec', '-i', name, 'psql', '-X', '-U', 'postgres',
                                   '-d', 'biomie_v2_restore_smoke', '-v', 'ON_ERROR_STOP=1', '-At'], input=query).stdout.strip()
                checks = json.loads(result)
                if checks['unvalidated_fk'] != 0:
                    raise RuntimeError('Restored database contains unvalidated foreign keys')
                proof = {'tested_utc': stamp(), 'bundle': str(bundle), 'isolation': 'temporary container/network none/no ports',
                         'schema_data_restore': 'passed', 'checks': checks}
                secure_write(self.ops / 'last-restore-smoke.json', json.dumps(proof, indent=2))
                report('restore_smoke_passed', bundle=str(bundle), checks=checks)
            finally:
                if created_container:
                    self.run(['docker', 'rm', '-f', name], check=False)
                if created_volume:
                    self.run(['docker', 'volume', 'rm', volume], check=False)

    def running_services(self):
        proc = self.run(self.cmd + ['ps', '--status', 'running', '--services'])
        return set(proc.stdout.split())

    def start_worker(self):
        self.prepare()
        self.run(self.cmd + ['-f', str(self.ops / 'worker-timezone.yml'), 'up', '-d', '--no-build', 'worker'], timeout=180)
        report('worker_started', timezone='America/Sao_Paulo', snapshot_hour=8)

    def sync(self, phase):
        with self.lock('sync'):
            # Historical queue owns its data until it is complete; do not compete with it.
            pending = int(self.sql("SELECT count(*) FROM public.integration_backfill_jobs WHERE status IN ('PENDING','RUNNING');"))
            if pending:
                report('sync_skipped', reason='backfill_pending', jobs=pending)
                return
            was_running = 'worker' in self.running_services()
            if was_running:
                self.run(self.cmd + ['stop', 'worker'], timeout=120)
            try:
                leases = int(self.sql("SELECT count(*) FROM private.omie_worker_leases WHERE expires_at>now() AND lease_key LIKE 'omie:%';"))
                if leases:
                    report('sync_skipped', reason='application_entity_lease_active', leases=leases)
                    return
                today = dt.datetime.now(ZoneInfo('America/Sao_Paulo')).date()
                args = self.cmd + ['exec', '-T', 'web', 'timeout', '--signal=TERM', '--kill-after=30s',
                                   '7200', 'node', '.output/bootstrap-sync.mjs']
                if phase == 'dimensions':
                    args += ['--phase=dimensions']
                else:
                    start = dt.date(today.year, 1, 1) if phase == 'replay' else today - dt.timedelta(days=62)
                    args += ['--phase=transactions', '--from=' + start.isoformat(), '--to=' + today.isoformat(),
                             '--entities=invoices,orders,receivables,settlements']
                # Raw CLI output is private and may include upstream diagnostic data.
                log = self.ops / ('recurring-' + phase + '-' + stamp() + '.log')
                with log.open('x') as handle:
                    log.chmod(0o600)
                    proc = subprocess.run(args, stdout=handle, stderr=subprocess.STDOUT, text=True, timeout=7350)
                if proc.returncode:
                    raise RuntimeError('Recurring sync failed; inspect the private operational log')
                secure_write(self.ops / ('last-sync-' + phase + '.json'), json.dumps({'completed_utc': stamp(), 'phase': phase}))
                report('sync_completed', phase=phase, log=str(log))
            finally:
                if was_running:
                    self.start_worker()

    def rollback_legacy(self):
        with self.lock('sync'):
            backup = LEGACY_BACKUP.resolve()
            if backup.parent != pathlib.Path('/var/backups') or not backup.is_dir():
                raise RuntimeError('The named legacy cutover backup is missing')
            saved_site = backup / SITE_NAME
            saved_cron = backup / 'biomie'
            release = pathlib.Path((backup / 'legacy-release.txt').read_text().strip()).resolve()
            if not release.is_relative_to('/var/www/biomie/releases') or not release.is_dir():
                raise RuntimeError('The legacy release path is invalid or unavailable')
            if not saved_site.is_file() or not saved_cron.is_file():
                raise RuntimeError('Original Nginx/cron files are missing')
            site = (pathlib.Path('/etc/nginx/sites-enabled') / SITE_NAME).resolve()
            if not site.is_relative_to('/etc/nginx'):
                raise RuntimeError('Unexpected Nginx site target')
            cron = pathlib.Path('/etc/cron.d/biomie')
            sync_cron = pathlib.Path('/etc/cron.d/biomie-v2-sync')
            live = pathlib.Path('/var/www/biomie/live')
            if not live.is_symlink():
                raise RuntimeError('Legacy live path must be a symlink')
            before = self.ops / ('before-rollback-' + stamp())
            before.mkdir(mode=0o700)
            header_snippet = pathlib.Path('/etc/nginx/snippets/biomie-security-headers.conf')
            for filename, file in [('site.conf', site), ('legacy.cron', cron), ('v2-sync.cron', sync_cron),
                                   ('headers.conf', header_snippet)]:
                if file.exists():
                    shutil.copy2(file, before / filename)
                    (before / filename).chmod(0o600)
            original_link = os.readlink(live)
            stopped = sorted(self.running_services() & {'worker', 'web', 'gateway'})
            python_active_now = self.run(['systemctl', 'is-active', 'biomie-python.service'], check=False).stdout.strip() == 'active'
            python_enabled_now = self.run(['systemctl', 'is-enabled', 'biomie-python.service'], check=False).stdout.strip() == 'enabled'
            try:
                if sync_cron.exists():
                    sync_cron.unlink()
                if stopped:
                    self.run(self.cmd + ['stop'] + stopped, timeout=180)
                try:
                    self.backup()
                except OffsiteFailure:
                    # The local final-state dump exists; external failure must not prevent routing recovery.
                    report('rollback_offsite_warning', local_final_backup_valid=True)
                replacement = live.with_name('live.rollback-' + uuid.uuid4().hex[:8])
                replacement.symlink_to(release)
                os.replace(replacement, live)
                secure_write(site, saved_site.read_text(), 0o644)
                snippet = backup / 'biomie-security-headers.conf'
                if snippet.is_file():
                    secure_write('/etc/nginx/snippets/biomie-security-headers.conf', snippet.read_text(), 0o644)
                self.run(['systemctl', 'start', 'php8.3-fpm'], timeout=120)
                python_state_path = self.ops / 'legacy-python-before-cutover.json'
                python_state = json.loads(python_state_path.read_text()) if python_state_path.exists() else {}
                if python_state.get('enabled'):
                    self.run(['systemctl', 'enable', 'biomie-python.service'])
                if python_state.get('active'):
                    self.run(['systemctl', 'start', 'biomie-python.service'], timeout=120)
                self.run(['nginx', '-t'])
                self.run(['systemctl', 'reload', 'nginx'])
                secure_write(cron, saved_cron.read_text(), 0o644)
                report('legacy_rollback_complete', legacy_release=str(release), database_restored=False,
                       stopped_services=stopped, configuration_snapshot=str(before))
            except Exception:
                secure_write(site, (before / 'site.conf').read_text(), 0o644)
                if (before / 'legacy.cron').exists():
                    secure_write(cron, (before / 'legacy.cron').read_text(), 0o644)
                elif cron.exists():
                    cron.unlink()
                if (before / 'v2-sync.cron').exists():
                    secure_write(sync_cron, (before / 'v2-sync.cron').read_text(), 0o644)
                if (before / 'headers.conf').exists():
                    secure_write(header_snippet, (before / 'headers.conf').read_text(), 0o644)
                replacement = live.with_name('live.recover-' + uuid.uuid4().hex[:8])
                replacement.symlink_to(original_link)
                os.replace(replacement, live)
                self.run(['nginx', '-t'], check=False)
                self.run(['systemctl', 'reload', 'nginx'], check=False)
                if stopped:
                    self.run(self.cmd + ['start'] + stopped, timeout=180, check=False)
                if not python_active_now:
                    self.run(['systemctl', 'stop', 'biomie-python.service'], check=False)
                if not python_enabled_now:
                    self.run(['systemctl', 'disable', 'biomie-python.service'], check=False)
                raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=pathlib.Path, default=pathlib.Path('/opt/biomie-v2'))
    actions = parser.add_mutually_exclusive_group()
    for action in ['prepare', 'activate-backups', 'backup-now', 'restore-smoke', 'activate-sync',
                   'start-worker', 'sync-now', 'dimensions-now', 'replay-now', 'rollback-legacy']:
        actions.add_argument('--' + action, action='store_true')
    parser.add_argument('--accept-recurring-sync', action='store_true')
    parser.add_argument('--accept-routing-rollback', action='store_true')
    parser.add_argument('--enable-offsite', action='store_true', help='Reuse the existing legacy SSH backup destination in a separate V2 directory')
    parser.add_argument('--legacy-python-was-active', action='store_true', help='Explicit pre-cutover state, if preparation occurs after it was stopped')
    parser.add_argument('--legacy-python-was-enabled', action='store_true')
    parser.add_argument('--render-dir', type=pathlib.Path, help='Local preview only; no VPS commands or activation')
    args = parser.parse_args()
    if args.render_dir:
        args.render_dir.mkdir(parents=True, exist_ok=True)
        for name, content in cron_documents(pathlib.Path('/opt/biomie-v2')).items():
            secure_write(args.render_dir / name, content)
        report('local_preview_written', directory=str(args.render_dir))
        return
    if os.name != 'posix' or os.geteuid() != 0:
        raise RuntimeError('VPS actions must run as root on Linux; --render-dir works locally')
    if args.activate_sync and not args.accept_recurring_sync:
        raise RuntimeError('Recurring writes require --accept-recurring-sync after acceptance')
    if args.rollback_legacy and not args.accept_routing_rollback:
        raise RuntimeError('Routing rollback requires --accept-routing-rollback')
    op = Operations(args.base)
    if args.enable_offsite:
        if not (args.activate_backups or args.prepare):
            raise RuntimeError('--enable-offsite must accompany --activate-backups or --prepare')
        op.enable_offsite()
    if args.legacy_python_was_active or args.legacy_python_was_enabled:
        op.prepare()
        state_path = op.ops / 'legacy-python-before-cutover.json'
        state = json.loads(state_path.read_text())
        state['active'] = state['active'] or args.legacy_python_was_active
        state['enabled'] = state['enabled'] or args.legacy_python_was_enabled
        state['explicit_operator_state'] = True
        secure_write(state_path, json.dumps(state))
    if args.activate_backups:
        op.activate_cron('backup')
    elif args.backup_now:
        op.backup()
    elif args.restore_smoke:
        op.restore_smoke()
    elif args.activate_sync:
        op.activate_cron('sync')
    elif args.start_worker:
        op.start_worker()
    elif args.sync_now:
        op.sync('transactions')
    elif args.dimensions_now:
        op.sync('dimensions')
    elif args.replay_now:
        op.sync('replay')
    elif args.rollback_legacy:
        op.rollback_legacy()
    else:
        op.prepare()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Messages are intentionally generic; never echo subprocess output or configuration.
        report('operation_failed', error_type=type(error).__name__, message=str(error) if isinstance(error, RuntimeError) else 'Inspect private VPS state')
        raise SystemExit(10 if isinstance(error, OffsiteFailure) else 1)
