import json,pathlib,subprocess,shutil
base=pathlib.Path('/opt/biomie-v2')
env=dict(line.split('=',1) for line in (base/'shared/stack.env').read_text().splitlines() if '=' in line)
source=pathlib.Path(env['SOURCE_DIR'])
shutil.copy2(source/'deploy/vps/compose.yml',base/'compose.yml')
cmd=['docker','compose','--env-file',str(base/'shared/stack.env'),'-f',str(base/'compose.yml')]
log=base/'ops/build-web.log'
with log.open('w') as f:p=subprocess.run(cmd+['build','web'],stdout=f,stderr=subprocess.STDOUT,text=True,timeout=1200)
if p.returncode:
    output=log.read_text()[-4000:]
    for value in env.values():
        if len(value)>12:output=output.replace(value,'[REDACTED]')
    raise RuntimeError(output)
subprocess.run(cmd+['up','-d','web'],check=True,capture_output=True,text=True,timeout=120)
print(json.dumps({'image':'biomie-v2-web:'+env['RELEASE_ID'],'build':'passed','web':'starting on private port 3130','production_routing':'unchanged until acceptance'}))
