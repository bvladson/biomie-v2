import json,pathlib,subprocess,urllib.request
base=pathlib.Path('/opt/biomie-v2')
source=base/'releases/20261019-source'
env=dict(line.split('=',1) for line in (base/'shared/stack.env').read_text().splitlines() if '=' in line)
cmd=['docker','compose','--env-file',str(base/'shared/stack.env'),'-f',str(base/'compose.yml')]
def execute(sql):
    p=subprocess.run(cmd+['exec','-T','db','psql','-U','postgres','-d','biomie_v2','-v','ON_ERROR_STOP=1'],input=sql,capture_output=True,text=True,timeout=240)
    if p.returncode:
        print('SQL_STDOUT_TAIL',p.stdout[-1000:])
        raise RuntimeError('SQL_FAILED '+p.stderr[-3000:])
    return p.stdout
execute((source/'deploy/db/00_supabase_compat.sql').read_text())
render=subprocess.run(['python3',str(source/'scripts/render-vps-migrations.py')],capture_output=True,text=True,check=True)
execute(render.stdout)
execute("SET request.jwt.claims='{\"role\":\"service_role\"}'; SELECT public.set_app_base_url('"+env['APP_BASE_URL']+"'); INSERT INTO private.job_secrets(name,token) VALUES('scheduler','"+env['BIOMIE_JOB_TOKEN']+"') ON CONFLICT(name) DO UPDATE SET token=excluded.token; ALTER ROLE authenticated SET statement_timeout='30s'; ALTER ROLE service_role SET statement_timeout='120s'; NOTIFY pgrst,'reload schema';")
print('MIGRATIONS_APPLIED')
print(execute('SELECT name,applied_at FROM private.vps_schema_migrations ORDER BY name;')[-4000:])
print('SECURITY_TESTS',execute((source/'deploy/db/verify_security.sql').read_text())[-2000:])
if (source/'scripts/test-commercial-contract.sql').exists():
    print('COMMERCIAL_TESTS',execute((source/'scripts/test-commercial-contract.sql').read_text())[-2000:])
if (source/'scripts/test-omie-matching.sql').exists():
    print('MATCHING_TESTS',execute((source/'scripts/test-omie-matching.sql').read_text())[-2000:])
for filename in ['verify_legacy_access.sql','verify_order_scope.sql']:
    if (source/'deploy/db'/filename).exists():
        print(filename,execute((source/'deploy/db'/filename).read_text())[-2000:])
print('DATABASE',execute("SELECT COUNT(*) AS tables FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'; SELECT COUNT(*) AS companies FROM public.companies;"))
