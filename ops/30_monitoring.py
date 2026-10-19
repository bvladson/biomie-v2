"""Install the BIOMIE v2 health monitor (cron every 5 min) and log rotation.

    python ops/remote.py ops/30_monitoring.py install <release>
    python ops/remote.py ops/30_monitoring.py show
"""
import json
import pathlib
import shutil
import subprocess
import sys

BIN = pathlib.Path('/opt/biomie-v2/bin')
CRON = pathlib.Path('/etc/cron.d/biomie-v2-health')
ROTATE = pathlib.Path('/etc/logrotate.d/biomie-v2')
CRON_TEXT = """# BIOMIE v2 health monitor (installed by ops/30_monitoring.py)
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAILTO=""
*/5 * * * * root /usr/bin/flock -n /run/lock/biomie-v2-health.lock /usr/bin/python3 /opt/biomie-v2/bin/health.py >> /var/log/biomie-v2-health.log 2>&1
"""
ROTATE_TEXT = """/var/log/biomie-v2-health.log /var/log/biomie-v2-health.csv /var/log/biomie-v2-backup.log {
    weekly
    rotate 8
    compress
    missingok
    notifempty
    copytruncate
}
"""

if sys.argv[1] == 'install':
    release = pathlib.Path('/opt/biomie-v2/releases') / sys.argv[2]
    BIN.mkdir(mode=0o700, parents=True, exist_ok=True)
    shutil.copy2(release / 'deploy/vps/health.py', BIN / 'health.py')
    (BIN / 'health.py').chmod(0o700)
    CRON.write_text(CRON_TEXT)
    CRON.chmod(0o644)
    ROTATE.write_text(ROTATE_TEXT)
    ROTATE.chmod(0o644)
    subprocess.run(['python3', str(BIN / 'health.py')], check=True, timeout=120)
print(pathlib.Path('/opt/biomie-v2/ops/health.json').read_text())
