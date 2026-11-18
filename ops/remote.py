"""Run a local ops script on the VPS: python ops/remote.py ops/<script>.py [args...]

The script is streamed to `python3 -` over SSH. Output is saved under ops/logs/
with a timestamp. Ops scripts never print secret values.
"""
import datetime
import pathlib
import shlex
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

BASE = pathlib.Path(__file__).resolve().parent.parent
SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes',
       '-o', 'ServerAliveInterval=30', '-i', str(pathlib.Path.home() / '.ssh/id_ed25519_vps'),
       'root@203.0.113.10']
script = pathlib.Path(sys.argv[1])
args = ' '.join(shlex.quote(a) for a in sys.argv[2:])
result = subprocess.run(SSH + ['python3 - ' + args], input=script.read_text(encoding='utf-8'),
                        capture_output=True, text=True, encoding='utf-8', timeout=7200)
logs = BASE / 'ops' / 'logs'
logs.mkdir(exist_ok=True)
stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
(logs / f'{stamp}-{script.stem}.log').write_text(result.stdout + '\n' + result.stderr, encoding='utf-8')
print(result.stdout[-20000:])
if result.stderr:
    print(result.stderr[-4000:], file=sys.stderr)
raise SystemExit(result.returncode)
