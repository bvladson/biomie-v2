import json,pathlib,subprocess
base=pathlib.Path('/opt/biomie-v2');d=json.loads((base/'shared/legacy-export.json').read_text())
print('UNIQUE_OMIE_APPLICATIONS',len({x['app_key'] for x in d['credentials']}),'configured',len(d['credentials']))
print('COMPANIES',json.dumps([{'id':x['id'],'slug':x['slug'],'active':x['ativo']} for x in d['companies']]))
facts=json.loads((base/'shared/legacy-canonical.json').read_text())
for c in d['companies']:
    print(c['slug'],{t:sum(str(x.get('company_id'))==str(c['id']) for x in rows) for t,rows in facts.items()})
