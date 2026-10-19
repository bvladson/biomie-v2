import pathlib,subprocess,json,time
base=pathlib.Path('/opt/biomie-v2')
cmd=['docker','compose','--env-file',str(base/'shared/stack.env'),'-f',str(base/'compose.yml')]
for args in [['ps'],['top','web']]:
    p=subprocess.run(cmd+args,capture_output=True,text=True,timeout=20)
    print(p.stdout[-3000:])
q="SET statement_timeout='90s'; SET ROLE service_role; SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',false); SELECT public.compute_omie_matches(id,'customers') FROM public.companies WHERE slug='ergooffice';"
p=subprocess.run(cmd+['exec','-T','db','psql','-U','postgres','-d','biomie_v2','-v','ON_ERROR_STOP=1','-c',q],capture_output=True,text=True,timeout=180)
print('MATCH RPC',p.returncode,p.stdout[-1000:],p.stderr[-2200:])
print('NGINX',pathlib.Path('/etc/nginx/sites-enabled/biomie.magmoveiscorporativos.com.br').read_text())
print('HEADERS',pathlib.Path('/etc/nginx/snippets/biomie-security-headers.conf').read_text())
