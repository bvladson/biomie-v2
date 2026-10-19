import json,pathlib,subprocess
base=pathlib.Path('/opt/biomie-v2')
d=json.loads((base/'shared/legacy-export.json').read_text())
for table in ['biomie_sales_targets_monthly','biomie_sales_target_levels','biomie_company_targets','biomie_user_seller_scope','biomie_user_visible_sellers']:
    rows=d.get(table,[])
    print(table, 'count',len(rows),'columns',list(rows[0]) if rows else [])
    safe={k:v for k,v in (rows[0] if rows else {}).items() if any(x in k for x in ['year','month','compet','amount','valor','target','level'])}
    print('NUMERIC_TARGET_EXAMPLE',safe)
cmd=['docker','compose','--env-file',str(base/'shared/stack.env'),'-f',str(base/'compose.yml')]
q="SELECT pg_get_function_identity_arguments(oid) FROM pg_proc WHERE proname='compute_omie_matches';"
p=subprocess.run(cmd+['exec','-T','db','psql','-U','postgres','-d','biomie_v2','-Atc',q],capture_output=True,text=True,check=True,timeout=20)
print('RPC_SIGNATURE',p.stdout)
