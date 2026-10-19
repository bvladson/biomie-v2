import json,pathlib,subprocess
base=pathlib.Path('/opt/biomie-v2')
cmd=['docker','compose','--env-file',str(base/'shared/stack.env'),'-f',str(base/'compose.yml')]
sql="SELECT co.slug,r.entity,r.status,r.pages_done,r.pages_total,r.received,r.failed,r.raw_complete,r.canonical_complete,r.gold_complete,r.message FROM public.integration_sync_runs r JOIN public.companies co ON co.id=r.company_id WHERE NOT co.is_demo ORDER BY r.started_at DESC LIMIT 12;"
p=subprocess.run(cmd+['exec','-T','db','psql','-U','postgres','-d','biomie_v2','-c',sql],capture_output=True,text=True,check=True,timeout=20)
print(p.stdout)
path=base/'ops/sync-dimensions.log'
if path.exists():print('PROGRESS',path.read_text()[-1600:])
