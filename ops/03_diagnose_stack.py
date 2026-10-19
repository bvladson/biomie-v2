import pathlib,subprocess,json
base=pathlib.Path('/opt/biomie-v2')
env=dict(line.split('=',1) for line in (base/'shared/stack.env').read_text().splitlines() if '=' in line)
for name in ['biomie-v2-auth-1','biomie-v2-gateway-1']:
    p=subprocess.run(['docker','logs','--tail','12',name],capture_output=True,text=True,timeout=10)
    output=p.stdout+p.stderr
    for value in env.values():
        if len(value)>12:output=output.replace(value,'[REDACTED]')
    print(name,output)
