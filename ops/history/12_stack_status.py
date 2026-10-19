import json,pathlib,subprocess,urllib.request
base=pathlib.Path('/opt/biomie-v2')
env=dict(line.split('=',1) for line in (base/'shared/stack.env').read_text().splitlines() if '=' in line)
cmd=['docker','compose','--env-file',str(base/'shared/stack.env'),'-f',str(base/'compose.yml')]
log=base/'ops/build-web.log'
if log.exists():
    tail=log.read_text()[-1800:]
    for val in env.values():
        if len(val)>12:tail=tail.replace(val,'[REDACTED]')
    print('BUILD_TAIL',tail)
p=subprocess.run(cmd+['ps','--format','{{.Service}} {{.State}} {{.Health}}'],capture_output=True,text=True)
print('SERVICES',p.stdout)
for port,path in [(3130,'/auth'),(3140,'/auth/v1/health')]:
    try:
        with urllib.request.urlopen('http://127.0.0.1:'+str(port)+path,timeout=10) as response:print('HTTP',port,response.status)
    except Exception as exc:print('HTTP',port,type(exc).__name__)
