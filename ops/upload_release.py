"""Upload an exact git commit of source/ to the VPS.

    python ops/upload_release.py [commit-ish]     (default: HEAD)

Uses `git archive <commit>:source`, never the working tree, so the release on
the VPS (and the image built from it) is byte-for-byte the committed source.
Destination: /opt/biomie-v2/releases/<sha12>/ with RELEASE.json.
"""
import json
import pathlib
import shlex
import subprocess
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent
SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes',
       '-i', str(pathlib.Path.home() / '.ssh/id_ed25519_vps'), 'root@203.0.113.10']


def git(*args: str) -> str:
    return subprocess.run(['git', '-C', str(BASE), *args], capture_output=True, text=True,
                          check=True).stdout.strip()


ref = sys.argv[1] if len(sys.argv) > 1 else 'HEAD'
commit = git('rev-parse', '--verify', ref + '^{commit}')
short = commit[:12]
dirty = git('status', '--porcelain', '--', 'source')
if dirty and ref == 'HEAD':
    print('WARNING: source/ has uncommitted changes; they are NOT part of this release.')
archive = subprocess.run(['git', '-C', str(BASE), 'archive', '--format=tar.gz', f'{commit}:source'],
                         capture_output=True, check=True).stdout
meta = json.dumps({'commit': commit, 'short': short,
                   'subject': git('log', '-1', '--format=%s', commit),
                   'committed_at': git('log', '-1', '--format=%cI', commit)})
remote = f'''
import io, json, os, pathlib, shutil, sys, tarfile, datetime
meta = json.loads({meta!r})
root = pathlib.Path('/opt/biomie-v2/releases')
final = root / meta['short']
if final.exists():
    existing = json.loads((final / 'RELEASE.json').read_text())
    if existing['commit'] != meta['commit']:
        raise SystemExit('release dir exists with another commit')
    print(json.dumps({{'release': str(final), 'commit': meta['commit'], 'uploaded': False}}))
    raise SystemExit(0)
partial = root / (meta['short'] + '.partial')
if partial.exists():
    shutil.rmtree(partial)
partial.mkdir(parents=True)
with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()), mode='r:gz') as tf:
    tf.extractall(partial, filter='data')
meta['uploaded_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
(partial / 'RELEASE.json').write_text(json.dumps(meta, indent=2))
os.rename(partial, final)
print(json.dumps({{'release': str(final), 'commit': meta['commit'], 'uploaded': True}}))
'''
result = subprocess.run(SSH + ['python3 -c ' + shlex.quote(remote)], input=archive,
                        capture_output=True, timeout=600)
sys.stdout.write(result.stdout.decode())
sys.stderr.write(result.stderr.decode())
raise SystemExit(result.returncode)
