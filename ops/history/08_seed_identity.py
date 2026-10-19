import json,os,pathlib,subprocess,urllib.request,urllib.error,uuid,secrets
base=pathlib.Path('/opt/biomie-v2')
source=base/'releases/20261019-source'
legacy=json.loads((base/'shared/legacy-export.json').read_text())
env=dict(line.split('=',1) for line in (base/'shared/stack.env').read_text().splitlines() if '=' in line)
cmd=['docker','compose','--env-file',str(base/'shared/stack.env'),'-f',str(base/'compose.yml')]
def sql(q):
    p=subprocess.run(cmd+['exec','-T','db','psql','-U','postgres','-d','biomie_v2','-v','ON_ERROR_STOP=1','-At'],input=q,capture_output=True,text=True,timeout=90)
    if p.returncode:raise RuntimeError('SQL failed: '+p.stderr.splitlines()[0][:250])
    return p.stdout.strip()
def lit(value):
    if value is None:return 'NULL'
    if isinstance(value,bool):return 'true' if value else 'false'
    return "'"+str(value).replace("'","''")+"'"
def ident(kind,key):return str(uuid.uuid5(uuid.NAMESPACE_URL,'biomie-v2:legacy:'+kind+':'+str(key)))
def auth(method,path,body=None):
    request=urllib.request.Request('http://127.0.0.1:3140/auth/v1'+path,data=json.dumps(body).encode() if body is not None else None,method=method,headers={'Authorization':'Bearer '+env['SERVICE_ROLE_KEY'],'apikey':env['ANON_KEY'],'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(request,timeout=30) as response:return json.loads(response.read() or '{}')
    except urllib.error.HTTPError as exc:
        data=json.loads(exc.read())
        raise RuntimeError('Auth API '+str(exc.code)+': '+str(data.get('code') or data.get('error_code') or 'failure'))
company_map={str(c['id']):ident('company',c['id']) for c in legacy['companies']}
for c in legacy['companies']:
    key=str(c['id']);cid=company_map[key]
    q="INSERT INTO public.companies(id,name,slug,is_demo,data_source,revenue_basis) VALUES("+','.join([lit(cid),lit(c['nome_fantasia'] or c['razao_social']),lit(c['slug'].lower().replace('_','-')),'false',"'OMIE_SHADOW'","'commercial_base'"])+") ON CONFLICT(id) DO UPDATE SET name=excluded.name;"
    for channel in ['varejo','licitacao','outros']:
        q+="INSERT INTO public.channels(id,company_id,name) VALUES("+','.join(map(lit,[ident('channel',key+':'+channel),cid,channel]))+") ON CONFLICT(id) DO NOTHING;"
    sql(q)
for c in legacy['credentials']:
    cid=company_map[str(c['company_id'])]
    sql("INSERT INTO private.integration_credentials(company_id,provider,app_key,app_secret) VALUES("+','.join(map(lit,[cid,'omie',c['app_key'],c['app_secret']]))+") ON CONFLICT(company_id,provider) DO UPDATE SET app_key=excluded.app_key,app_secret=excluded.app_secret,updated_at=now(); INSERT INTO public.company_integrations(company_id,provider,status,app_key_hint) VALUES("+','.join(map(lit,[cid,'omie','CONNECTED','••••'+c['app_key'][-4:]]))+") ON CONFLICT(company_id,provider) DO NOTHING;")
existing=auth('GET','/admin/users?page=1&per_page=1000').get('users',[])
by_email={u['email'].lower():u for u in existing}
user_map={}
role_counts={}
passwords_preserved=0
for user in legacy['biomie_users']:
    if not user['is_active']:continue
    key=str(user['id']);email=(user.get('email') or 'legacy-'+key+'@users.biomie.internal').lower().strip()
    record=by_email.get(email)
    if not record:
        record=auth('POST','/admin/users',{'id':ident('user',key),'email':email,'password_hash':user['password_hash'],'email_confirm':True,'user_metadata':{'full_name':user['full_name'],'legacy_username':user['username']}})
    uid=record['id'];user_map[key]=uid
    preserved=sql("SELECT encrypted_password="+lit(user['password_hash'])+" FROM auth.users WHERE id="+lit(uid)+";")
    if preserved!='t':raise RuntimeError('Imported password hash was not preserved; cutover stopped')
    passwords_preserved+=1
    accesses=[x for x in legacy['biomie_user_companies'] if str(x['user_id'])==key]
    role='SUPER_ADMIN' if user['role']=='admin' and len({str(x['company_id']) for x in accesses})==len(company_map) else {'admin':'ADMIN','manager':'GESTOR','viewer':'VIEWER','analyst':'ANALISTA'}.get(user['role'],'VIEWER')
    role_counts[role]=role_counts.get(role,0)+1
    default=next((company_map[str(a['company_id'])] for a in accesses if a['is_default']),next((company_map[str(a['company_id'])] for a in accesses),None))
    q="INSERT INTO public.profiles(id,email,full_name,default_company_id) VALUES("+','.join(map(lit,[uid,email,user['full_name'],default]))+") ON CONFLICT(id) DO UPDATE SET default_company_id=excluded.default_company_id;"
    q+="INSERT INTO public.user_roles(user_id,role) VALUES("+lit(uid)+','+lit(role)+") ON CONFLICT(user_id,role) DO NOTHING;"
    aliases={user['username'].strip().lower(),email}
    for alias in aliases:q+="INSERT INTO private.legacy_user_aliases(alias,user_id,is_active) VALUES("+lit(alias)+','+lit(uid)+",true) ON CONFLICT(alias) DO UPDATE SET user_id=excluded.user_id,is_active=true;"
    for access in accesses:q+="INSERT INTO public.user_company_access(user_id,company_id) VALUES("+lit(uid)+','+lit(company_map[str(access['company_id'])])+") ON CONFLICT DO NOTHING;"
    q+="INSERT INTO public.audit_log(actor_id,action,entity,entity_id,payload) VALUES(NULL,'legacy.identity_import','profiles',"+lit(uid)+",'{\"password_reset\":false}'::jsonb);"
    sql(q)
# REMOVED 19/10/2026: this block created a SUPER_ADMIN smoke account and wrote its
# password to shared/smoke-account.json. Smoke tests now use ops/29_smoke.py
# (short-lived accounts, password only in memory, deleted at the end).
maps={'companies':company_map,'users':user_map}
path=base/'shared/legacy-map.json';path.write_text(json.dumps(maps));os.chmod(path,0o600)
print(json.dumps({'companies':len(company_map),'credentials':len(legacy['credentials']),'users':len(user_map),'password_hashes_preserved':passwords_preserved,'role_counts':role_counts,'legacy_import':'identities and own configurations only; no passwords disclosed'}))
