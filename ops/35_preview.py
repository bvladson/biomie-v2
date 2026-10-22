"""Private preview of a release next to production (visual checks; no public traffic).

    python ops/remote.py ops/35_preview.py up <release-short-sha>   # build + run on 127.0.0.1:3132
    python ops/remote.py ops/35_preview.py down                     # remove the preview container

Builds biomie-v2-web:<sha12> from /opt/biomie-v2/releases/<sha12> with the same compose
definition as production (env overrides only for this process; stack.env is untouched)
and runs it as a one-off container with the web service's environment and limits.
Production containers, nginx and the database schema are not changed. Use
`python ops/29_smoke.py --pre-cutover --upstream-port 3132` to look at it.
"""
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE = pathlib.Path('/opt/biomie-v2')
COMPOSE = ['docker', 'compose', '--env-file', str(BASE / 'shared/stack.env'), '-f', str(BASE / 'compose.yml')]
NAME = 'biomie-v2-web-preview'
PORT = 3132


def run(cmd, env=None, timeout=1800):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
    if p.returncode:
        raise SystemExit(' '.join(cmd[:6]) + ' failed: ' + (p.stderr or p.stdout)[-1500:])
    return p.stdout.strip()


command = sys.argv[1] if len(sys.argv) > 1 else ''
if command == 'up':
    short = sys.argv[2]
    release = BASE / 'releases' / short
    meta = json.loads((release / 'RELEASE.json').read_text())
    env = {**os.environ, 'RELEASE_ID': short, 'SOURCE_DIR': str(release), 'BIOMIE_GIT_COMMIT': meta['commit']}
    # The release's own compose definition (same project name), so the preview runs with the
    # environment the release will have in production (e.g. PUBLIC_SUPABASE_URL, 22/10/2026).
    COMPOSE = COMPOSE[:-1] + [str(release / 'deploy/vps/compose.yml')]
    started = time.time()
    run(COMPOSE + ['build', 'web'], env=env)
    revision = run(['docker', 'image', 'inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}',
                    f'biomie-v2-web:{short}'])
    subprocess.run(['docker', 'rm', '-f', NAME], capture_output=True)
    run(COMPOSE + ['run', '-d', '--rm', '--no-deps', '--name', NAME, '-p', f'127.0.0.1:{PORT}:3000', 'web'], env=env)
    status = None
    for _ in range(60):
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/auth', timeout=5) as r:
                status = r.status
                break
        except (urllib.error.URLError, ConnectionError):
            time.sleep(2)
    print(json.dumps({'preview': f'127.0.0.1:{PORT}', 'image': f'biomie-v2-web:{short}', 'revision': revision,
                      'expected_commit': meta['commit'], 'login_status': status,
                      'seconds': round(time.time() - started)}, indent=1))
elif command == 'down':
    removed = subprocess.run(['docker', 'rm', '-f', NAME], capture_output=True, text=True)
    print(json.dumps({'removed': removed.returncode == 0, 'detail': (removed.stdout or removed.stderr).strip()[:200]}))
else:
    raise SystemExit(__doc__)
