import base64,hashlib,hmac,json,os,pathlib,secrets,shutil,subprocess,time
BASE=pathlib.Path('/opt/biomie-v2')
SOURCE=BASE/'releases/20261019-source'
SHARED=BASE/'shared'
SHARED.mkdir(mode=0o700,exist_ok=True)
envfile=SHARED/'stack.env'
def jwt(secret,role):
    def enc(data):return base64.urlsafe_b64encode(json.dumps(data,separators=(',',':')).encode()).decode().rstrip('=')
    now=int(time.time())
    data=enc({'alg':'HS256','typ':'JWT'})+'.'+enc({'role':role,'iss':'biomie-v2','iat':now,'exp':now+5*365*24*3600})
    return data+'.'+base64.urlsafe_b64encode(hmac.new(secret.encode(),data.encode(),hashlib.sha256).digest()).decode().rstrip('=')
if envfile.exists():
    env=dict(line.split('=',1) for line in envfile.read_text().splitlines() if '=' in line)
else:
    secret=secrets.token_hex(32)
    env={'POSTGRES_PASSWORD':secrets.token_hex(32),'AUTH_DB_PASSWORD':secrets.token_hex(32),'REST_DB_PASSWORD':secrets.token_hex(32),'JWT_SECRET':secret,'ANON_KEY':jwt(secret,'anon'),'SERVICE_ROLE_KEY':jwt(secret,'service_role'),'BIOMIE_JOB_TOKEN':secrets.token_hex(32)}
env.update({'APP_BASE_URL':'https://biomie.magmoveiscorporativos.com.br','PUBLIC_SUPABASE_URL':'https://biomie.magmoveiscorporativos.com.br/supabase','RELEASE_ID':'20261019','SOURCE_DIR':str(SOURCE),'GATEWAY_CONFIG':str(SHARED/'gateway.conf')})
envfile.write_text('\n'.join(k+'='+v for k,v in env.items())+'\n')
os.chmod(envfile,0o600)
gateway='''map_hash_bucket_size 512;
map $http_apikey $api_key_valid {
 default 0;
 "ANON_KEY" 1;
 "SERVICE_KEY" 1;
}
map $http_authorization $jwt_header { default $http_authorization; "" "Bearer ANON_KEY"; }
server {
 listen 8000;
 server_tokens off;
 client_max_body_size 8m;
 location = /health { access_log off; return 200 'ok'; }
 location /auth/v1/ {
  proxy_pass http://auth:9999/;
  proxy_set_header Host $http_host;
  proxy_set_header X-Forwarded-Proto https;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Real-IP $http_x_real_ip;
  proxy_read_timeout 60s;
 }
 location /rest/v1/ {
  if ($api_key_valid = 0) { return 401; }
  proxy_pass http://rest:3000/;
  proxy_set_header Authorization $jwt_header;
  proxy_set_header Host $http_host;
  proxy_read_timeout 300s;
 }
 location / { return 404; }
}
'''.replace('ANON_KEY',env['ANON_KEY']).replace('SERVICE_KEY',env['SERVICE_ROLE_KEY'])
(SHARED/'gateway.conf').write_text(gateway)
os.chmod(SHARED/'gateway.conf',0o600)
compose=BASE/'compose.yml'
shutil.copy2(SOURCE/'deploy/vps/compose.yml',compose)
cmd=['docker','compose','--env-file',str(envfile),'-f',str(compose)]
def run(args,input=None,timeout=900):
    p=subprocess.run(args,input=input,capture_output=True,text=True,timeout=timeout)
    if p.returncode:
        err=(p.stderr or p.stdout)[-2000:]
        for key in ['JWT_SECRET','POSTGRES_PASSWORD','AUTH_DB_PASSWORD','REST_DB_PASSWORD','SERVICE_ROLE_KEY','BIOMIE_JOB_TOKEN']:err=err.replace(env[key],'[REDACTED]')
        raise RuntimeError(err)
    return p
run(cmd+['up','-d','db'])
for attempt in range(60):
    if subprocess.run(cmd+['exec','-T','db','pg_isready','-U','postgres','-d','biomie_v2'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
    time.sleep(2)
else:raise RuntimeError('Postgres not ready')
bootstrap=(SOURCE/'deploy/db/00_supabase_compat.sql').read_text()
bootstrap+="\nALTER ROLE supabase_auth_admin PASSWORD '"+env['AUTH_DB_PASSWORD']+"';\nALTER ROLE authenticator PASSWORD '"+env['REST_DB_PASSWORD']+"';\n"
bootstrap+='\nALTER FUNCTION auth.uid() OWNER TO supabase_auth_admin; ALTER FUNCTION auth.role() OWNER TO supabase_auth_admin; ALTER FUNCTION auth.jwt() OWNER TO supabase_auth_admin;\n'
run(cmd+['exec','-T','db','psql','-U','postgres','-d','biomie_v2','-v','ON_ERROR_STOP=1'],input=bootstrap)
run(cmd+['up','-d','auth','rest','gateway'])
for attempt in range(60):
    p=run(cmd+['exec','-T','db','psql','-U','postgres','-d','biomie_v2','-Atc',"SELECT to_regclass('auth.users') IS NOT NULL"])
    if p.stdout.strip()=='t':break
    time.sleep(2)
else:
    logs=run(cmd+['logs','--tail','20','auth']).stdout
    raise RuntimeError('GoTrue schema not initialized: '+logs)
run(cmd+['exec','-T','db','psql','-U','postgres','-d','biomie_v2','-v','ON_ERROR_STOP=1'],input=(SOURCE/'deploy/db/00_supabase_compat.sql').read_text())
run(cmd+['restart','gateway'])
print(json.dumps({'postgres':'ready','auth_users':'ready','gateway':'127.0.0.1:3140','new_database':'biomie_v2','secrets':'generated locally on VPS; not exported'}))
print(run(cmd+['ps','--format','json']).stdout)
