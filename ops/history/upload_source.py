import io,pathlib,subprocess,tarfile
BASE=pathlib.Path(__file__).resolve().parent.parent
source=BASE/'source'
archive=BASE/'biomie-v2-source.tar.gz'
excluded={'node_modules','.git','.output','.wrangler','.tanstack','.nitro'}
with tarfile.open(archive,'w:gz') as tf:
    for path in source.rglob('*'):
        rel=path.relative_to(source)
        if any(part in excluded for part in rel.parts) or path.name.startswith('.env') or path.suffix in {'.log','.tsbuildinfo'}:continue
        if path.is_file():tf.add(path,arcname=str(rel).replace('\\','/'),recursive=False)
SSH=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','-o','StrictHostKeyChecking=yes','-i',str(pathlib.Path.home()/'.ssh/hostinger_srv1851839_ed25519'),'root@179.197.238.57']
script="import pathlib,sys,tarfile; p=pathlib.Path('/opt/biomie-v2/releases/20261019-source'); p.mkdir(parents=True,exist_ok=True); tf=tarfile.open(fileobj=sys.stdin.buffer,mode='r|gz'); tf.extractall(p,filter='data'); print('Source uploaded to',p)"
import shlex
with archive.open('rb') as f:
    p=subprocess.run(SSH+['python3 -c '+shlex.quote(script)],stdin=f,capture_output=True,text=True,timeout=180)
print(p.stdout,p.stderr)
raise SystemExit(p.returncode)
