import pathlib,subprocess,json
base=pathlib.Path('/opt/biomie-v2')
env=dict(line.split('=',1) for line in (base/'shared/stack.env').read_text().splitlines() if '=' in line)
cmd=['docker','compose','--env-file',str(base/'shared/stack.env'),'-f',str(base/'compose.yml')]
log=base/'ops/sync-dimensions.log'
with log.open('w') as f:
    p=subprocess.run(cmd+['exec','-T','web','node','.output/bootstrap-sync.mjs','--phase=dimensions'],stdout=f,stderr=subprocess.STDOUT,text=True,timeout=2400)
tail=log.read_text()[-3000:]
legacy=json.loads((base/'shared/legacy-export.json').read_text())
for value in list(env.values())+[c[k] for c in legacy['credentials'] for k in ['app_key','app_secret']]:
    if len(str(value))>10:tail=tail.replace(str(value),'[REDACTED]')
print(tail)
raise SystemExit(p.returncode)
