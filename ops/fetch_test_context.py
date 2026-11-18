import json,pathlib,subprocess
root=pathlib.Path(__file__).resolve().parent.parent
ssh=['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-i',str(pathlib.Path.home()/'.ssh/id_ed25519_vps'),'root@203.0.113.10']
script="import json,pathlib; p=pathlib.Path('/opt/biomie-v2/shared'); e=dict(x.split('=',1) for x in (p/'stack.env').read_text().splitlines() if '=' in x); print(json.dumps({'anon':e['ANON_KEY'],'service':e['SERVICE_ROLE_KEY'],'smoke':json.loads((p/'smoke-account.json').read_text())}))"
import shlex
p=subprocess.run(ssh+['python3 -c '+shlex.quote(script)],capture_output=True,text=True,check=True,timeout=40)
data=json.loads(p.stdout)
target=root/'ops/.test-context.json';target.write_text(json.dumps(data),encoding='utf-8')
print('Temporary deployment test context saved privately; no credentials printed.')
