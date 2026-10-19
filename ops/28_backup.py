"""Install the BIOMIE v2 backup runner and cron, then prove it end to end.

    python ops/remote.py ops/28_backup.py install <release>   # runner + cron + first backup + offsite restore test
    python ops/remote.py ops/28_backup.py run                 # backup now
    python ops/remote.py ops/28_backup.py restore-test        # restore the newest OFFSITE bundle in isolation
    python ops/remote.py ops/28_backup.py status
"""
import json
import pathlib
import shutil
import subprocess
import sys

BIN = pathlib.Path('/opt/biomie-v2/bin')
RUNNER = BIN / 'backup.py'
CRON = pathlib.Path('/etc/cron.d/biomie-v2-backup')
CRON_TEXT = """# BIOMIE v2 - encrypted PostgreSQL/config backups (installed by ops/28_backup.py)
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAILTO=""
# Daily 03:20 (after the legacy MariaDB backup at 03:00); encrypted before leaving the process.
20 3 * * * root /usr/bin/flock -n /run/lock/biomie-v2-backup.lock /usr/bin/python3 /opt/biomie-v2/bin/backup.py run >> /var/log/biomie-v2-backup.log 2>&1
# Weekly real restore of the newest OFFSITE copy into an isolated container.
50 3 * * 0 root /usr/bin/flock -n /run/lock/biomie-v2-backup.lock /usr/bin/python3 /opt/biomie-v2/bin/backup.py restore-test --offsite >> /var/log/biomie-v2-backup.log 2>&1
"""


def runner(*args, timeout=3600):
    p = subprocess.run(['python3', str(RUNNER), *args], capture_output=True, text=True, timeout=timeout)
    return {'exit': p.returncode, 'log': [json.loads(l) for l in p.stdout.splitlines() if l.startswith('{')],
            'error': p.stderr[-800:] if p.returncode else None}


command = sys.argv[1]
if command == 'install':
    release = pathlib.Path('/opt/biomie-v2/releases') / sys.argv[2]
    BIN.mkdir(mode=0o700, parents=True, exist_ok=True)
    shutil.copy2(release / 'deploy/vps/backup.py', RUNNER)
    RUNNER.chmod(0o700)
    CRON.write_text(CRON_TEXT)
    CRON.chmod(0o644)
    report = {'installed': str(RUNNER), 'cron': str(CRON), 'backup': runner('run'), 'restore_test': runner('restore-test', '--offsite')}
    report['status'] = json.loads(subprocess.run(['python3', str(RUNNER), 'status'], capture_output=True, text=True).stdout)
    print(json.dumps(report, indent=1))
elif command == 'run':
    print(json.dumps(runner('run'), indent=1))
elif command == 'restore-test':
    print(json.dumps(runner('restore-test', '--offsite'), indent=1))
elif command == 'status':
    print(subprocess.run(['python3', str(RUNNER), 'status'], capture_output=True, text=True).stdout)
else:
    raise SystemExit(__doc__)
