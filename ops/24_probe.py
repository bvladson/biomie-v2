"""Safe Omie probe per company (one tiny page per method + previous-year total).

    python ops/remote.py ops/24_probe.py <from> <to> <company-slug> [<company-slug> ...]

Runs inside the web container with the shared rate limiter; prints structure only.
"""
import json
import pathlib
import subprocess
import sys

BASE = pathlib.Path('/opt/biomie-v2')
COMPOSE = ['docker', 'compose', '--env-file', str(BASE / 'shared/stack.env'), '-f', str(BASE / 'compose.yml')]
start, end, companies = sys.argv[1], sys.argv[2], sys.argv[3:]
out = {}
for slug in companies:
    p = subprocess.run(COMPOSE + ['exec', '-T', 'web', 'node', '.output/omie-probe.mjs', slug, start, end],
                       capture_output=True, text=True, timeout=900)
    try:
        out[slug] = json.loads(p.stdout)
    except json.JSONDecodeError:
        out[slug] = {'ok': False, 'error': (p.stderr or p.stdout)[-600:]}
print(json.dumps(out, indent=1, ensure_ascii=False))
