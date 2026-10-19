import pathlib,json,subprocess,time
base=pathlib.Path('/opt/biomie-v2')
maps=json.loads((base/'shared/legacy-map.json').read_text())
cmd=['docker','compose','--env-file',str(base/'shared/stack.env'),'-f',str(base/'compose.yml')]
q="SET statement_timeout='30s'; SET request.jwt.claims='{\"role\":\"service_role\"}'; SELECT c.slug,e.entity,public.compute_omie_matches(c.id,e.entity) FROM public.companies c CROSS JOIN(VALUES('vendors'),('customers'),('products'))e(entity) WHERE c.slug in('ergooffice','expert','mag-filial');"
t=time.monotonic()
p=subprocess.run(cmd+['exec','-T','db','psql','-U','postgres','-d','biomie_v2','-v','ON_ERROR_STOP=1','-c',q],capture_output=True,text=True,timeout=120)
if p.returncode:raise RuntimeError(p.stderr[-1000:])
print('MATCHES_REPAIRED_SECONDS',round(time.monotonic()-t,2),p.stdout)
name='biomie-v2-dimensions-uni'
existing=subprocess.run(['docker','inspect','--format','{{.State.Status}}',name],capture_output=True,text=True)
if existing.returncode==0:
    print('EXISTING_DIMENSIONS_JOB',existing.stdout.strip())
else:
    p=subprocess.run(cmd+['run','-d','--no-deps','--name',name,'web','node','.output/bootstrap-sync.mjs','--phase=dimensions','--companies='+maps['companies']['3']],capture_output=True,text=True,check=True,timeout=30)
    print('UNI_DESIGN_DIMENSIONS_STARTED',p.stdout.strip()[-15:])
