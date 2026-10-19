"""Securely delete the import artifacts left on the VPS, only after a safe backup exists.

    python ops/remote.py ops/33_cleanup_sensitive.py [--dry-run]

Refuses unless the newest encrypted backup AND its verified offsite copy are less
than 6 hours old. Deletes with `shred -u` the files whose imports are done; keeps
the legacy cutover backup and legacy-map.json (rollback evidence). Also lists
other candidates (test contexts, smoke files, exports) for review, without
touching them. Prints names, sizes and fingerprints only.
"""
import datetime as dt
import hashlib
import json
import pathlib
import subprocess
import sys

BASE = pathlib.Path('/opt/biomie-v2')
SHARED = BASE / 'shared'
DONE_IMPORTS = ['legacy-export.json', 'legacy-canonical.json', 'omie-validation.json', 'omie-validation-fixed.json']
KEEP = ['legacy-map.json']
DRY = '--dry-run' in sys.argv

state = json.loads(subprocess.run(['python3', str(BASE / 'bin/backup.py'), 'status'], capture_output=True,
                                  text=True, timeout=120).stdout or '{}')


def age_hours(entry):
    try:
        return (dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(entry['at'])).total_seconds() / 3600
    except (KeyError, TypeError, ValueError):
        return None


backup_age, offsite_age = age_hours(state.get('last_backup')), age_hours(state.get('last_offsite'))
same_bundle = (state.get('last_offsite') or {}).get('sha256') == (state.get('last_backup') or {}).get('sha256')
if backup_age is None or offsite_age is None or backup_age > 6 or offsite_age > 6 or not same_bundle \
        or not (state.get('last_offsite') or {}).get('verified'):
    raise SystemExit(f'Backup seguro ausente ou antigo (local {backup_age}, externo {offsite_age}, mesmo pacote {same_bundle}).')

report = {'backup': {'file': pathlib.Path(state['last_backup']['file']).name, 'age_h': round(backup_age, 2),
                     'offsite_verified': True}, 'deleted': [], 'kept': [], 'review': []}
for name in DONE_IMPORTS:
    path = SHARED / name
    if not path.exists():
        continue
    entry = {'file': str(path), 'bytes': path.stat().st_size,
             'sha256_16': hashlib.sha256(path.read_bytes()).hexdigest()[:16]}
    if not DRY:
        subprocess.run(['shred', '-u', '-z', str(path)], check=True)
        entry['gone'] = not path.exists()
    report['deleted' if not DRY else 'would_delete'] = report.get('deleted' if not DRY else 'would_delete', []) + [entry]
for name in KEEP:
    path = SHARED / name
    if path.exists():
        report['kept'].append({'file': str(path), 'bytes': path.stat().st_size})
patterns = ['*test-context*', '*smoke-account*', '*legacy-export*', '*legacy-canonical*', '*omie-validation*',
            '*.sql', '*.dump.tmp', '*credentials*.json']
for root in (BASE, pathlib.Path('/root'), pathlib.Path('/tmp')):
    for pattern in patterns:
        for path in root.glob('**/' + pattern) if root == BASE else root.glob(pattern):
            if 'releases' in path.parts or 'node_modules' in path.parts or not path.is_file():
                continue
            if path.name in DONE_IMPORTS and path.parent == SHARED:
                continue
            report['review'].append({'file': str(path), 'bytes': path.stat().st_size})
print(json.dumps(report, indent=1))
